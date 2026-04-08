import { ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'

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
import { DEFAULT_SYSTEM_PROMPT } from '../shared/constants'
import type { LLMGateway } from './llm/gateway'
import type { AgentLoop } from './agent/agent-loop'
import type { PermissionManager } from './permission/permission-manager'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { AgentConfig } from './agent/types'
import type { SessionStore } from './persistence/session-store'
import type { ContextManager } from './context/context-manager'
import type { TerminalManager } from './terminal/terminal-manager'
import type { TaskManager } from './tasks/task-manager'
import { SettingsManager } from './settings-manager'
import { handleSymbolResult } from './tools/symbol-nav'
import type { IndexingEngine } from './indexing/indexing-engine'

// Persistent settings with encrypted API key storage (per D-66)
const settingsManager = new SettingsManager()

export function registerIpcHandlers(
  gateway: LLMGateway,
  agentLoop: AgentLoop,
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager,
  sessionStore: SessionStore,
  contextManager: ContextManager,
  terminalManager: TerminalManager,
  taskManager: TaskManager,
  indexingEngine: IndexingEngine | null,
  onWorkspaceOpened?: (rootPath: string) => void
): void {
  // Load persisted settings from disk
  settingsManager.load()

  // Mutable reference to IndexingEngine (updated when workspace opens)
  const indexingEngineRef = { current: indexingEngine }

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
              await sessionStore.appendMessages(agentConfig.conversationId, allMessages)
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
  let fileChangeUnsubscribe: (() => void) | null = null

  function forwardFileChanges(): void {
    const callback = (filePath: string, changeType: string) => {
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
  // Session: list — returns all sessions for current project
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:list'], async () => {
    return sessionStore.listSessions()
  })

  // ============================================================
  // Session: load — returns messages for a specific session
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load'], async (_event, request) => {
    return sessionStore.loadSession(request.sessionId)
  })

  // ============================================================
  // Session: delete — removes a session file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:delete'], async (_event, request) => {
    return { success: await sessionStore.deleteSession(request.sessionId) }
  })

  // ============================================================
  // Session: rename — updates session title via meta line
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:rename'], async (_event, request) => {
    return { success: await sessionStore.renameSession(request.sessionId, request.title) }
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
  // Task: list — returns all agent tasks
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['task:list'], () => {
    return taskManager.getAllTasks()
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
}
