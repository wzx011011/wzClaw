import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  PermissionMode,
  PermissionRule,
  DenialRecord
} from './types'
import {
  PERMISSION_MODES,
  MAX_CONSECUTIVE_DENIALS,
  MAX_TOTAL_DENIALS
} from './types'
import { isReadOnlyBashCommand } from '../tools/bash-readonly'

// ============================================================
// PermissionManager — Advanced 4-mode permission system
// ============================================================

/**
 * Manages tool approval with 4 permission modes, session caching,
 * glob-based rules, denial tracking, and command prefix extraction.
 *
 * Modes:
 * - always-ask: Prompt for destructive tools (default)
 * - accept-edits: Auto-allow FileWrite/FileEdit; prompt for Bash
 * - plan: All tools require approval
 * - bypass: Skip all checks
 */
export class PermissionManager {
  private mode: PermissionMode = 'always-ask'
  private sessionApprovals: Map<string, Set<string>> = new Map()
  private alwaysAllowRules: Set<string> = new Set() // "toolName" or "toolName:prefix"
  private denialRecords: Map<string, DenialRecord> = new Map()

  // File tools that accept-edits mode auto-allows
  private static readonly FILE_TOOLS = new Set(['FileWrite', 'FileEdit'])

  // Tools that never require approval regardless of mode
  private static readonly READ_ONLY_TOOLS = new Set([
    'FileRead', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
    'SemanticSearch', 'GoToDefinition', 'FindReferences', 'SearchSymbols',
    'CreateTask', 'UpdateTask'
  ])

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: string): void {
    if (PERMISSION_MODES.includes(mode as PermissionMode)) {
      this.mode = mode as PermissionMode
    }
  }

  cycleMode(): PermissionMode {
    const idx = PERMISSION_MODES.indexOf(this.mode)
    this.mode = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
    return this.mode
  }

  /**
   * Check if a tool needs approval in the current mode.
   */
  needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean {
    // Bypass mode: never ask
    if (this.mode === 'bypass') return false

    // Plan mode: everything needs approval
    if (this.mode === 'plan') return true

    // Accept-edits mode: auto-allow file tools
    if (this.mode === 'accept-edits') {
      if (PermissionManager.FILE_TOOLS.has(toolName)) return false
      // Bash: read-only commands don't need approval
      if (toolName === 'Bash' && toolInput?.command) {
        if (isReadOnlyBashCommand(String(toolInput.command))) return false
      }
    }

    // Always-ask mode (or accept-edits for non-file tools):
    // Read-only tools never need approval
    if (PermissionManager.READ_ONLY_TOOLS.has(toolName)) return false

    // Check always-allow rules
    if (this.alwaysAllowRules.has(toolName)) return false
    if (toolName === 'Bash' && toolInput?.command) {
      const prefix = this.extractCommandPrefix(String(toolInput.command))
      if (prefix && this.alwaysAllowRules.has(`Bash:${prefix}`)) return false
    }

    // Destructive tools need approval
    return true
  }

  /**
   * Check if a tool has been approved in this conversation's session cache.
   */
  isApproved(conversationId: string, toolName: string): boolean {
    const approved = this.sessionApprovals.get(conversationId)
    if (!approved) return false
    return approved.has(toolName)
  }

  /**
   * Request approval from the user for a tool execution.
   * Returns { approved, alwaysAllow } — when alwaysAllow is true,
   * the rule is persisted for the session.
   */
  async requestApproval(
    conversationId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sender: Electron.WebContents
  ): Promise<boolean> {
    // Check mode first
    if (!this.needsApproval(toolName, toolInput)) {
      return true
    }

    // Check session cache
    if (this.isApproved(conversationId, toolName)) {
      return true
    }

    // Check denial threshold
    const denialKey = conversationId
    const denial = this.denialRecords.get(denialKey) ?? { consecutive: 0, total: 0 }
    if (denial.consecutive >= MAX_CONSECUTIVE_DENIALS || denial.total >= MAX_TOTAL_DENIALS) {
      // Force back to always-ask and notify
      this.mode = 'always-ask'
    }

    // Send permission request to renderer
    sender.send(IPC_CHANNELS['agent:permission_request'], {
      toolName,
      toolInput,
      reason: `Tool "${toolName}" requires approval.`
    })

    // Wait for renderer response
    return new Promise<boolean>((resolve) => {
      ipcMain.handleOnce(
        IPC_CHANNELS['agent:permission_response'],
        async (_event, data: { approved: boolean; sessionCache: boolean; alwaysAllow?: boolean }) => {
          if (data.approved) {
            // Reset consecutive denial count
            denial.consecutive = 0
            this.denialRecords.set(denialKey, denial)

            if (data.alwaysAllow) {
              // Add always-allow rule
              if (toolName === 'Bash' && toolInput.command) {
                const prefix = this.extractCommandPrefix(String(toolInput.command))
                if (prefix) {
                  this.alwaysAllowRules.add(`Bash:${prefix}`)
                }
              } else {
                this.alwaysAllowRules.add(toolName)
              }
            } else if (data.sessionCache) {
              let approved = this.sessionApprovals.get(conversationId)
              if (!approved) {
                approved = new Set()
                this.sessionApprovals.set(conversationId, approved)
              }
              approved.add(toolName)
            }
          } else {
            // Track denial
            denial.consecutive++
            denial.total++
            this.denialRecords.set(denialKey, denial)
          }
          resolve(data.approved)
          return data.approved
        }
      )
    })
  }

  /**
   * Extract a 2-word command prefix for Bash rule matching.
   * e.g., "git commit -m 'foo'" → "git commit"
   *       "npm install lodash" → "npm install"
   */
  private extractCommandPrefix(command: string): string {
    // Skip env vars at start
    const cleaned = command.replace(/^(\w+=\S+\s+)*/, '').trim()
    const words = cleaned.split(/\s+/)

    // Skip shell wrappers
    const shellPrefixes = new Set(['bash', 'sh', 'zsh', 'sudo', 'xargs', 'env'])
    let start = 0
    while (start < words.length && shellPrefixes.has(words[start])) {
      start++
    }

    const relevant = words.slice(start, start + 2)
    return relevant.join(' ')
  }

  /**
   * Clear all cached approvals for a conversation.
   */
  clearSession(conversationId: string): void {
    this.sessionApprovals.delete(conversationId)
    this.denialRecords.delete(conversationId)
  }

  isRendererConnected(): boolean {
    return true
  }
}
