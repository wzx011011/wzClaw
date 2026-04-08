import { ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
import { DEFAULT_SYSTEM_PROMPT } from '../shared/constants'
import type { LLMGateway } from './llm/gateway'
import type { AgentLoop } from './agent/agent-loop'
import type { PermissionManager } from './permission/permission-manager'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { AgentConfig } from './agent/types'
import type { SessionStore } from './persistence/session-store'
import type { ContextManager } from './context/context-manager'
import { SettingsManager } from './settings-manager'

// Persistent settings with encrypted API key storage (per D-66)
const settingsManager = new SettingsManager()

export function registerIpcHandlers(
  gateway: LLMGateway,
  agentLoop: AgentLoop,
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager,
  sessionStore: SessionStore,
  contextManager: ContextManager
): void {
  // Load persisted settings from disk
  settingsManager.load()

  // ============================================================
  // Agent: send message — triggers AgentLoop.run() and forwards
  // events to the renderer via webContents.send
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
    const result = IpcSchemas['agent:send_message'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const sender = event.sender

    // Ensure the LLM gateway has the current provider configured with up-to-date settings
    const config = settingsManager.getCurrentConfig()
    if (config.apiKey) {
      gateway.addProvider({
        provider: config.provider as 'openai' | 'anthropic',
        apiKey: config.apiKey,
        baseURL: config.baseURL
      })
    }

    // Build AgentConfig from current settings; use workspace root if available
    const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const agentConfig: AgentConfig = {
      model: config.model,
      provider: config.provider as 'openai' | 'anthropic',
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory,
      conversationId: result.data.conversationId,
    }

    // Cleanup on window close
    const onWindowClosed = (): void => {
      agentLoop.cancel()
      permissionManager.clearSession(agentConfig.conversationId)
    }
    sender.once('destroyed', onWindowClosed)

    // Run agent loop and forward events to renderer
    // Track tool call inputs by ID to extract file paths for agent edit notifications (per D-52)
    const toolCallInputs = new Map<string, Record<string, unknown>>()

    try {
      for await (const agentEvent of agentLoop.run(result.data.content, agentConfig, sender)) {
        switch (agentEvent.type) {
          case 'agent:text':
            sender.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content })
            break
          case 'agent:tool_call':
            // Store tool input so we can extract file path on tool_result (per D-52)
            toolCallInputs.set(agentEvent.toolCallId, agentEvent.input)
            sender.send(IPC_CHANNELS['stream:tool_use_start'], {
              id: agentEvent.toolCallId,
              name: agentEvent.toolName,
            })
            break
          case 'agent:tool_result': {
            sender.send(IPC_CHANNELS['stream:tool_use_end'], {
              id: agentEvent.toolCallId,
              parsedInput: {
                output: agentEvent.output,
                isError: agentEvent.isError,
                toolName: agentEvent.toolName,
              },
            })

            // Forward file changes from agent tool execution to renderer (per D-52)
            if (!agentEvent.isError && (agentEvent.toolName === 'FileWrite' || agentEvent.toolName === 'FileEdit')) {
              const toolInput = toolCallInputs.get(agentEvent.toolCallId)
              const filePath = toolInput?.path as string | undefined
              if (filePath) {
                const absolutePath = path.isAbsolute(filePath)
                      ? filePath
                      : path.resolve(agentConfig.workingDirectory, filePath)
                sender.send(IPC_CHANNELS['file:changed'], {
                  filePath: absolutePath,
                  changeType: 'modified'
                })
              }
            }

            // Clean up tracked input to avoid memory leak
            toolCallInputs.delete(agentEvent.toolCallId)
            break
          }
          case 'agent:permission_request':
            sender.send(IPC_CHANNELS['agent:permission_request'], {
              toolName: agentEvent.toolName,
              toolInput: agentEvent.input,
              reason: 'This tool can modify your files. Approve?',
            })
            break
          case 'agent:error':
            sender.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error })
            break
          case 'agent:compacted':
            sender.send(IPC_CHANNELS['session:compacted'], {
              beforeTokens: agentEvent.beforeTokens,
              afterTokens: agentEvent.afterTokens,
              auto: agentEvent.auto
            })
            break
          case 'agent:done':
            sender.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage })
            // Auto-save messages after agent turn completes (PERSIST-02)
            try {
              const allMessages = agentLoop.getMessages()
              for (const msg of allMessages) {
                sessionStore.appendMessage(agentConfig.conversationId, msg)
              }
            } catch (saveErr) {
              console.error('Failed to auto-save session:', saveErr)
            }
            break
        }
      }
    } catch (error) {
      sender.send(IPC_CHANNELS['stream:error'], {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      sender.removeListener('destroyed', onWindowClosed)
    }
  })

  // ============================================================
  // Agent: stop — cancels the running agent loop
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:stop'], () => {
    agentLoop.cancel()
  })

  // Note: agent:permission_response is handled dynamically by
  // PermissionManager via ipcMain.handleOnce when a permission
  // request is in flight. No static handler needed here.

  // ============================================================
  // Settings: get — returns settings from persistent storage
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['settings:get'], () => {
    return settingsManager.getSettings()
  })

  // ============================================================
  // Settings: update — persists settings with encrypted API keys
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['settings:update'], (_event, request) => {
    settingsManager.updateSettings(request)
  })

  // ============================================================
  // Workspace: open folder — shows native dialog, sets workspace
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:open_folder'], async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const rootPath = await workspaceManager.openFolderDialog(win)
    if (rootPath) {
      // Forward file change events to all windows
      workspaceManager.onFileChange((filePath, changeType) => {
        for (const bw of BrowserWindow.getAllWindows()) {
          bw.webContents.send(IPC_CHANNELS['file:changed'], { filePath, changeType })
        }
      })
      return { rootPath }
    }
    return null
  })

  // ============================================================
  // Workspace: get directory tree
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:get_tree'], async (_event, request) => {
    return workspaceManager.getDirectoryTree(request?.dirPath, request?.depth)
  })

  // ============================================================
  // Workspace: start watching
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:watch'], async () => {
    await workspaceManager.startWatching()
  })

  // ============================================================
  // Workspace: status
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:status'], () => {
    return {
      rootPath: workspaceManager.getWorkspaceRoot(),
      isWatching: workspaceManager.isWatching()
    }
  })

  // ============================================================
  // File: read
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read'], async (_event, request) => {
    return workspaceManager.readFile(request.filePath)
  })

  // ============================================================
  // File: read-content — reads file for @-mention injection with 100KB limit
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read-content'], async (_event, request) => {
    const result = IpcSchemas['file:read-content'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { filePath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      return { error: 'No workspace open', size: 0, limit: 102400 }
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    const { stat, readFile } = await import('fs/promises')
    const fileStat = await stat(absolutePath)
    const size = fileStat.size
    const limit = 102400 // 100KB

    if (size > limit) {
      return { error: 'File too large', size, limit }
    }

    const content = await readFile(absolutePath, 'utf-8')
    // Return relative path for display
    const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/')
    return { content, size, path: relativePath }
  })

  // ============================================================
  // File: save
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:save'], async (_event, request) => {
    await workspaceManager.saveFile(request.filePath, request.content)
  })

  // ============================================================
  // Session: list — returns all sessions for current project
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:list'], () => {
    return sessionStore.listSessions()
  })

  // ============================================================
  // Session: load — returns messages for a specific session
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load'], (_event, request) => {
    return sessionStore.loadSession(request.sessionId)
  })

  // ============================================================
  // Session: delete — removes a session file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:delete'], (_event, request) => {
    return { success: sessionStore.deleteSession(request.sessionId) }
  })

  // ============================================================
  // Session: rename — updates session title via meta line
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:rename'], (_event, request) => {
    return { success: sessionStore.renameSession(request.sessionId, request.title) }
  })

  // ============================================================
  // File: apply-hunk — write accepted diff hunks to disk
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:apply-hunk'], async (_event, request) => {
    try {
      const { filePath, modifiedContent } = request as { filePath: string; hunksToApply: string[]; modifiedContent: string }
      const { writeFile } = await import('fs/promises')
      await writeFile(filePath, modifiedContent, 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('Failed to apply hunk:', error)
      return { success: false }
    }
  })

  // ============================================================
  // Agent: compact context — manual /compact command
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:compact_context'], async () => {
    const messages = agentLoop.getMessages()
    const config = settingsManager.getCurrentConfig()
    if (messages.length === 0) return null

    const result = await contextManager.compact(
      messages,
      gateway,
      config.model,
      config.provider,
      config.systemPrompt
    )
    if (result.summary) {
      // Build compacted messages and replace in agent loop
      const summaryMsg = {
        role: 'user' as const,
        content: `[Context Summary]\n${result.summary}`,
        timestamp: Date.now()
      }
      const recentMessages = messages.slice(-result.keptRecentCount)
      agentLoop.replaceMessages([summaryMsg, ...recentMessages])
    }
    return { beforeTokens: result.beforeTokens, afterTokens: result.afterTokens }
  })
}
