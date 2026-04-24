import { ipcMain, BrowserWindow, shell } from 'electron'
import path from 'path'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
import { CostTracker } from './llm/cost-tracker'
import { getCommandsDir, getSkillsDir, getAppDataDir, getInsightsCacheDir, getInsightsReportDir } from './paths'
import { invalidateGitCache } from './git/git-context'

/**
 * Check whether a file path is within the workspace root boundary.
 * Uses normalized, case-insensitive comparison to prevent path traversal
 * on Windows (e.g., junction points, case variations, ".." segments).
 */
function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const normalized = path.resolve(filePath).toLowerCase()
  const root = path.resolve(workspaceRoot).toLowerCase()
  return normalized === root || normalized.startsWith(root + path.sep)
}
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_MODELS } from '../shared/constants'
import type { LLMGateway } from './llm/gateway'
import type { AgentLoop } from './agent/agent-loop'
import type { PermissionManager } from './permission/permission-manager'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { AgentConfig } from './agent/types'
import type { SessionStore } from './persistence/session-store'
import type { ContextManager } from './context/context-manager'
import type { TerminalManager } from './terminal/terminal-manager'
import type { StepManager } from './steps/step-manager'
import { SettingsManager } from './settings-manager'
import { handleSymbolResult } from './tools/symbol-nav'
import type { IndexingEngine } from './indexing/indexing-engine'
import { getGitStatusShort } from './git/git-context'
import type { MCPManager } from './mcp/mcp-manager'
import type { TaskStore } from './tasks/task-store'

