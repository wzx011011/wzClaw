import { ipcMain, BrowserWindow, shell } from 'electron'
import path from 'path'
import os from 'os'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
import { CostTracker } from './llm/cost-tracker'
import { getCommandsDir, getSkillsDir, getAppDataDir, getInsightsCacheDir, getInsightsReportDir } from './paths'
import { invalidateGitCache } from './git/git-context'
import { pluginToInfo } from '../shared/types-plugin'
import { skillToInfo } from '../shared/types-skill'

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
import { SessionRuntimeManager } from './agent/session-runtime-manager'
import type { PermissionManager } from './permission/permission-manager'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { AgentConfig } from './agent/types'
import { SessionStore } from './persistence/session-store'
import { SessionStoreManager } from './persistence/session-store-manager'
import type { ContextManager } from './context/context-manager'
import type { TerminalManager } from './terminal/terminal-manager'
import type { StepManager } from './steps/step-manager'
import { SettingsManager } from './settings-manager'
import { handleSymbolResult } from './tools/symbol-nav'
import type { IndexingEngine } from './indexing/indexing-engine'
import { getGitStatusShort } from './git/git-context'
import type { MCPManager } from './mcp/mcp-manager'
import type { WorkspaceStore } from './tasks/workspace-store'

export function registerIpcHandlers(
  gateway: LLMGateway,
  agentLoop: AgentLoop,
  runtimes: SessionRuntimeManager,
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager,
  getSessionStore: () => SessionStore,
  storeManager: SessionStoreManager,
  contextManager: ContextManager,
  terminalManager: TerminalManager,
  stepManager: StepManager,
  indexingEngine: IndexingEngine | null,
  settingsManager: SettingsManager,
  mcpManager: MCPManager,
  workspaceStore: WorkspaceStore,
  onWorkspaceOpened?: (rootPath: string) => void,
  onDataChanged?: (event: string, data: unknown) => void,
  onStreamEvent?: (event: string, data: unknown) => void
): void {
  // Mutable reference to IndexingEngine (updated when workspace opens)
  const indexingEngineRef = { current: indexingEngine }

  // Session-scoped cost tracker — resets on each new send (Phase 4.4)
  const costTracker = new CostTracker()

  // Per-session persisted message counts — prevents cross-session corruption
  const persistedMessageCounts = new Map<string, number>()

  // Helper: 解析 workspace 并返回 SessionStore（替代重复的 new SessionStore 模式）
  const resolveStore = (activeWorkspaceId?: string) =>
    storeManager.getForWorkspace(activeWorkspaceId, workspaceManager, workspaceStore)

  // Helper: 解析当前 workspace 的 projectRoots（替代 agentLoop.activeWorkspace 读取）
  const resolveProjectRoots = (): string[] => {
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const lastSessionId = settingsManager.getLastSessionId()
    if (lastSessionId) {
      const rt = runtimes.getOrCreate(lastSessionId)
      if (rt.activeWorkspace) {
        return rt.activeWorkspace.projects.map(p => p.path)
      }
    }
    return [cwd]
  }

  // Guard against concurrent agent:send_message calls (per-session)
  // 已移除全局 isAgentRunning 布尔守卫，改为按会话检查 runtimes.isRunning()

  // ============================================================
  // Agent: send message — triggers AgentLoop.run() and forwards
  // events to the renderer via webContents.send
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
    const result = IpcSchemas['agent:send_message'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    // 按会话检查是否已有 agent 在运行（不再使用全局布尔守卫）
    const conversationId = result.data.conversationId
    if (runtimes.isRunning(conversationId)) {
      throw new Error('Agent is already processing a message in this session. Please wait for it to finish or stop it first.')
    }

    const sender = event.sender

    // 获取当前会话的 per-session runtime
    const runtime = runtimes.getOrCreate(conversationId)

    // Set active session for step manager (session-isolated steps)
    stepManager.setActiveSession(conversationId)

    // Reset persisted message counter for new conversation turn (per-session)
    persistedMessageCounts.set(conversationId, runtime.getMessages().length)

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

    // Inject active workspace context into per-session runtime
    if (result.data.activeWorkspaceId) {
      const workspace = await workspaceStore.getWorkspace(result.data.activeWorkspaceId)
      runtime.activeWorkspace = workspace ?? null
    } else {
      runtime.activeWorkspace = null
    }

    // Build projectRoots from active workspace or fall back to workspace root
    const projectRoots = runtime.activeWorkspace
      ? runtime.activeWorkspace.projects.map(p => p.path)
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
      runtimes.cancel(conversationId)
      permissionManager.clearSession(agentConfig.conversationId)
    }
    sender.once('destroyed', onWindowClosed)

    // Run agent loop and forward events to renderer + mobile
    // Track tool call inputs by ID to extract file paths for agent edit notifications (per D-52)
    const toolCallInputs = new Map<string, Record<string, unknown>>()

    // Helper: broadcast stream event to mobile via relay
    const relayEvent = (eventType: string, data: Record<string, unknown>) => {
      if (onStreamEvent) {
        onStreamEvent(`stream:${eventType}`, { ...data, sessionId: agentConfig.conversationId })
      }
    }

    // 桌面发起的 agent 运行开始前，通知手机端当前 agent 所在会话 ID，
    // 新协议用 desktop:agent:started；手机端保留对旧 session:active 的兼容。
    onStreamEvent?.('desktop:agent:started', { sessionId: agentConfig.conversationId })
    // 将桌面用户的提问广播给手机端，让其显示用户气泡
    onStreamEvent?.('stream:desktop_user_message', { content: result.data.content, sessionId: agentConfig.conversationId })

    // 通知渲染器和手机端该会话 agent 已启动（用于 runningSessionIds 追踪）
    runtimes.notifyRunningChanged(conversationId, true)

    try {
      for await (const agentEvent of runtime.run(result.data.content, agentConfig, sender, result.data.images as import('../shared/types').ImageContent[] | undefined)) {
        switch (agentEvent.type) {
          case 'agent:text':
            sender.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content, sessionId: conversationId })
            relayEvent('agent:text', { content: agentEvent.content })
            break
          case 'agent:thinking':
            sender.send(IPC_CHANNELS['stream:thinking_delta'], { content: agentEvent.content, sessionId: conversationId })
            break
          case 'agent:tool_call_preview':
            sender.send(IPC_CHANNELS['stream:tool_call_preview'], { id: agentEvent.toolCallId, name: agentEvent.toolName, sessionId: conversationId })
            break
          case 'agent:tool_call':
            // Store tool input so we can extract file path on tool_result (per D-52)
            toolCallInputs.set(agentEvent.toolCallId, agentEvent.input)
            sender.send(IPC_CHANNELS['stream:tool_use_start'], {
              id: agentEvent.toolCallId,
              name: agentEvent.toolName,
              input: agentEvent.input,
              sessionId: conversationId,
            })
            relayEvent('agent:tool_call', { toolCallId: agentEvent.toolCallId, toolName: agentEvent.toolName, input: agentEvent.input })
            break
          case 'agent:tool_result': {
            sender.send(IPC_CHANNELS['stream:tool_use_end'], {
              id: agentEvent.toolCallId,
              output: agentEvent.output,
              isError: agentEvent.isError,
              toolName: agentEvent.toolName,
              sessionId: conversationId,
            })
            relayEvent('agent:tool_result', { toolCallId: agentEvent.toolCallId, toolName: agentEvent.toolName, isError: agentEvent.isError, output: agentEvent.output })

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
            sender.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error, sessionId: conversationId })
            relayEvent('agent:error', { error: agentEvent.error })
            break
          case 'agent:turn_end':
            sender.send(IPC_CHANNELS['stream:turn_end'], { sessionId: conversationId })
            break
          case 'agent:compacted':
            sender.send(IPC_CHANNELS['session:compacted'], {
              beforeTokens: agentEvent.beforeTokens,
              afterTokens: agentEvent.afterTokens,
              auto: agentEvent.auto,
              sessionId: conversationId,
            })
            break
          case 'agent:done':
            sender.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage, sessionId: conversationId })
            relayEvent('agent:done', { usage: agentEvent.usage, turnCount: agentEvent.turnCount })
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
              const allMessages = runtime.getMessages()
              const prevCount = persistedMessageCounts.get(conversationId) ?? 0
              const newMessages = allMessages.slice(prevCount)
              if (newMessages.length > 0) {
                // Inject usage into last assistant message for /insights cost tracking.
                // Create a copy to avoid mutating the shared message object in ConversationManager.
                const lastAsstIdx = [...newMessages].reverse().findIndex(m => m.role === 'assistant')
                if (lastAsstIdx >= 0) {
                  const realIdx = newMessages.length - 1 - lastAsstIdx
                  newMessages[realIdx] = {
                    ...newMessages[realIdx],
                    usage: {
                      inputTokens: agentEvent.usage.inputTokens,
                      outputTokens: agentEvent.usage.outputTokens,
                    }
                  }
                }
                await getSessionStore().appendMessages(agentConfig.conversationId, newMessages)
                persistedMessageCounts.set(conversationId, allMessages.length)
                // 通知手机端：会话消息有更新，触发 fetchSessions → messageCount 对比 → forceRefresh
                onDataChanged?.('session:changed', { action: 'updated', sessionId: agentConfig.conversationId })
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
        sessionId: conversationId,
      })
    } finally {
      runtimes.notifyRunningChanged(conversationId, false)
      sender.removeListener('destroyed', onWindowClosed)
    }
  })

  // ============================================================
  // Agent: stop — cancels the running agent loop
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:stop'], () => {
    // 取消所有桌面发起的 runtime（不包含 mobile 专用 session，此处设计为: 只要不是 mobile 专用的研判面过于复杂）
    // 最安全的语义: 取消桌面当前会话
    const currentId = settingsManager.getLastSessionId()
    if (currentId) runtimes.cancel(currentId)
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

  // Save and get last active session ID (for restoring on next app launch).
  // 同时通知手机：桌面端切换/新建会话时推送 session:changed，让手机刷新会话列表。
  ipcMain.handle(IPC_CHANNELS['session:save-last'], (_event, request: { sessionId: string }) => {
    const previousId = settingsManager.getLastSessionId()
    settingsManager.setLastSessionId(request.sessionId)
    if (previousId !== request.sessionId) {
      onDataChanged?.('session:changed', { action: 'created', sessionId: request.sessionId })
    }
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
  // File: create — creates a new empty file or directory
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:create'], async (_event, request) => {
    try {
      const { dirPath, name, type } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absoluteDir = path.isAbsolute(dirPath) ? dirPath : path.resolve(workspaceRoot, dirPath)
      if (!isWithinWorkspace(absoluteDir, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const fullPath = path.join(absoluteDir, name)
      if (type === 'directory') {
        await fsp.mkdir(fullPath, { recursive: true })
      } else {
        // 确保父目录存在
        await fsp.mkdir(absoluteDir, { recursive: true })
        await fsp.writeFile(fullPath, '', 'utf-8')
      }
      return { success: true, filePath: fullPath }
    } catch (error) {
      console.error('Failed to create file:', error)
      return { success: false, filePath: '' }
    }
  })

  // ============================================================
  // Session: list — returns all sessions for current project or task
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:list'], async (_event, payload?: { activeWorkspaceId?: string }) => {
    const store = await resolveStore(payload?.activeWorkspaceId)
    let sessions = await store.listSessions()

    // Enrich each session with todo summary and running status
    const runningIds = runtimes.listRunning()
    const { TodoWriteTool } = await import('./tools/todo-write')
    for (const session of sessions) {
      session.isRunning = runningIds.includes(session.id)
      try {
        const todos = await TodoWriteTool.loadForSession(session.id)
        if (todos.length > 0) {
          const completed = todos.filter(t => t.status === 'completed').length
          const inProgress = todos.find(t => t.status === 'in_progress')
          let summary = `${completed}/${todos.length} 完成`
          if (inProgress) {
            summary += ` · 当前: ${inProgress.activeForm || inProgress.content}`
          }
          session.todoSummary = summary
        }
      } catch {
        // ignore — session may not have todos
      }
    }

    return { sessions, runningSessionIds: runningIds }
  })

  // ============================================================
  // Session: load — returns messages and restores agent context (Phase 3.4)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load'], async (event, request) => {
    const result = IpcSchemas['session:load'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const { sessionId, activeWorkspaceId } = result.data
    // 为该会话获取/创建 per-session runtime
    const loadRuntime = runtimes.getOrCreate(sessionId)
    // 优先使用请求中携带的 activeWorkspaceId（与 listSessions 保持一致），
    // 避免 runtime.activeWorkspace 尚未设置时读错 store。
    const store = await resolveStore(activeWorkspaceId)
    let resolvedWorkspace = loadRuntime.activeWorkspace ?? null
    if (activeWorkspaceId) {
      const workspace = await workspaceStore.getWorkspace(activeWorkspaceId).catch(() => null)
      if (workspace) {
        resolvedWorkspace = workspace
      }
    }
    const rawMessages = await store.loadSession(sessionId)

    // Reset persisted counter to match loaded message count (per-session)
    persistedMessageCounts.set(sessionId, rawMessages.length)

    const config = settingsManager.getCurrentConfig()
    const restoreCwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const restoreRoots = resolvedWorkspace
      ? resolvedWorkspace.projects.map(p => p.path)
      : [restoreCwd]

    // 会话上下文恢复不是首屏依赖。延迟到窗口可交互后再射入当前 runtime，
    // 避免启动后立即拖动窗口时，主进程被历史 token 统计抢占。
    const restoreSender = event.sender
    setTimeout(() => {
      loadRuntime.restoreContext(rawMessages, {
        model: config.model,
        provider: config.provider as 'openai' | 'anthropic',
        systemPrompt: config.systemPrompt,
        workingDirectory: restoreCwd,
        projectRoots: restoreRoots,
      }).then((info) => {
        if (!restoreSender.isDestroyed()) {
          restoreSender.send(IPC_CHANNELS['session:context-restored'], {
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
    }, 1000)

    return rawMessages
  })

  // ============================================================
  // Session: load-tail — 只返回最近 N 条消息，不触发 agentLoop 上下文恢复
  // 用于会话切换时的快速首帧渲染（先显示 tail，再后台 load 完整会话）
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load-tail'], async (_event, request) => {
    const { sessionId, tailCount, activeWorkspaceId } = request as { sessionId: string; tailCount: number; activeWorkspaceId?: string }
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid session ID format')
    const store = await resolveStore(activeWorkspaceId)
    const safeCount = Math.max(1, Math.min(tailCount ?? 100, 500))
    return store.loadSessionTail(sessionId, safeCount)
  })

  // ============================================================
  // Session: delete — removes a session file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:delete'], async (_event, request) => {
    const result = IpcSchemas['session:delete'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    let store = await resolveStore(result.data.activeWorkspaceId)
    const success = await store.deleteSession(result.data.sessionId)
    if (success) {
      // Clean up associated steps from memory and disk
      stepManager.clearSession(result.data.sessionId)
      onDataChanged?.('session:changed', { action: 'deleted', sessionId: result.data.sessionId })
    }
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
    const store = await resolveStore(result.data.activeWorkspaceId)
    const success = await store.renameSession(result.data.sessionId, result.data.title)
    if (success) onDataChanged?.('session:changed', { action: 'renamed', sessionId: result.data.sessionId, title: result.data.title })
    return { success }
  })

  // ============================================================
  // Session: duplicate — copies all messages to a new session
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:duplicate'], async (_event, request) => {
    const result = IpcSchemas['session:duplicate'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    // 加载源会话的所有消息行
    const messages = await store.loadSession(result.data.sessionId)
    if (messages.length === 0) {
      throw new Error('Source session is empty or not found')
    }
    // 创建新会话（直接复制 JSONL 内容）
    const newId = crypto.randomUUID()
    const jsonlContent = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    const newPath = path.join(store.sessionDir, `${newId}.jsonl`)
    await fsp.mkdir(store.sessionsDir, { recursive: true })
    await fsp.writeFile(newPath, jsonlContent, 'utf-8')
    onDataChanged?.('session:changed', { action: 'created', sessionId: newId })
    return { newSessionId: newId }
  })

  // ============================================================
  // Todo: load persisted todos for a session
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['todo:load'], async (_event, request: { sessionId: string }) => {
    const { TodoWriteTool } = await import('./tools/todo-write')
    const todos = await TodoWriteTool.loadForSession(request.sessionId)
    return todos.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm ?? '' }))
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
    // 获取渲染器当前会话的 runtime
    const compactSessionId = settingsManager.getLastSessionId()
    const compactRuntime = compactSessionId ? runtimes.getOrCreate(compactSessionId) : agentLoop
    const messages = compactRuntime.getMessages()
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
      compactRuntime.replaceMessages([summaryMsg, ...recentMessages])
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
  // Step: list — returns all agent steps for a session.
  // Loads from disk first if not already in memory.
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['step:list'], async (_event, request?: { sessionId?: string }) => {
    const sid = request?.sessionId
    if (sid) {
      // Ensure steps are loaded from disk into memory
      await stepManager.loadSessionSteps(sid)
      return stepManager.getAllSteps(sid)
    }
    return stepManager.getAllSteps()
  })

  // ============================================================
  // Workspace management — CRUD for top-level user workspaces
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:list'], async (_event, payload?: { includeArchived?: boolean }) => {
    return workspaceStore.listWorkspaces(payload?.includeArchived)
  })

  ipcMain.handle(IPC_CHANNELS['workspace:get'], async (_event, payload: { workspaceId: string }) => {
    return workspaceStore.getWorkspace(payload.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS['workspace:create'], async (_event, payload: { title: string; description?: string }) => {
    const workspace = await workspaceStore.createWorkspace(payload.title, payload.description)
    onDataChanged?.('workspace:changed', { action: 'created', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:update'], async (_event, payload: { workspaceId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string } }) => {
    const workspace = await workspaceStore.updateWorkspace(payload.workspaceId, payload.updates)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:delete'], async (_event, payload: { workspaceId: string }) => {
    await workspaceStore.deleteWorkspace(payload.workspaceId)
    onDataChanged?.('workspace:changed', { action: 'deleted', workspaceId: payload.workspaceId })
  })

  ipcMain.handle(IPC_CHANNELS['workspace:add-project'], async (_event, payload: { workspaceId: string; folderPath: string }) => {
    const workspace = await workspaceStore.addProject(payload.workspaceId, payload.folderPath)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:remove-project'], async (_event, payload: { workspaceId: string; projectId: string }) => {
    const workspace = await workspaceStore.removeProject(payload.workspaceId, payload.projectId)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
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
  ipcMain.handle(IPC_CHANNELS['mcp:list_servers'], async () => {
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
  ipcMain.handle(IPC_CHANNELS['mcp:remove_server'], async (_event, request) => {
    await mcpManager.removeServer(request.name)
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
    const breakdownRoots = resolveProjectRoots()
    const lastSessionId = settingsManager.getLastSessionId()
    const activeWorkspace = lastSessionId ? runtimes.getOrCreate(lastSessionId).activeWorkspace : null
    const promptBreakdown = await buildSystemPromptBreakdown({
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory: cwd,
      projectRoots: breakdownRoots,
      model,
      provider: config.provider as 'openai' | 'anthropic',
    }, activeWorkspace)

    // 2. Tool definitions — separate built-in vs MCP
    const allToolDefs = toolRegistry.getToolDefinitions()
    const allToolTokens = countTokens(JSON.stringify(allToolDefs))
    const mcpToolNames = new Set(mcpManager.listAllTools().map(t => t.name))
    const builtinDefs = allToolDefs.filter(d => !mcpToolNames.has(d.name))
    const mcpDefs = allToolDefs.filter(d => mcpToolNames.has(d.name))
    const builtinToolTokens = countTokens(JSON.stringify(builtinDefs))
    const mcpToolTokens = countTokens(JSON.stringify(mcpDefs))

    // 3. Conversation messages — 使用当前渲染器会话的 runtime
    const breakdownSessionId = settingsManager.getLastSessionId()
    const breakdownRuntime = breakdownSessionId ? runtimes.getOrCreate(breakdownSessionId) : agentLoop
    const messages = breakdownRuntime.getMessages()
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
    // 压缩缓冲：使用与 shouldCompact() 相同的公式
    const cfg = contextManager.getConfig()
    const threshold = cfg.compactThreshold > 0
      ? contextWindowSize * cfg.compactThreshold
      : contextWindowSize - contextManager.getMaxOutputTokensForModel(model) - cfg.compactSafetyBuffer
    const autocompactBufferTokens = Math.floor(Math.max(threshold, contextWindowSize * 0.5))
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

  // ============================================================
  // Skills — list, get prompt, reload, invoke
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['skill:list'], async () => {
    const { skillRegistry } = await import('./skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    return skillRegistry.getAllInfo()
  })

  ipcMain.handle(IPC_CHANNELS['skill:get-prompt'], async (_event, request: { name: string; args: string }) => {
    const { skillRegistry } = await import('./skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    return skillRegistry.getPrompt(request.name, request.args ?? '', settingsManager.getLastSessionId() ?? 'unknown')
  })

  ipcMain.handle(IPC_CHANNELS['skill:reload'], async () => {
    const { skillRegistry } = await import('./skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.reload(cwd, projectRoots)
  })

  ipcMain.handle(IPC_CHANNELS['skill:invoke'], async (_event, request: { name: string; args: string }) => {
    const { skillRegistry } = await import('./skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    const content = await skillRegistry.getPrompt(request.name, request.args ?? '', settingsManager.getLastSessionId() ?? 'unknown')
    if (content === null) {
      return { error: `Skill '${request.name}' not found` }
    }
    return { content }
  })

  // ============================================================
  // Tools — list registered tools
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['tools:list'], async () => {
    const approvalRequired = new Set(toolRegistry.getApprovalRequired())
    return toolRegistry.getDefinitions().map(d => ({
      name: d.name,
      description: d.description,
      isReadOnly: toolRegistry.isReadOnly(d.name),
      requiresApproval: approvalRequired.has(d.name),
    }))
  })

  // ============================================================
  // Plugins — list, get, install, uninstall, enable, disable, reload, get-skills
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:list'], async () => {
    const { pluginRegistry } = await import('./plugins')
    pluginRegistry.setSettingsManager(settingsManager)
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    return pluginRegistry.getAllInfo()
  })

  ipcMain.handle(IPC_CHANNELS['plugin:get'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    const plugin = pluginRegistry.find(request.name)
    if (!plugin) return null
    const info = pluginToInfo(plugin)
    const skills = pluginRegistry.getPluginSkills(plugin.name)
    info.commandCount = skills.length
    info.skillCount = skills.filter(s => s.skillRoot).length
    return info
  })

  ipcMain.handle(IPC_CHANNELS['plugin:install'], async (_event, request: { path: string; scope?: import('../shared/types-plugin').PluginScope }) => {
    const { pluginRegistry } = await import('./plugins')
    const plugin = pluginRegistry.installFromDirectory(
      request.path,
      'local',
      request.scope ?? 'user',
    )
    if (!plugin) {
      return { success: false, message: `Failed to install plugin from ${request.path}` }
    }
    return { success: true, message: `Plugin '${plugin.name}' installed successfully`, pluginName: plugin.name }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:uninstall'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const removed = pluginRegistry.uninstall(request.name)
    return { success: removed, message: removed ? `Plugin '${request.name}' uninstalled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:enable'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const ok = await pluginRegistry.enable(request.name)
    return { success: ok, message: ok ? `Plugin '${request.name}' enabled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:disable'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const ok = pluginRegistry.disable(request.name)
    return { success: ok, message: ok ? `Plugin '${request.name}' disabled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:reload'], async () => {
    const { pluginRegistry } = await import('./plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.reload(cwd, projectRoots)
  })

  ipcMain.handle(IPC_CHANNELS['plugin:get-skills'], async (_event, request: { pluginName?: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    if (request.pluginName) {
      return pluginRegistry.getPluginSkills(request.pluginName).map(skillToInfo)
    }
    return pluginRegistry.getAllPluginSkillInfo()
  })

  // ============================================================
  // Plugins: install-from-source (marketplace: git/npm/url)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:install-from-source'], async (_event, request) => {
    // Validate request with Zod schema
    const schema = IpcSchemas['plugin:install-from-source'].request
    const parsed = schema.safeParse(request)
    if (!parsed.success) {
      return { success: false, message: `Invalid request: ${parsed.error.message}` }
    }
    const { PluginInstaller } = await import('./plugins')
    const scope = request.scope ?? 'user'
    const projectRoot = scope === 'project'
      ? workspaceManager.getWorkspaceRoot() ?? undefined
      : undefined
    return PluginInstaller.fromMarketplaceSource(request.source, scope, projectRoot)
  })

  // ============================================================
  // Plugins: get-output-styles — merged CSS from all enabled plugins
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:get-output-styles'], async () => {
    const { pluginRegistry } = await import('./plugins')
    const { getAllOutputStylesCss } = await import('./plugins/plugin-output-styles')
    const plugins = pluginRegistry.getAll().filter(p => p.enabled)
    return getAllOutputStylesCss(plugins)
  })

  // ============================================================
  // Plugins: get-user-config / set-user-config
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:get-user-config'], async (_event, request: { pluginName: string }) => {
    const { pluginRegistry } = await import('./plugins')
    const plugin = pluginRegistry.find(request.pluginName)
    if (!plugin) return {}
    return plugin.userConfigValues ?? {}
  })

  ipcMain.handle(IPC_CHANNELS['plugin:set-user-config'], async (_event, request: { pluginName: string; values: Record<string, unknown> }) => {
    const { pluginRegistry } = await import('./plugins')
    const plugin = pluginRegistry.find(request.pluginName)
    if (!plugin) {
      return { success: false, message: `Plugin '${request.pluginName}' not found` }
    }
    plugin.userConfigValues = { ...plugin.userConfigValues, ...request.values }
    // 持久化到磁盘
    pluginRegistry.persistPluginState(plugin.name, {
      enabled: plugin.enabled,
      scope: 'user',
      userConfigValues: plugin.userConfigValues,
    })
    return { success: true, message: `User config saved for '${request.pluginName}'` }
  })

  // ============================================================
  // Plugin: search_marketplace — discover installable plugins
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:search_marketplace'], async (_event, request?: { query?: string }) => {
    // Validate request with Zod schema
    const schema = IpcSchemas['plugin:search_marketplace'].request
    const parsed = schema.safeParse(request ?? {})
    if (!parsed.success) {
      return []
    }
    const query = parsed.data?.query?.toLowerCase() ?? ''
    try {
      // Built-in marketplace: curated list of known plugins
      // NOTE: These are placeholder entries for UI demonstration.
      // installSource repos do not exist yet — isPlaceholder disables install button.
      const builtins: import('../shared/types-plugin').MarketplacePluginDisplay[] = [
        {
          name: 'git-workflow',
          description: 'Git workflow automation — commit, branch, rebase, and PR management',
          tags: ['git', 'workflow', 'vcs'],
          category: 'Version Control',
          installSource: { source: 'github', repo: 'anthropics/git-workflow-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'code-quality',
          description: 'Code quality analysis — linting, formatting, and best practices enforcement',
          tags: ['quality', 'linting', 'formatting'],
          category: 'Code Quality',
          installSource: { source: 'github', repo: 'anthropics/code-quality-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'project-analysis',
          description: 'Project structure analysis and documentation generation',
          tags: ['analysis', 'documentation', 'structure'],
          category: 'Analysis',
          installSource: { source: 'github', repo: 'anthropics/project-analysis-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'context-aware-agent',
          description: 'Context-aware code suggestions based on project structure and dependencies',
          tags: ['agent', 'context', 'suggestions'],
          category: 'AI Enhancement',
          installSource: { source: 'github', repo: 'anthropics/context-aware-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'test-runner',
          description: 'Automated test discovery, execution, and coverage reporting',
          tags: ['testing', 'coverage', 'automation'],
          category: 'Testing',
          installSource: { source: 'github', repo: 'anthropics/test-runner-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'docker-helper',
          description: 'Docker container management and Dockerfile optimization',
          tags: ['docker', 'containers', 'devops'],
          category: 'DevOps',
          installSource: { source: 'github', repo: 'anthropics/docker-helper-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'database-tools',
          description: 'Database schema analysis, migration management, and query optimization',
          tags: ['database', 'sql', 'migrations'],
          category: 'Data',
          installSource: { source: 'github', repo: 'anthropics/database-tools-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'security-scanner',
          description: 'Security vulnerability scanning and dependency audit',
          tags: ['security', 'audit', 'vulnerabilities'],
          category: 'Security',
          installSource: { source: 'github', repo: 'anthropics/security-scanner-plugin' },
          installed: false,
          isPlaceholder: true,
        },
      ]

      // Mark installed plugins
      const { pluginRegistry } = await import('./plugins')
      const installedNames = new Set(pluginRegistry.getAll().map(p => p.name))
      for (const entry of builtins) {
        entry.installed = installedNames.has(entry.name)
        if (entry.installed) {
          const plugin = pluginRegistry.find(entry.name)
          entry.enabled = plugin?.enabled ?? false
        }
      }

      // Filter by query
      if (query) {
        return builtins.filter(p =>
          p.name.toLowerCase().includes(query) ||
          (p.description?.toLowerCase().includes(query) ?? false) ||
          (p.tags?.some(t => t.toLowerCase().includes(query)) ?? false) ||
          (p.category?.toLowerCase().includes(query) ?? false)
        )
      }
      return builtins
    } catch (err) {
      console.error('[plugin:search_marketplace]', err)
      return []
    }
  })

  // ============================================================
  // System: doctor — run diagnostics (/doctor command)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['system:doctor'], async () => {
    const { Doctor } = await import('./diagnostics/doctor')
    const apiKey = settingsManager.getApiKey(settingsManager.getSettings().provider)
    const checks = await Doctor.run({
      mcpManager,
      apiKeyConfigured: !!apiKey,
      provider: settingsManager.getSettings().provider,
      model: settingsManager.getSettings().model,
    })
    return Doctor.formatResults(checks)
  })

  // ============================================================
  // Session: export — export conversation to file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:export'], async (_event, request: { sessionId: string; format: 'markdown' | 'json' }) => {
    const { ConversationExporter } = await import('./export/conversation-exporter')
    const store = getSessionStore()
    const messages = await store.loadSession(request.sessionId)
    const exportDir = path.join(os.homedir(), '.wzxclaw', 'exports')
    const filePath = path.join(exportDir, `conversation-${request.sessionId.slice(0, 8)}`)
    const result = await ConversationExporter.exportToFile(messages as any, filePath, request.format)
    return { filePath: result, messageCount: messages.length }
  })
}