export function registerIpcHandlers(
  gateway: LLMGateway,
  agentLoop: AgentLoop,
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager,
  getSessionStore: () => SessionStore,
  contextManager: ContextManager,
  terminalManager: TerminalManager,
  stepManager: StepManager,
  indexingEngine: IndexingEngine | null,
  settingsManager: SettingsManager,
  mcpManager: MCPManager,
  taskStore: TaskStore,
  onWorkspaceOpened?: (rootPath: string) => void,
  onDataChanged?: (event: string, data: unknown) => void
): void {
  // Mutable reference to IndexingEngine (updated when workspace opens)
  const indexingEngineRef = { current: indexingEngine }

  // Session-scoped cost tracker — resets on each new send (Phase 4.4)
  const costTracker = new CostTracker()

  // Track how many messages were already persisted so we only append new ones
  let persistedMessageCount = 0

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

    // Reset persisted message counter for new conversation turn
    persistedMessageCount = agentLoop.getMessages().length

    // Ensure the LLM gateway has adapters for the configured provider AND the model's provider.
    // GLM models span both anthropic (glm-5*) and openai (glm-4*) APIs, so both adapters
    // may be needed when the user switches between them.
    const config = settingsManager.getCurrentConfig()
    if (config.apiKey) {
      gateway.addProvider({
        provider: config.provider as 'openai' | 'anthropic',
        apiKey: config.apiKey,
        baseURL: config.baseURL
      })
      // If the selected model requires a different provider than configured, add that adapter too.
      // Convert GLM anthropic baseURL → openai baseURL and vice versa.
      const modelPreset = DEFAULT_MODELS.find((m) => m.id === config.model)
      if (modelPreset && modelPreset.provider !== config.provider) {
        const crossProvider = modelPreset.provider as 'openai' | 'anthropic'
        let crossBaseURL = config.baseURL
        if (config.baseURL?.includes('/api/anthropic')) {
          crossBaseURL = config.baseURL.replace('/api/anthropic', '/api/paas/v4')
        } else if (config.baseURL?.includes('/api/paas/v4')) {
          crossBaseURL = config.baseURL.replace('/api/paas/v4', '/api/anthropic')
        }
        gateway.addProvider({
          provider: crossProvider,
          apiKey: config.apiKey,
          baseURL: crossBaseURL
        })
      }
    }

    // Build AgentConfig from current settings; use workspace root if available
    const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()

    // Inject active task context into agent loop
    if (result.data.activeTaskId) {
      const task = await taskStore.getTask(result.data.activeTaskId)
      agentLoop.activeTask = task ?? null
    } else {
      agentLoop.activeTask = null
    }

    // Build projectRoots from active task or fall back to workspace root
    const projectRoots = agentLoop.activeTask
      ? agentLoop.activeTask.projects.map(p => p.path)
      : [workingDirectory]

    const agentConfig: AgentConfig = {
      model: config.model,
      provider: config.provider as 'openai' | 'anthropic',
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory,
      projectRoots,
      conversationId: result.data.conversationId,
      thinkingDepth: config.thinkingDepth as 'none' | 'low' | 'medium' | 'high' | undefined,
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
          case 'agent:thinking':
            sender.send(IPC_CHANNELS['stream:thinking_delta'], { content: agentEvent.content })
            break
          case 'agent:tool_call':
            // Store tool input so we can extract file path on tool_result (per D-52)
            toolCallInputs.set(agentEvent.toolCallId, agentEvent.input)
            sender.send(IPC_CHANNELS['stream:tool_use_start'], {
              id: agentEvent.toolCallId,
              name: agentEvent.toolName,
              input: agentEvent.input,
            })
            break
          case 'agent:tool_result': {
            sender.send(IPC_CHANNELS['stream:tool_use_end'], {
              id: agentEvent.toolCallId,
              output: agentEvent.output,
              isError: agentEvent.isError,
              toolName: agentEvent.toolName,
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
          case 'agent:error':
            sender.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error })
            break
          case 'agent:turn_end':
            sender.send(IPC_CHANNELS['stream:turn_end'], {})
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
            // Track cost and push usage:update to renderer (Phase 4.4)
            costTracker.addUsage(
              agentConfig.model,
              agentEvent.usage.inputTokens,
              agentEvent.usage.outputTokens,
              agentEvent.usage.cacheReadTokens ?? 0,
              agentEvent.usage.cacheWriteTokens ?? 0
            )
            sender.send(IPC_CHANNELS['usage:update'], costTracker.getSession())
            // Auto-save only NEW messages since last persist (fixes log duplication P0)
            try {
              const allMessages = agentLoop.getMessages()
              const newMessages = allMessages.slice(persistedMessageCount)
              if (newMessages.length > 0) {
                // Inject usage into last assistant message for /insights cost tracking
                const lastAsst = [...newMessages].reverse().find(m => m.role === 'assistant')
                if (lastAsst) {
                  (lastAsst as Record<string, unknown>).usage = {
                    inputTokens: agentEvent.usage.inputTokens,
                    outputTokens: agentEvent.usage.outputTokens,
                  }
                }
                await getSessionStore().appendMessages(agentConfig.conversationId, newMessages)
                persistedMessageCount = allMessages.length
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

  // Save and get last active session ID (for restoring on next app launch)
  ipcMain.handle(IPC_CHANNELS['session:save-last'], (_event, request: { sessionId: string }) => {
    settingsManager.setLastSessionId(request.sessionId)
  })

  ipcMain.handle(IPC_CHANNELS['session:get-last'], () => {
    return { sessionId: settingsManager.getLastSessionId() ?? null }
  })

  // ============================================================
  // Workspace: open folder — shows native dialog, sets workspace
  // ============================================================
  let fileChangeUnsubscribe: (() => void) | null = null

  function forwardFileChanges(): void {
    const callback = (filePath: string, changeType: string) => {
      // Invalidate git cache when files change so next agent turn gets fresh status
      invalidateGitCache()
      for (const bw of BrowserWindow.getAllWindows()) {
        bw.webContents.send(IPC_CHANNELS['file:changed'], { filePath, changeType })
      }
    }
    workspaceManager.onFileChange(callback)
    // Return an unsubscribe function that removes this specific callback
    fileChangeUnsubscribe = () => {
      workspaceManager.offFileChange(callback)
    }
  }

  ipcMain.handle(IPC_CHANNELS['workspace:open_folder'], async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const rootPath = await workspaceManager.openFolderDialog(win)
    if (rootPath) {
      // Clean up previous listener to prevent accumulation
      if (fileChangeUnsubscribe) {
        fileChangeUnsubscribe()
        fileChangeUnsubscribe = null
      }
      forwardFileChanges()

      // Notify index.ts to create IndexingEngine for the new workspace
      if (onWorkspaceOpened) {
        onWorkspaceOpened(rootPath)
      }

      return { rootPath }
    }
    return null
  })

  ipcMain.handle(IPC_CHANNELS['workspace:set_folder'], async (_event, { folderPath }: { folderPath: string }) => {
    const rootPath = await workspaceManager.setFolder(folderPath)
    if (rootPath) {
      if (fileChangeUnsubscribe) {
        fileChangeUnsubscribe()
        fileChangeUnsubscribe = null
      }
      forwardFileChanges()
      if (onWorkspaceOpened) {
        onWorkspaceOpened(rootPath)
      }
      return { rootPath }
    }
    return null
  })

  // ============================================================
  // Shell: open path in OS file manager
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['shell:open_path'], async (_event, { path: folderPath }) => {
    // Only allow known extension directories to prevent arbitrary path execution
    const allowed = [getCommandsDir(), getSkillsDir()]
    const resolved = path.resolve(String(folderPath ?? '')).toLowerCase()
    const isAllowed = allowed.some(d => resolved === d.toLowerCase() || resolved.startsWith(d.toLowerCase() + path.sep))
    if (!isAllowed) {
      throw new Error('shell:open_path blocked: path not in allowed extension directories')
    }
    await shell.openPath(resolved)
  })

  // ============================================================
  // Shell: get extension directory paths (commands + skills)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['shell:get_extension_paths'], () => {
    return { commandsDir: getCommandsDir(), skillsDir: getSkillsDir() }
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
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) throw new Error('No workspace open')
    const filePath = request?.filePath
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid filePath')
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath)
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      throw new Error('Access denied: file path is outside the workspace root')
    }
    return workspaceManager.readFile(absolutePath)
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

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      return { error: 'Access denied: file path is outside the workspace root', size: 0, limit: 102400 }
    }

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
  // File: read-folder-tree — generates directory tree summary for folder @-mention
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read-folder-tree'], async (_event, request) => {
    const result = IpcSchemas['file:read-folder-tree'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { dirPath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      return { error: 'No workspace open' }
    }

    const absolutePath = path.isAbsolute(dirPath)
      ? dirPath
      : path.resolve(workspaceRoot, dirPath)

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      return { error: 'Access denied: directory path is outside the workspace root' }
    }

    // Directories to skip
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '__pycache__', '.cache'])
    const MAX_DEPTH = 3
    const MAX_ENTRIES = 100

    const { readdir, stat: fsStat } = await import('fs/promises')

    interface TreeNode {
      name: string
      isDirectory: boolean
      children: TreeNode[]
    }

    async function buildTree(dir: string, depth: number, entryCount: { count: number }): Promise<TreeNode[]> {
      if (depth > MAX_DEPTH || entryCount.count >= MAX_ENTRIES) return []

      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return []
      }

      // Sort: directories first, then files, both alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      const nodes: TreeNode[] = []
      for (const entry of entries) {
        if (entryCount.count >= MAX_ENTRIES) break
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.env') continue

        entryCount.count++
        const childPath = path.join(dir, entry.name)
        const isDir = entry.isDirectory()

        const node: TreeNode = {
          name: entry.name,
          isDirectory: isDir,
          children: []
        }

        if (isDir) {
          node.children = await buildTree(childPath, depth + 1, entryCount)
        }

        nodes.push(node)
      }
      return nodes
    }

    try {
      const dirStat = await fsStat(absolutePath)
      if (!dirStat.isDirectory()) {
        return { error: 'Path is not a directory' }
      }

      const entryCount = { count: 0 }
      const children = await buildTree(absolutePath, 1, entryCount)

      // Format as tree string
      function formatTree(nodes: TreeNode[], prefix: string): string {
        let result = ''
        for (let i = 0; i < nodes.length; i++) {
          const isLast = i === nodes.length - 1
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 '
          const suffix = nodes[i].isDirectory ? '/' : ''
          result += `${prefix}${connector}${nodes[i].name}${suffix}\n`

          if (nodes[i].isDirectory && nodes[i].children.length > 0) {
            const newPrefix = prefix + (isLast ? '    ' : '\u2502   ')
            result += formatTree(nodes[i].children, newPrefix)
          }
        }
        return result
      }

      const dirName = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/') || path.basename(absolutePath)
      const tree = `${dirName}/\n` + formatTree(children, '')
      const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/')

      return { tree, fileCount: entryCount.count, path: relativePath }
    } catch (err) {
      return { error: `Failed to read directory: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ============================================================
  // File: save — validates filePath and enforces workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:save'], async (_event, request) => {
    const result = IpcSchemas['file:save'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { filePath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      throw new Error('No workspace open')
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      throw new Error('Access denied: file path is outside the workspace root')
    }

    await workspaceManager.saveFile(absolutePath, result.data.content)
  })

  // ============================================================
  // File: rename — renames/moves a file within workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:rename'], async (_event, request) => {
    try {
      const { oldPath, newPath } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absOld = path.isAbsolute(oldPath) ? oldPath : path.resolve(workspaceRoot, oldPath)
      const absNew = path.isAbsolute(newPath) ? newPath : path.resolve(workspaceRoot, newPath)

      if (!isWithinWorkspace(absOld, workspaceRoot) || !isWithinWorkspace(absNew, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const { rename } = await import('fs/promises')
      await rename(absOld, absNew)
      return { success: true }
    } catch (error) {
      console.error('Failed to rename file:', error)
      return { success: false }
    }
  })

  // ============================================================
  // File: delete — removes a file/directory within workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:delete'], async (_event, request) => {
    try {
      const { filePath } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath)

      if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const { rm } = await import('fs/promises')
      await rm(absolutePath, { recursive: true })
      return { success: true }
    } catch (error) {
      console.error('Failed to delete file:', error)
      return { success: false }
    }
  })

  // ============================================================
  // Session: list — returns all sessions for current project or task
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:list'], async (_event, payload?: { activeTaskId?: string }) => {
    // If activeTaskId provided, use task-scoped store; otherwise fall through
    // to the dynamic getSessionStore() which checks agentLoop.activeTask
    if (payload?.activeTaskId) {
      const { SessionStore } = await import('./persistence/session-store')
      return SessionStore.forTask(payload.activeTaskId).listSessions()
    }
    return getSessionStore().listSessions()
  })

  // ============================================================
  // Session: load — returns messages and restores agent context (Phase 3.4)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load'], async (event, request) => {
    const result = IpcSchemas['session:load'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const sessionId = result.data.sessionId
    const rawMessages = await getSessionStore().loadSession(sessionId)

    // Reset persisted counter to match loaded message count
    persistedMessageCount = rawMessages.length

    // Restore agent loop context so subsequent messages continue the conversation.
    // Run asynchronously after returning messages to the renderer — the renderer
    // shows the chat immediately while the (potentially slow) compaction runs.
    const config = settingsManager.getCurrentConfig()
    const restoreCwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const restoreRoots = agentLoop.activeTask
      ? agentLoop.activeTask.projects.map(p => p.path)
      : [restoreCwd]
    agentLoop.restoreContext(rawMessages, {
      model: config.model,
      provider: config.provider as 'openai' | 'anthropic',
      systemPrompt: config.systemPrompt,
      workingDirectory: restoreCwd,
      projectRoots: restoreRoots,
    }).then((info) => {
      const sender = event.sender
      if (!sender.isDestroyed()) {
        sender.send(IPC_CHANNELS['session:context-restored'], {
          sessionId,
          messageCount: info.messageCount,
          compacted: info.compacted,
          beforeTokens: info.beforeTokens,
          afterTokens: info.afterTokens
        })
      }
    }).catch((err) => {
      console.error('[session:load] restoreContext failed:', err)
    })

    return rawMessages
  })

  // ============================================================
  // Session: delete — removes a session file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:delete'], async (_event, request) => {
    const result = IpcSchemas['session:delete'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const success = await getSessionStore().deleteSession(result.data.sessionId)
    if (success) onDataChanged?.('session:changed', { action: 'deleted', sessionId: result.data.sessionId })
    return { success }
  })

  // ============================================================
  // Session: rename — updates session title via meta line
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:rename'], async (_event, request) => {
    const result = IpcSchemas['session:rename'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const success = await getSessionStore().renameSession(result.data.sessionId, result.data.title)
    if (success) onDataChanged?.('session:changed', { action: 'renamed', sessionId: result.data.sessionId, title: result.data.title })
    return { success }
  })

  // ============================================================
  // File: apply-hunk — validates filePath, enforces workspace boundary,
  // writes accepted diff hunks to disk
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:apply-hunk'], async (_event, request) => {
    try {
      const result = IpcSchemas['file:apply-hunk'].request.safeParse(request)
      if (!result.success) {
        throw new Error(`Invalid request: ${result.error.message}`)
      }

      const { filePath, modifiedContent } = result.data
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) {
        throw new Error('No workspace open')
      }

      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath)

      // Verify the resolved path stays within the workspace boundary
      if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
        throw new Error('Access denied: file path is outside the workspace root')
      }

      const { writeFile } = await import('fs/promises')
      await writeFile(absolutePath, modifiedContent, 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('Failed to apply hunk:', error)
      return { success: false }
    }
  })

  // ============================================================
  // Agent: compact context — manual /compact command
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:compact_context'], async (event) => {
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
    // Notify renderer so the compacted banner appears in chat
    event.sender.send(IPC_CHANNELS['session:compacted'], {
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      auto: false
    })
    return { beforeTokens: result.beforeTokens, afterTokens: result.afterTokens }
  })

  // ============================================================
  // Terminal: create — spawns PTY and subscribes to output
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['terminal:create'], async (event, request) => {
    const terminalId = terminalManager.createTerminal(request.cwd)

    // Forward PTY output to the renderer that created this terminal
    terminalManager.onTerminalData(terminalId, (data) => {
      event.sender.send(IPC_CHANNELS['terminal:data'], { terminalId, data })
    })

    return { terminalId }
  })

  // ============================================================
  // Terminal: kill — kills PTY and removes from map
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['terminal:kill'], async (_event, request) => {
    terminalManager.killTerminal(request.terminalId)
  })

  // ============================================================
  // Terminal: input — writes data to PTY stdin
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['terminal:input'], async (_event, request) => {
    terminalManager.writeToTerminal(request.terminalId, request.data)
  })

  // ============================================================
  // Terminal: resize — resizes PTY dimensions
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['terminal:resize'], async (_event, request) => {
    terminalManager.resizeTerminal(request.terminalId, request.cols, request.rows)
  })

  // ============================================================
  // Terminal: output — returns current buffer for agent analysis
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['terminal:output'], async (_event, request) => {
    return { buffer: terminalManager.getOutputBuffer(request.terminalId) }
  })

  // ============================================================
  // Symbol: result — resolves pending symbol queries from renderer
  // ============================================================
  ipcMain.on('symbol:result', (_event, payload) => {
    handleSymbolResult(payload)
  })

  // ============================================================
  // Step: list — returns all agent steps
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['step:list'], () => {
    return stepManager.getAllSteps()
  })

  // ============================================================
  // Task management — CRUD for top-level user tasks
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['task:list'], async (_event, payload?: { includeArchived?: boolean }) => {
    return taskStore.listTasks(payload?.includeArchived)
  })

  ipcMain.handle(IPC_CHANNELS['task:get'], async (_event, payload: { taskId: string }) => {
    return taskStore.getTask(payload.taskId)
  })

  ipcMain.handle(IPC_CHANNELS['task:create'], async (_event, payload: { title: string; description?: string }) => {
    const task = await taskStore.createTask(payload.title, payload.description)
    onDataChanged?.('task:changed', { action: 'created', task })
    return task
  })

  ipcMain.handle(IPC_CHANNELS['task:update'], async (_event, payload: { taskId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string; progressSummary?: string } }) => {
    const task = await taskStore.updateTask(payload.taskId, payload.updates)
    onDataChanged?.('task:changed', { action: 'updated', task })
    return task
  })

  ipcMain.handle(IPC_CHANNELS['task:delete'], async (_event, payload: { taskId: string }) => {
    await taskStore.deleteTask(payload.taskId)
    onDataChanged?.('task:changed', { action: 'deleted', taskId: payload.taskId })
  })

  ipcMain.handle(IPC_CHANNELS['task:add-project'], async (_event, payload: { taskId: string; folderPath: string }) => {
    const task = await taskStore.addProject(payload.taskId, payload.folderPath)
    onDataChanged?.('task:changed', { action: 'updated', task })
    return task
  })

  ipcMain.handle(IPC_CHANNELS['task:remove-project'], async (_event, payload: { taskId: string; projectId: string }) => {
    const task = await taskStore.removeProject(payload.taskId, payload.projectId)
    onDataChanged?.('task:changed', { action: 'updated', task })
    return task
  })

  // ============================================================
  // Index: status — returns current indexing status
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['index:status'], () => {
    return indexingEngineRef.current?.getStatus() ?? { status: 'idle', fileCount: 0, currentFile: '' }
  })

  // ============================================================
  // Index: reindex — triggers full re-index of workspace
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['index:reindex'], async () => {
    if (!indexingEngineRef.current) throw new Error('No workspace open')
    await indexingEngineRef.current.indexFull()
  })

  // ============================================================
  // Index: search — search the index from UI (separate from agent tool)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['index:search'], async (_event, request) => {
    if (!indexingEngineRef.current) return []
    return indexingEngineRef.current.search(request.query, request.topK)
  })

  // ============================================================
  // Index: progress — forward indexing progress to renderer
  // ============================================================
  // Use a wrapper that always reads from indexingEngineRef.current,
  // so progress forwarding works even after workspace switch creates a new engine.
  if (onWorkspaceOpened) {
    // Initial progress forwarding for any pre-existing engine
    if (indexingEngine) {
      indexingEngine.onProgress((progress) => {
        for (const bw of BrowserWindow.getAllWindows()) {
          bw.webContents.send(IPC_CHANNELS['index:progress'], progress)
        }
      })
    }
  }

  // ============================================================
  // Git: status — returns branch name and changed file count
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['git:status'], async () => {
    const cwd = workspaceManager.getWorkspaceRoot()
    if (!cwd) return { branch: '', changedFiles: 0 }
    return getGitStatusShort(cwd)
  })

  // ============================================================
  // Permission: get_mode — returns current permission mode
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['permission:get_mode'], () => {
    return { mode: permissionManager.getMode() }
  })

  // ============================================================
  // Permission: set_mode — changes permission mode
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['permission:set_mode'], (_event, request) => {
    permissionManager.setMode(request.mode)
  })

  // ============================================================
  // MCP: list_servers — returns all configured MCP servers and status
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['mcp:list_servers'], () => {
    return mcpManager.listServers()
  })

  // ============================================================
  // MCP: list_tools — returns all tools from connected MCP servers
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['mcp:list_tools'], async () => {
    return mcpManager.listAllTools()
  })

  // ============================================================
  // MCP: add_server — adds and connects a new MCP server
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['mcp:add_server'], async (_event, request) => {
    await mcpManager.addServer({
      name: request.name,
      transport: request.transport,
      command: request.command,
      args: request.args,
      url: request.url
    })
  })

  // ============================================================
  // MCP: remove_server — disconnects and removes an MCP server
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['mcp:remove_server'], (_event, request) => {
    mcpManager.removeServer(request.name)
  })

  // ============================================================
  // Insights: generate session analysis report
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['insights:generate'], async (event) => {
    const sender = event.sender
    const sendProgress = (stage: string, current: number, total: number, message: string) => {
      sender.send(IPC_CHANNELS['insights:progress'], { stage, current, total, message })
    }

    const config = settingsManager.getCurrentConfig()
    if (!config.apiKey) {
      throw new Error('No API key configured. Set an API key in Settings to use /insights.')
    }

    // Insights uses OpenAI-compatible /chat/completions endpoint.
    // If provider is anthropic with an Anthropic-specific baseURL (e.g. bigmodel.cn/api/anthropic),
    // convert to the OpenAI-compatible endpoint so raw fetch() works.
    let effectiveBaseUrl = config.baseURL || 'https://open.bigmodel.cn/api/paas/v4'
    if (config.provider === 'anthropic') {
      if (effectiveBaseUrl.includes('/anthropic')) {
        effectiveBaseUrl = effectiveBaseUrl.replace(/\/anthropic.*/, '/paas/v4')
      } else if (effectiveBaseUrl.includes('anthropic.com')) {
        // Real Anthropic — cannot use OpenAI format, fall back to env var or error
        const openaiKey = process.env.OPENAI_API_KEY
        if (openaiKey) {
          effectiveBaseUrl = 'https://api.openai.com/v1'
          console.log(`[insights] Anthropic provider detected, falling back to OPENAI_API_KEY for insights`)
        } else {
          throw new Error('Insights requires an OpenAI-compatible API endpoint. Configure an OpenAI API key or use a provider with OpenAI-compatible endpoint.')
        }
      }
    }
    console.log(`[insights] config: provider=${config.provider} model=${config.model} baseURL=${effectiveBaseUrl} hasApiKey=${!!config.apiKey}`)

    // Dynamic import to avoid loading insights modules at startup
    const { scanAllSessions, loadSessionMessages } = await import('./insights/session-scanner')
    const { batchExtractFacets } = await import('./insights/facet-extractor')
    const { aggregateData, generateInsights, buildInsightReport } = await import('./insights/insight-generator')

    const sessionsRoot = path.join(getAppDataDir(), 'sessions')
    const cacheDir = getInsightsCacheDir()
    const reportDir = getInsightsReportDir()

    // Stage 1: Scan sessions
    sendProgress('scanning', 0, 0, 'Scanning session files...')
    const allMeta = await scanAllSessions(sessionsRoot)

    if (allMeta.length === 0) {
      throw new Error('No sessions found. Start coding first, then run /insights.')
    }

    // Stage 2: Extract facets
    sendProgress('extracting_facets', 0, allMeta.length, `Analyzing ${allMeta.length} sessions...`)
    const sessionsWithData = []
    for (const meta of allMeta) {
      const messages = await loadSessionMessages(
        path.join(sessionsRoot, meta.projectHash, `${meta.sessionId}.jsonl`),
      )
      sessionsWithData.push({ meta, messages })
    }

    const facets = await batchExtractFacets(
      sessionsWithData,
      config.apiKey,
      effectiveBaseUrl,
      config.model,
      cacheDir,
      (current, total) => sendProgress('extracting_facets', current, total, `Analyzing session ${current}/${total}...`),
    )

    // Stage 3: Aggregate
    sendProgress('aggregating', 0, 0, 'Aggregating statistics...')
    const aggregated = aggregateData(allMeta, facets)

    // Stage 4: Generate insights
    sendProgress('generating_insights', 0, 6, 'Generating insights...')
    const sections = await generateInsights(
      aggregated,
      config.apiKey,
      effectiveBaseUrl,
      config.model,
      (sectionId) => sendProgress('generating_insights', 0, 6, `Generating: ${sectionId}...`),
    )

    // Stage 5: Build report
    sendProgress('rendering', 0, 0, 'Rendering report...')
    const result = await buildInsightReport(aggregated, sections, reportDir)

    sendProgress('done', 0, 0, 'Done!')
    return result
  })

  // ============================================================
  // Context breakdown — detailed token usage per category
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:context_breakdown'], async () => {
    const { countTokens, countMessagesTokens } = await import('./context/token-counter')
    const { buildSystemPromptBreakdown } = await import('./agent/system-prompt-builder')
    const config = settingsManager.getCurrentConfig()
    const model = config.model
    const preset = DEFAULT_MODELS.find(m => m.id === model)
    const contextWindowSize = preset?.contextWindowSize ?? 128000
    const maxOutputTokens = preset?.maxTokens ?? 16384

    // 1. System prompt breakdown
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const breakdownRoots = agentLoop.activeTask
      ? agentLoop.activeTask.projects.map(p => p.path)
      : [cwd]
    const promptBreakdown = await buildSystemPromptBreakdown({
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory: cwd,
      projectRoots: breakdownRoots,
      model,
      provider: config.provider as 'openai' | 'anthropic',
    }, agentLoop.activeTask)

    // 2. Tool definitions — separate built-in vs MCP
    const allToolDefs = toolRegistry.getDefinitions()
    const allToolTokens = countTokens(JSON.stringify(allToolDefs))
    const mcpToolNames = new Set(mcpManager.listAllTools().map(t => t.name))
    const builtinDefs = allToolDefs.filter(d => !mcpToolNames.has(d.name))
    const mcpDefs = allToolDefs.filter(d => mcpToolNames.has(d.name))
    const builtinToolTokens = countTokens(JSON.stringify(builtinDefs))
    const mcpToolTokens = countTokens(JSON.stringify(mcpDefs))

    // 3. Conversation messages
    const messages = agentLoop.getMessages()
    const conversationTokens = countMessagesTokens(messages, model)
    const messagesByRole = { user: 0, assistant: 0, tool_result: 0 }
    for (const m of messages) {
      const role = m.role as keyof typeof messagesByRole
      if (role in messagesByRole) messagesByRole[role]++
    }

    // 4. Totals
    const totalEstimated = promptBreakdown.staticTokens + promptBreakdown.dynamicTokens
      + allToolTokens + conversationTokens
    const usagePercent = (totalEstimated / contextWindowSize) * 100
    const autocompactBufferTokens = Math.floor(contextWindowSize * (contextManager.getConfig().compactThreshold ?? 0.8))
      - totalEstimated
    const freeSpaceTokens = Math.max(0, contextWindowSize - totalEstimated)

    // 5. Session usage + compaction history
    const sessionUsage = costTracker.getSession()
    const compactionHistory = contextManager.getCompactHistory()

    return {
      systemPromptTokens: promptBreakdown.staticTokens,
      systemPromptDynamicTokens: promptBreakdown.dynamicTokens,
      instructionsTokens: promptBreakdown.instructionsTokens,
      commandsTokens: promptBreakdown.commandsTokens,
      skillsTokens: promptBreakdown.skillsTokens,
      memoryTokens: promptBreakdown.memoryTokens,
      toolDefinitionsTokens: allToolTokens,
      builtinToolTokens,
      mcpToolTokens,
      conversationTokens,
      conversationMessageCount: messages.length,
      messagesByRole,
      totalEstimatedTokens: totalEstimated,
      contextWindowSize,
      maxOutputTokens,
      usagePercent,
      autocompactBufferTokens: Math.max(0, autocompactBufferTokens),
      freeSpaceTokens,
      sessionUsage,
      compactionHistory,
      model,
    }
  })
}
