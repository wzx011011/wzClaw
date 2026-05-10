// ============================================================
// Mobile Relay Handler — 移动端 Relay 消息处理器
// 从 index.ts 拆分，处理所有来自 Android 伴侣的 relay 消息
// 包含：session sync、workspace、file browsing、agent command 等
// ============================================================

import path from 'path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { DEFAULT_MODELS } from '../../shared/constants'
import type { RelayClient } from './relay-client'
import type { AgentLoop } from '../agent/agent-loop'
import type { SessionRuntimeManager } from '../agent/session-runtime-manager'
import { SessionTaskStateManager, isActiveSessionTaskStatus } from '../agent/session-task-state-manager'
import type { PermissionManager } from '../permission/permission-manager'
import type { SettingsManager } from '../settings-manager'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-store'
import type { SessionStore, SessionMeta } from '../persistence/session-store'
import type { ToolRegistry } from '../tools/tool-registry'
import type { ContextManager } from '../context/context-manager'
import type { PlanModeController } from '../tools/plan-mode'

export interface MobileRelayDeps {
  relayClient: RelayClient
  agentLoop: AgentLoop
  runtimes: SessionRuntimeManager
  sessionTaskStates: SessionTaskStateManager
  permissionManager: PermissionManager
  settingsManager: SettingsManager
  workspaceManager: WorkspaceManager
  workspaceStore: WorkspaceStore
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  planModeController: PlanModeController
  /** Setter to update the mutable sessionStore on the caller side */
  setSessionStore: (store: SessionStore) => void
}

/**
 * Register the mobile relay handler and all related event listeners.
 * Returns an object with helper functions needed by the caller.
 */
export function registerMobileRelayHandler(deps: MobileRelayDeps): {
  getActiveSessionStore: () => SessionStore
  getCachedSessionStore: (primaryRoot: string) => SessionStore
  sendWorkspaceInfoToMobile: () => Promise<void>
  broadcastToMobile: (event: string, data: unknown) => void
  sessionTaskStates: SessionTaskStateManager
  getMobileSessionId: () => string | null
  setMobileSessionId: (id: string | null) => void
} {
  const {
    relayClient,
    agentLoop,
    runtimes,
    sessionTaskStates,
    permissionManager,
    settingsManager,
    workspaceManager,
    workspaceStore,
    toolRegistry,
    contextManager,
    planModeController,
    setSessionStore,
  } = deps

  let sessionStore: SessionStore
  // Track mobile session ID for persisting mobile-initiated conversations
  let mobileSessionId: string | null = null
  // Track how many messages have already been persisted per mobile session
  const mobilePersistedMessageCounts = new Map<string, number>()
  const mobilePersistLocks = new Map<string, Promise<void>>()
  // Cache SessionStore instances by primaryRoot to avoid repeated mkdirSync per request
  const sessionStoreCache = new Map<string, SessionStore>()

  const getCachedSessionStore = (primaryRoot: string): SessionStore => {
    let cached = sessionStoreCache.get(primaryRoot)
    if (!cached) {
      cached = new SessionStore(primaryRoot)
      sessionStoreCache.set(primaryRoot, cached)
    }
    return cached
  }

  /**
   * Return the appropriate SessionStore for the current context.
   * Uses the workspace's primary project path (workspace-based isolation) when a workspace is active.
   */
  const getActiveSessionStore = (): SessionStore => {
    const workspace = agentLoop.activeWorkspace
    if (workspace) {
      const primaryRoot = workspace.projects[0]?.path ?? workspaceManager.getWorkspaceRoot() ?? process.cwd()
      return getCachedSessionStore(primaryRoot)
    }
    return sessionStore
  }

  /**
   * Resolve the appropriate SessionStore for a mobile request.
   * If activeWorkspaceId is provided, look up the workspace and use its primary project root.
   * Falls back to agentLoop.activeWorkspace, then workspace store.
   */
  const getStoreForMobile = async (activeWorkspaceId: string | null): Promise<SessionStore> => {
    if (activeWorkspaceId) {
      const task = await workspaceStore.getWorkspace(activeWorkspaceId).catch(() => null)
      if (task) {
        const primaryRoot = task.projects[0]?.path ?? workspaceManager.getWorkspaceRoot() ?? process.cwd()
        return getCachedSessionStore(primaryRoot)
      }
    }
    // 手机未指定 workspaceId 时，使用 sessionStore（跟随桌面 workspace 切换更新），
    // 而非 getActiveSessionStore()（可能引用过期的 agentLoop.activeWorkspace）。
    return sessionStore
  }

  // Helper: broadcast to mobile via relay
  const broadcastToMobile = (event: string, data: unknown) => {
    relayClient.broadcast(event, data)
  }

  sessionTaskStates.onChanged((state) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC_CHANNELS['session:task_status_changed'], state)
    }
    broadcastToMobile('session:task_status', state)
  })

  const persistRuntimeDelta = async (sessionId: string, runtime: AgentLoop, reason: string): Promise<number> => {
    const run = async () => {
      const activeStore = getActiveSessionStore()
      const allMsgs = runtime.getMessages()
      const persistedCount = mobilePersistedMessageCounts.get(sessionId) ?? 0
      const newMessages = allMsgs.slice(persistedCount)
      if (newMessages.length > 0) {
        await activeStore.appendMessages(sessionId, newMessages)
        mobilePersistedMessageCounts.set(sessionId, allMsgs.length)
        sessionTaskStates.update(sessionId, { persistedMessageCount: allMsgs.length, message: reason })
      }
      return allMsgs.length
    }
    const pending = mobilePersistLocks.get(sessionId) ?? Promise.resolve()
    const next = pending.catch(() => {}).then(run)
    mobilePersistLocks.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  // 订阅 running 状态变化，推送给渲染进程 + 手机端（Phase B: session:running_changed）
  runtimes.onRunningChanged((sessionId, isRunning) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC_CHANNELS['session:running_changed'], { sessionId, isRunning })
    }
    broadcastToMobile('stream:agent:running_changed', { sessionId, isRunning })
  })

  // Helper: send workspace info to mobile
  const sendWorkspaceInfoToMobile = async () => {
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot || !sessionStore) return
    try {
      // 与 getStoreForMobile 保持一致：使用 sessionStore（跟随桌面 workspace 切换）
      const sessions = await sessionStore.listSessions()
      // Bug4修复: 优先使用 settingsManager 记录的桌面最后活跃会话，而非手机侧的 mobileSessionId
      broadcastToMobile('session:workspace:info', {
        workspaceName: path.basename(workspaceRoot),
        workspacePath: workspaceRoot,
        activeSessionId: settingsManager.getLastSessionId() ?? mobileSessionId,
        sessionCount: sessions.length
      })
    } catch (err) {
      console.error('[sendWorkspaceInfoToMobile]', err)
    }
  }

  // Dedup set for command:send — prevents relay-replayed messages from running the agent twice.
  // LRU Map with max 1000 entries. Oldest entries pruned on insert.
  const PROCESSED_IDS_MAX = 1000
  const processedMessageIds = new Map<string, number>()

  // Handle mobile client commands — agent (from relay)
  const handleClientMessage = async (msg: { clientId: string; event: string; data: Record<string, unknown> }) => {
    console.log('[handleClientMessage]', msg.clientId, msg.event, JSON.stringify(msg.data)?.substring(0, 200))
    try {

    // -- Session sync: list sessions --
    if (msg.event === 'session:list:request') {
      const requestId = msg.data?.requestId ?? ''
      const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
      const store = await getStoreForMobile(activeWorkspaceId)
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot || !store) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const sessions = await store.listSessions()
        // Enrich sessions with todo summary
        const runningIds = runtimes.listRunning()
        const taskStatuses = sessionTaskStates.snapshot()
        const { TodoWriteTool } = await import('../tools/todo-write')
        for (const session of sessions) {
          session.isRunning = runningIds.includes(session.id)
          session.taskStatus = sessionTaskStates.get(session.id) ?? undefined
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
          } catch { /* ignore */ }
        }
        broadcastToMobile('session:list:response', {
          requestId,
          workspaceName: path.basename(workspaceRoot),
          workspacePath: workspaceRoot,
          sessions,
          runningSessionIds: runningIds,
          taskStatuses,
          activeSessionId: settingsManager.getLastSessionId() ?? null
        })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: load session messages (with pagination) --
    if (msg.event === 'session:load:request') {
      const data = (msg.data ?? {}) as Record<string, unknown>
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const offset = typeof data.offset === 'number' && Number.isFinite(data.offset) ? data.offset : 0
      const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : 50
      const activeWorkspaceId = typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : null
      const store = await getStoreForMobile(activeWorkspaceId)
      if (!store) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const rawMessages = await store.loadSession(sessionId)
        const showToolSteps = settingsManager.getShowToolSteps()
        const allMessages = showToolSteps
          ? rawMessages
          : rawMessages
              .filter(message => message.role !== 'tool_result')
              .map(message => {
                if (message.role !== 'assistant' || !message.toolCalls) return message
                const { toolCalls: _toolCalls, ...rest } = message
                return rest
              })
        const total = allMessages.length
        const sliced = allMessages.slice(offset, offset + limit)
        broadcastToMobile('session:load:response', {
          requestId,
          sessionId,
          messages: sliced,
          total,
          offset,
          hasMore: (offset + limit) < total
        })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'SESSION_NOT_FOUND' })
      }
      return
    }

    // -- Session sync: create session --
    if (msg.event === 'session:create:request') {
      const requestId = msg.data?.requestId ?? ''
      const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
      const store = await getStoreForMobile(activeWorkspaceId)
      if (!store) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const title = msg.data?.title || 'New Session'
        const sessionId = crypto.randomUUID()
        // Create the session file with a meta line
        const metaLine = JSON.stringify({ type: 'meta', title }) + '\n'
        // fsp imported at top
        const sessionPath = path.join(
          store.sessionDir,
          `${sessionId}.jsonl`
        )
        await fsp.writeFile(sessionPath, metaLine, 'utf-8')
        broadcastToMobile('session:create:response', {
          requestId,
          session: { id: sessionId, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
        })
        // 通知桌面渲染器：手机端创建了新会话
        const wcCreate = BrowserWindow.getAllWindows()[0]?.webContents
        if (wcCreate && !wcCreate.isDestroyed()) wcCreate.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'created', data: { sessionId } })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: delete session --
    if (msg.event === 'session:delete:request') {
      const requestId = msg.data?.requestId ?? ''
      const sessionId = msg.data?.sessionId
      const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
      const store = await getStoreForMobile(activeWorkspaceId)
      if (!store || !sessionId) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace or session ID', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const success = await store.deleteSession(sessionId)
        if (success) {
          mobilePersistedMessageCounts.delete(sessionId)
          stepManager.clearSession(sessionId)
        }
        broadcastToMobile('session:delete:response', { requestId, success })
        // Notify desktop renderer
        const wcDel = BrowserWindow.getAllWindows()[0]?.webContents
        if (wcDel && !wcDel.isDestroyed()) wcDel.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'deleted', data: { sessionId } })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: rename session --
    if (msg.event === 'session:rename:request') {
      const requestId = msg.data?.requestId ?? ''
      const sessionId = msg.data?.sessionId
      const title = msg.data?.title
      const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
      const store = await getStoreForMobile(activeWorkspaceId)
      if (!store || !sessionId || !title) {
        broadcastToMobile('session:error', { requestId, error: 'Missing parameters', code: 'BAD_REQUEST' })
        return
      }
      try {
        const success = await store.renameSession(sessionId, title)
        broadcastToMobile('session:rename:response', { requestId, success })
        // Notify desktop renderer
        const wcRen = BrowserWindow.getAllWindows()[0]?.webContents
        if (wcRen && !wcRen.isDestroyed()) wcRen.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'renamed', data: { sessionId, title } })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: clear session messages --
    if (msg.event === 'session:clear:request') {
      const sessionId = msg.data?.sessionId
      const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
      const store = await getStoreForMobile(activeWorkspaceId)
      if (!store || !sessionId) {
        broadcastToMobile('session:clear:response', { success: false })
        return
      }
      try {
        // 重写 session JSONL 为只含 meta 行
        const sessionPath = path.join(store.sessionDir, `${sessionId}.jsonl`)
        const content = await fsp.readFile(sessionPath, 'utf-8').catch(() => '')
        const metaLine = content.split('\n').find(l => {
          try { return JSON.parse(l).type === 'meta' } catch { return false }
        })
        await fsp.writeFile(sessionPath, metaLine ? metaLine + '\n' : '', 'utf-8')
        mobilePersistedMessageCounts.delete(sessionId)
        stepManager.clearSession(sessionId)
        broadcastToMobile('session:clear:response', { success: true })
      } catch {
        broadcastToMobile('session:clear:response', { success: false })
      }
      return
    }

    // -- Workspace: list recent workspaces --
    // -- Workspace: switch to a different workspace --
    if (msg.event === 'workspace:switch:request') {
      const requestId = msg.data?.requestId ?? ''
      const workspacePath = msg.data?.workspacePath
      if (!workspacePath) {
        broadcastToMobile('session:error', { requestId, error: 'Missing workspacePath', code: 'BAD_REQUEST' })
        return
      }
      try {
        if (!fs.existsSync(workspacePath)) {
          broadcastToMobile('workspace:switch:response', { requestId, success: false, error: 'Path does not exist' })
          return
        }
        // Trigger workspace open — reuses the existing onWorkspaceOpened flow
        workspaceManager.setWorkspaceRoot(workspacePath)
        handleWorkspaceOpened(workspacePath, toolRegistry)
        // 切换工作区：取消所有运行中的会话（workspace 跨会话资源已变）
        runtimes.clear()
        agentLoop.activeWorkspace = null
        agentLoop.reset()
        sessionStore = new SessionStore(workspacePath)
        stepManager.setWorkspaceRoot(workspacePath)
        stepManager.clearAllSteps()
        mobileSessionId = null
        mobilePersistedMessageCounts.clear()
        settingsManager.setLastWorkspacePath(workspacePath)
        sendWorkspaceInfoToMobile()
        broadcastToMobile('workspace:switch:response', {
          requestId,
          success: true,
          workspaceName: path.basename(workspacePath),
        })
      } catch (err: unknown) {
        broadcastToMobile('workspace:switch:response', { requestId, success: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- File browsing: get directory tree --
    if (msg.event === 'file:tree:request') {
      const requestId = msg.data?.requestId ?? ''
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const dirPath = msg.data?.dirPath || workspaceRoot
        const depth = msg.data?.depth || 2
        const nodes = await workspaceManager.getDirectoryTree(dirPath, depth)
        broadcastToMobile('file:tree:response', { requestId, nodes })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- File browsing: read file content --
    if (msg.event === 'file:read:request') {
      const requestId = msg.data?.requestId ?? ''
      const filePath = msg.data?.filePath
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot || !filePath) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace or file path', code: 'BAD_REQUEST' })
        return
      }
      try {
        const resolvedWorkspaceRoot = path.resolve(workspaceRoot)
        const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedWorkspaceRoot, filePath)

        // Security: verify path is within workspace
        if (!isPathWithinWorkspace(resolvedWorkspaceRoot, absolutePath)) {
          broadcastToMobile('session:error', { requestId, error: 'Access denied: path outside workspace', code: 'ACCESS_DENIED' })
          return
        }

        const stat = await fsp.stat(absolutePath)

        // Limit to 500KB for mobile
        if (stat.size > 512000) {
          broadcastToMobile('file:read:response', {
            requestId,
            error: 'File too large',
            size: stat.size,
            filePath
          })
          return
        }

        const content = await fsp.readFile(absolutePath, 'utf-8')

        // Detect language from extension
        const ext = path.extname(absolutePath).slice(1).toLowerCase()
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
          dart: 'dart', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c',
          css: 'css', scss: 'scss', html: 'html', xml: 'xml',
          json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
          md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql',
        }
        const language = langMap[ext] ?? ext

        broadcastToMobile('file:read:response', {
          requestId,
          content,
          language,
          size: stat.size,
          filePath: path.relative(workspaceRoot, absolutePath).replace(/\\\\/g, '/'),
        })
      } catch (err: unknown) {
        broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Plan Mode: mobile approval/rejection --
    if (msg.event === 'plan:decision') {
      planModeController.resolveDecision(msg.data?.approved === true)
      return
    }

    // -- AskUserQuestion: mobile sends back the user's answer --
    if (msg.event === 'ask-user:answer') {
      const answer = msg.data as { questionId: string; selectedLabels: string[]; customText?: string }
      askUserTool.resolveQuestion(answer)
      return
    }

    // -- Permission mode: mobile requests current mode --
    if (msg.event === 'permission:get_mode:request') {
      const requestId = msg.data?.requestId ?? ''
      broadcastToMobile('permission:mode:response', {
        requestId,
        mode: permissionManager.getMode()
      })
      return
    }

    // -- Permission mode: mobile sets a new mode --
    if (msg.event === 'permission:set_mode:request') {
      const requestId = msg.data?.requestId ?? ''
      const mode = msg.data?.mode as string | undefined
      if (mode) {
        try {
          permissionManager.setMode(mode)
        } catch (err: unknown) {
          broadcastToMobile('permission:mode:response', { requestId, error: err instanceof Error ? err.message : String(err) })
          return
        }
      }
      broadcastToMobile('permission:mode:response', {
        requestId,
        mode: permissionManager.getMode()
      })
      return
    }

    // -- Workspace management: list workspaces (with sessions) --
    if (msg.event === 'workspace:list:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const tasks = await workspaceStore.listWorkspaces(msg.data?.includeArchived)
        // 为每个 workspace 附加最近 10 个会话
        const enriched = await Promise.all(tasks.map(async (t) => {
          const root = t.projects?.[0]?.path as string | undefined
          let sessions: SessionMeta[] = []
          if (root) {
            try {
              const ss = getCachedSessionStore(root)
              const all = await ss.listSessions()
              sessions = all
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 10)
            } catch { /* workspace 可能还没有 sessions 目录 */ }
          }
          const workspaceSessionIds = new Set(sessions.map(session => session.id))
          const runningSessionIds = runtimes.listRunning().filter(sessionId => workspaceSessionIds.has(sessionId))
          const taskStatuses = Object.fromEntries(
            Object.entries(sessionTaskStates.snapshot()).filter(([sessionId]) => workspaceSessionIds.has(sessionId))
          )
          return { ...t, sessions, runningSessionIds, taskStatuses }
        }))
        broadcastToMobile('workspace:list:response', { requestId, tasks: enriched })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: create workspace --
    if (msg.event === 'workspace:create:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspace = await workspaceStore.createWorkspace(msg.data?.title ?? 'New Workspace', msg.data?.description)
        broadcastToMobile('workspace:create:response', { requestId, workspace })
        // Notify desktop renderer
        const wc = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'created', data: workspace })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: update workspace --
    if (msg.event === 'workspace:update:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspace = await workspaceStore.updateWorkspace(msg.data?.workspaceId, msg.data?.updates ?? {})
        broadcastToMobile('workspace:update:response', { requestId, workspace })
        const wc = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: delete workspace --
    if (msg.event === 'workspace:delete:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        await workspaceStore.deleteWorkspace(msg.data?.workspaceId)
        broadcastToMobile('workspace:delete:response', { requestId, success: true })
        const wc = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'deleted', data: { workspaceId: msg.data?.workspaceId } })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: get single workspace --
    if (msg.event === 'workspace:get:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspace = await workspaceStore.getWorkspace(msg.data?.workspaceId)
        broadcastToMobile('workspace:get:response', { requestId, workspace })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: add project to workspace --
    if (msg.event === 'workspace:add-project:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspace = await workspaceStore.addProject(msg.data?.workspaceId, msg.data?.folderPath)
        broadcastToMobile('workspace:add-project:response', { requestId, workspace })
        const wc = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Workspace management: remove project from workspace --
    if (msg.event === 'workspace:remove-project:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspace = await workspaceStore.removeProject(msg.data?.workspaceId, msg.data?.projectId)
        broadcastToMobile('workspace:remove-project:response', { requestId, workspace })
        const wc = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
      } catch (err: unknown) {
        broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // -- Agent command: send --
    if (msg.event === 'command:send' && msg.data?.content) {
      // Dedup: skip if we've already processed this messageId (relay replay guard).
      const incomingId = msg.data.messageId as string | undefined
      if (incomingId) {
        const now = Date.now()
        // Bounded LRU cleanup: prune oldest entries when over limit
        if (processedMessageIds.size >= PROCESSED_IDS_MAX) {
          const toDelete = Math.ceil(PROCESSED_IDS_MAX * 0.25)
          let i = 0
          for (const key of processedMessageIds.keys()) {
            if (i++ >= toDelete) break
            processedMessageIds.delete(key)
          }
        }
        if (processedMessageIds.has(incomingId)) {
          broadcastToMobile('command:ack', { messageId: incomingId, status: 'duplicate' })
          return
        }
        processedMessageIds.set(incomingId, now + 10 * 60 * 1000)
      }

      // Slash command preprocessing for mobile
      const trimmed = (msg.data.content as string).trim()
      if (trimmed.startsWith('/')) {
        const spaceIdx = trimmed.indexOf(' ')
        const cmdName = spaceIdx > 0 ? trimmed.substring(1, spaceIdx) : trimmed.substring(1)
        const _cmdArgs = spaceIdx > 0 ? trimmed.substring(spaceIdx + 1).trim() : ''

        switch (cmdName) {
          case 'compact': {
            // Trigger manual context compaction — 仅针对当前手机会话生效
            const compactSid = mobileSessionId
            const compactRuntime = compactSid ? runtimes.getOrCreate(compactSid) : null
            const messages = compactRuntime ? compactRuntime.getMessages() : []
            const compactConfig = settingsManager.getCurrentConfig()
            if (messages.length > 0 && compactRuntime) {
              contextManager.compact(
                messages,
                gateway,
                compactConfig.model,
                compactConfig.provider,
                compactConfig.systemPrompt
              ).then((result) => {
                if (result.summary) {
                  const summaryMsg = {
                    role: 'user' as const,
                    content: `[Context Summary]\n${result.summary}`,
                    timestamp: Date.now()
                  }
                  const recentMessages = messages.slice(-result.keptRecentCount)
                  compactRuntime.replaceMessages([summaryMsg, ...recentMessages])
                }
                const sid = settingsManager.getLastSessionId() ?? mobileSessionId
                broadcastToMobile('stream:agent:done', { usage: null, compacted: true, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens, sessionId: sid })
              }).catch((err: unknown) => {
                broadcastToMobile('stream:error', { error: err instanceof Error ? err.message : String(err) })
              })
            } else {
              const sid = settingsManager.getLastSessionId() ?? mobileSessionId
              broadcastToMobile('stream:agent:done', { usage: null, sessionId: sid })
            }
            return
          }
          case 'clear': {
            // Discard the mobile-current session runtime and start fresh on next send
            if (mobileSessionId) {
              stepManager.clearSession(mobileSessionId)
              runtimes.delete(mobileSessionId)
              // runtime 已销毁，必须同步清除持久化计数，避免下次 send 时 counter 与新 runtime 不一致
              mobilePersistedMessageCounts.delete(mobileSessionId)
            }
            mobileSessionId = null
            broadcastToMobile('session:create:response', { success: true })
            return
          }
          case 'init': {
            // Replace content with the /init prompt, continue to agentLoop.run()
            msg.data.content = `Please analyze this codebase and create a WZXCLAW.md file in the project root.\n\nFirst, explore the project to understand:\n- Package manager and key scripts\n- README and existing documentation\n- Directory structure and main source directories\n- Test setup and how to run tests\n- Any existing instruction files\n\nThen create WZXCLAW.md with ONLY:\n1. Build & Dev Commands (non-obvious only)\n2. Architecture Overview (3-5 sentences)\n3. Key Conventions (differs from defaults)\n4. Development Notes (gotchas, setup)\n\nKeep it under 100 lines. If WZXCLAW.md exists, suggest improvements.`
            break
          }
          case 'commit': {
            msg.data.content = `Analyze the current git changes and create a commit. Look at \`git status\` and \`git diff\` to understand what changed, then stage and commit with an appropriate message. Do NOT push.`
            break
          }
          case 'review': {
            msg.data.content = `Review the current git diff for code quality issues, bugs, and improvements. Run \`git diff\` to see the changes, then provide a thorough code review.`
            break
          }
          case 'help': {
            const sid0 = settingsManager.getLastSessionId() ?? mobileSessionId
            broadcastToMobile('stream:agent:text', { content: `**可用命令：**\n\n- /help — 显示此帮助\n- /init — 分析代码库并创建 WZXCLAW.md\n- /compact — 压缩上下文\n- /context — 查看上下文使用情况\n- /clear — 新建会话\n- /commit — 分析 git 变更并提交\n- /review — 代码审查\n- /insights — 生成代码洞察`, sessionId: sid0 })
            broadcastToMobile('stream:agent:done', { usage: { inputTokens: 0, outputTokens: 0 }, turnCount: 0, sessionId: sid0 })
            return
          }
          case 'context': {
            const sid1 = settingsManager.getLastSessionId() ?? mobileSessionId
            const totalUsage = contextManager.getTotalUsage()
            const history = contextManager.getCompactHistory()
            broadcastToMobile('stream:agent:text', { content: `**上下文使用情况：**\n\n- 输入 tokens: ${totalUsage.inputTokens}\n- 输出 tokens: ${totalUsage.outputTokens}\n- 历史压缩次数: ${history.count}${history.lastBefore != null ? `\n- 上次压缩: ${history.lastBefore} → ${history.lastAfter} tokens` : ''}`, sessionId: sid1 })
            broadcastToMobile('stream:agent:done', { usage: { inputTokens: 0, outputTokens: 0 }, turnCount: 0, sessionId: sid1 })
            return
          }
          case 'insights': {
            msg.data.content = `Analyze the codebase and provide insights about code quality, potential issues, and improvement opportunities. Look at the project structure, key files, and recent changes.`
            break
          }
          // Unknown commands pass through as regular text
        }
      }

      // Use session ID from mobile, or generate one for this mobile conversation
      const requestedSessionId = typeof msg.data.sessionId === 'string' && msg.data.sessionId.length > 0
        ? msg.data.sessionId
        : null
      // Per-session runtime 下，不同 sessionId 自然隔离，不再需要 reset-context 语义。
      // 仅保留 sessionId 生成逻辑。
      const sessionTransition = getMobileSessionTransition({
        requestedSessionId,
        activeSessionId: mobileSessionId ?? settingsManager.getLastSessionId(),
        hasMessages: false,
        generatedSessionId: crypto.randomUUID(),
      })
      const sessionId = sessionTransition.sessionId
      const runId = crypto.randomUUID()
      mobileSessionId = sessionId
      stepManager.setActiveSession(sessionId)
      const toolCallInputs = new Map<string, Record<string, unknown>>()

      const config = settingsManager.getCurrentConfig()
      // Ensure LLM adapter is registered (matches ipc-handlers.ts logic)
      if (config.apiKey) {
        gateway.addProvider({
          provider: config.provider as 'openai' | 'anthropic',
          apiKey: config.apiKey,
          baseURL: config.baseURL,
        })
        // If model requires a different provider, add cross-adapter (e.g. glm-4-plus needs openai)
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
            baseURL: crossBaseURL,
          })
        }
      }
      const agentConfig: AgentConfig = {
        model: config.model,
        provider: config.provider as 'openai' | 'anthropic',
        systemPrompt: config.systemPrompt,
        workingDirectory,
        projectRoots: agentLoop.activeWorkspace
          ? agentLoop.activeWorkspace.projects.map(p => p.path)
          : [workingDirectory],
        conversationId: sessionId,
        thinkingDepth: config.thinkingDepth as 'none' | 'low' | 'medium' | 'high' | undefined,
      }

      sessionTaskStates.start(sessionId, runId, '收到手机端任务')

      // Broadcast the assigned session ID back to mobile so it can track it
      broadcastToMobile('session:active', { sessionId })

      // If resuming an existing mobile session, restore chat history into the per-session runtime
      if (sessionTransition.shouldRestoreHistory) {
        try {
          const activeStore = getActiveSessionStore()
          const rawMessages = await activeStore.loadSession(sessionId)
          if (rawMessages.length > 0) {
            await runtimes.getOrCreate(sessionId).restoreContext(rawMessages, agentConfig)
          }
          // Restore steps from disk into memory for this session
          await stepManager.loadSessionSteps(sessionId)
          mobilePersistedMessageCounts.set(sessionId, rawMessages.length)
        } catch {
          mobilePersistedMessageCounts.set(sessionId, 0)
        }
      }

      // 只有移动端会话与桌面当前会话相同时，才将用户消息和流式事件转发到渲染器。
      // 若不同会话，渲染器展示的是桌面会话内容，移动端的回答不应干扰其显示。
      const desktopCurrentSessionId = settingsManager.getLastSessionId()
      const shouldForwardToRenderer = !desktopCurrentSessionId || desktopCurrentSessionId === sessionId

      // Send the mobile user's message to renderer so it appears in the chat (same-session only)
      if (shouldForwardToRenderer) {
        const wc0 = BrowserWindow.getAllWindows()[0]?.webContents
        if (wc0) {
          wc0.send(IPC_CHANNELS['stream:mobile_user_message'], {
            content: msg.data.content,
            source: 'mobile',
            sessionId,
          })
        }
      }

      // Acknowledge receipt back to mobile.
      const messageId = msg.data.messageId || crypto.randomUUID()
      broadcastToMobile('command:ack', { messageId, status: 'received' })

      try {
        // Mobile sender: forwards stream:retrying to mobile alongside the renderer
        const wcForMobile = BrowserWindow.getAllWindows()[0]?.webContents
        const mobileSender = {
          isDestroyed: () => wcForMobile?.isDestroyed() ?? true,
          send: (channel: string, ...args: unknown[]) => {
            const showToolSteps = settingsManager.getShowToolSteps()
            // 仅在手机会话与桌面当前会话一致时，才将次要事件（retrying/sub-tool/ask-user）推给渲染器。
            if (shouldForwardToRenderer && wcForMobile && !wcForMobile.isDestroyed()) {
              // Skip tool step events to renderer when showToolSteps is off
              const isToolChannel = channel === IPC_CHANNELS['stream:tool_use_start'] || channel === IPC_CHANNELS['stream:tool_use_end'] || channel === IPC_CHANNELS['stream:thinking_delta'] || channel === IPC_CHANNELS['stream:sub_tool_use_start'] || channel === IPC_CHANNELS['stream:sub_tool_use_end'] || channel === IPC_CHANNELS['stream:sub_text']
              if (showToolSteps || !isToolChannel) {
                wcForMobile.send(channel, ...args)
              }
            }
            if (channel === IPC_CHANNELS['stream:retrying']) {
              if (showToolSteps) relayClient.broadcast('stream:retrying', args[0] ?? {})
            }
            if (channel === IPC_CHANNELS['agent:permission_request']) {
              sessionTaskStates.update(sessionId, { status: 'waiting_permission', phase: 'permission', message: '等待权限确认' })
            }
            if (channel === IPC_CHANNELS['ask-user:question']) {
              sessionTaskStates.update(sessionId, { status: 'waiting_user', phase: 'ask_user', message: '等待用户回答' })
              relayClient.broadcast('stream:agent:ask_user_question', { ...(args[0] as Record<string, unknown> | undefined), sessionId })
            }
            if (channel === IPC_CHANNELS['stream:sub_tool_use_start']) {
              if (showToolSteps) relayClient.broadcast('stream:sub:tool_call', args[0] ?? {})
            }
            if (channel === IPC_CHANNELS['stream:sub_tool_use_end']) {
              if (showToolSteps) relayClient.broadcast('stream:sub:tool_result', args[0] ?? {})
            }
            if (channel === IPC_CHANNELS['stream:sub_text']) {
              if (showToolSteps) relayClient.broadcast('stream:sub:text', args[0] ?? {})
            }
          }
        } as unknown as Electron.WebContents

        // Inject active workspace context from mobile message
        if (msg.data.activeWorkspaceId) {
          const workspace = await workspaceStore.getWorkspace(msg.data.activeWorkspaceId)
          agentLoop.activeWorkspace = workspace ?? null
        } else {
          agentLoop.activeWorkspace = null
        }

        // 取出 per-session runtime 并同步当前 workspace。
        const runtime = runtimes.getOrCreate(sessionId)
        runtime.activeWorkspace = agentLoop.activeWorkspace

        // 并发保护：仅在同一 sessionId 上重发时取消上一次；
        // 不再跨会话 cancel 全局，让多会话可并发运行。
        if (runtime.isRunning) {
          runtime.cancel()
          await new Promise(r => setTimeout(r, 0))
        }

        runtimes.notifyRunningChanged(sessionId, true)
        let sawFirstEvent = false
        let sawDone = false
        let lastAgentError: { error: string; recoverable: boolean } | null = null
        try {
        for await (const agentEvent of runtime.run(msg.data.content, agentConfig, mobileSender)) {
          if (!sawFirstEvent) {
            sawFirstEvent = true
            sessionTaskStates.update(sessionId, { status: 'running', phase: 'streaming', message: 'AI 正在生成' })
            await persistRuntimeDelta(sessionId, runtime, '已保存用户消息')
          }
          // Forward stream events to renderer — only when mobile session matches desktop's current session
          const wc = shouldForwardToRenderer ? BrowserWindow.getAllWindows()[0]?.webContents : null
          if (!wc) {
            switch (agentEvent.type) {
              case 'agent:tool_call':
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_call', message: `正在执行 ${agentEvent.toolName}` })
                break
              case 'agent:tool_result':
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_result', message: `${agentEvent.toolName} 执行完成` })
                break
              case 'agent:error':
                lastAgentError = { error: agentEvent.error, recoverable: agentEvent.recoverable }
                sessionTaskStates.update(sessionId, { status: 'running', phase: agentEvent.recoverable ? 'recoverable_error' : 'error', message: agentEvent.error, error: agentEvent.error, recoverable: agentEvent.recoverable })
                break
              case 'agent:turn_end':
                await persistRuntimeDelta(sessionId, runtime, '已保存完整轮次')
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'turn_end', message: '轮次已保存' })
                break
              case 'agent:done': {
                sawDone = true
                try {
                  const persistedMessageCount = await persistRuntimeDelta(sessionId, runtime, '任务完成，历史已保存')
                  sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成', persistedMessageCount })
                } catch (saveErr) {
                  console.error('[mobile] Failed to persist session:', saveErr)
                  sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成（保存历史时出错）' })
                }
                cleanupToolResults(sessionId).catch(() => {})
                // 注意：不要在此清除 mobilePersistedMessageCounts —— runtime 仍保留全部消息，
                // 同一 session 下次 send 若 counter 归零，会导致整段历史被再次追加（重复持久化 bug）。
                // 计数器仅在 runtime 被销毁/会话切换/clear/delete 时重置。
                break
              }
            }
          }
          if (wc) {
            switch (agentEvent.type) {
              case 'agent:text':
                wc.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content, sessionId })
                break
              case 'agent:thinking':
                wc.send(IPC_CHANNELS['stream:thinking_delta'], { content: agentEvent.content, sessionId })
                break
              case 'agent:tool_call':
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_call', message: `正在执行 ${agentEvent.toolName}` })
                toolCallInputs.set(agentEvent.toolCallId, agentEvent.input)
                wc.send(IPC_CHANNELS['stream:tool_use_start'], {
                  id: agentEvent.toolCallId,
                  name: agentEvent.toolName,
                  input: agentEvent.input,
                  sessionId,
                })
                break
              case 'agent:tool_result':
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_result', message: `${agentEvent.toolName} 执行完成` })
                wc.send(IPC_CHANNELS['stream:tool_use_end'], { id: agentEvent.toolCallId, output: agentEvent.output, isError: agentEvent.isError, toolName: agentEvent.toolName, sessionId })
                // Forward file changes for write tools (same as ipc-handlers path)
                if (!agentEvent.isError && (agentEvent.toolName === 'FileWrite' || agentEvent.toolName === 'FileEdit')) {
                  const tc = toolCallInputs.get(agentEvent.toolCallId)
                  const filePath = tc?.path as string | undefined
                  if (filePath) {
                    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(agentConfig.workingDirectory, filePath)
                    wc.send(IPC_CHANNELS['file:changed'], { filePath: absolutePath, changeType: 'modified' })
                  }
                }
                toolCallInputs.delete(agentEvent.toolCallId)
                break
              case 'agent:error':
                lastAgentError = { error: agentEvent.error, recoverable: agentEvent.recoverable }
                sessionTaskStates.update(sessionId, { status: 'running', phase: agentEvent.recoverable ? 'recoverable_error' : 'error', message: agentEvent.error, error: agentEvent.error, recoverable: agentEvent.recoverable })
                wc.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error, sessionId })
                break
              case 'agent:turn_end':
                wc.send(IPC_CHANNELS['stream:turn_end'], { sessionId })
                await persistRuntimeDelta(sessionId, runtime, '已保存完整轮次')
                sessionTaskStates.update(sessionId, { status: 'running', phase: 'turn_end', message: '轮次已保存' })
                break
              case 'agent:done':
                sawDone = true
                wc.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage, sessionId })
                // Agent 完成通知（声音 + 桌面通知）
                try {
                  const isFocused = BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
                  notificationService.notify(isFocused, 'wzxClaw', 'AI 任务已完成')
                } catch {}
                // Persist mobile messages before announcing terminal completion.
                try {
                  const persistedMessageCount = await persistRuntimeDelta(sessionId, runtime, '任务完成，历史已保存')
                  sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成', persistedMessageCount })
                } catch (saveErr) {
                  console.error('[mobile] Failed to persist session:', saveErr)
                  sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成（保存历史时出错）' })
                }
                // 清理该会话的工具结果磁盘文件
                cleanupToolResults(sessionId).catch(() => {})
                // 注意：不要在此清除 mobilePersistedMessageCounts —— runtime 仍保留全部消息，
                // 同一 session 下次 send 若 counter 归零，会导致整段历史被再次追加（重复持久化 bug）。
                // 计数器仅在 runtime 被销毁/会话切换/clear/delete 时重置。
                break
              case 'agent:compacted':
                wc.send(IPC_CHANNELS['session:compacted'], {
                  beforeTokens: agentEvent.beforeTokens,
                  afterTokens: agentEvent.afterTokens,
                  auto: agentEvent.auto
                })
                break
            }
          }
          // 串台修复: 在所有流式事件中携带 sessionId，手机端可据此过滤非当前会话的事件
          // When showToolSteps is off, skip tool step events for mobile
          const isToolStepEvent = agentEvent.type === 'agent:tool_call' || agentEvent.type === 'agent:tool_result'  // thinking is NOT a tool step — always broadcast
          if (isToolStepEvent && !settingsManager.getShowToolSteps()) {
            // Skip broadcasting tool step events to mobile
          } else {
            relayClient.broadcast(`stream:${agentEvent.type}`, { ...agentEvent, sessionId })
          }
          // Forward TodoWrite structured todo list to mobile
          if (agentEvent.type === 'agent:tool_result' && agentEvent.toolName === 'TodoWrite' && !agentEvent.isError) {
            const todoTool = toolRegistry.get('TodoWrite') as { getCurrentTodos?: () => unknown[] } | undefined
            if (todoTool?.getCurrentTodos) {
              broadcastToMobile('todo:updated', { todos: todoTool.getCurrentTodos() })
            }
          }
        }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          try {
            const persistedMessageCount = await persistRuntimeDelta(sessionId, runtime, '异常结束，已保存可用历史')
            sessionTaskStates.finish(sessionId, 'failed', { message, error: message, recoverable: false, persistedMessageCount })
          } catch {}
          throw err
        } finally {
          if (!sawDone) {
            const currentStatus = sessionTaskStates.get(sessionId)?.status
            if (currentStatus === 'stopping') {
              try {
                const persistedMessageCount = await persistRuntimeDelta(sessionId, runtime, '任务已停止，历史已保存')
                sessionTaskStates.finish(sessionId, 'cancelled', { message: '任务已停止', persistedMessageCount })
              } catch {
                sessionTaskStates.finish(sessionId, 'cancelled', { message: '任务已停止（保存历史时出错）' })
              }
            } else if (lastAgentError && !lastAgentError.recoverable) {
              try {
                const persistedMessageCount = await persistRuntimeDelta(sessionId, runtime, '任务失败，历史已保存')
                sessionTaskStates.finish(sessionId, 'failed', { message: lastAgentError.error, error: lastAgentError.error, recoverable: false, persistedMessageCount })
              } catch {
                sessionTaskStates.finish(sessionId, 'failed', { message: lastAgentError.error, error: lastAgentError.error, recoverable: false })
              }
            } else if (currentStatus && isActiveSessionTaskStatus(currentStatus)) {
              sessionTaskStates.finish(sessionId, 'interrupted', { message: '任务异常中断' })
            }
          }
          runtimes.notifyRunningChanged(sessionId, false)
          mobilePersistLocks.delete(sessionId)
        }
      } catch (err: unknown) {
        relayClient.broadcast('stream:error', { error: err instanceof Error ? err.message : String(err), sessionId: mobileSessionId })
      }
      return
    }

    if (msg.event === 'command:stop') {
      // 仅取消当前手机会话（不会跨会话误杀）
      const stopSessionId = typeof msg.data?.sessionId === 'string' ? msg.data.sessionId : mobileSessionId
      if (stopSessionId) {
        sessionTaskStates.update(stopSessionId, { status: 'stopping', phase: 'stopping', message: '正在停止' })
        runtimes.cancel(stopSessionId)
      }
    }
    } catch (topErr: unknown) {
      console.error('[handleClientMessage] UNCAUGHT ERROR:', topErr)
    }
  }

  relayClient.on('client-message', handleClientMessage)

  // Send workspace info when mobile connects/reconnects via relay
  relayClient.on('mobile-connected', async () => {
    sendWorkspaceInfoToMobile()
    // 也推送工作区列表，让手机端能同步最新工作区状态（使用 WorkspaceStore 而非 recentWorkspaces 历史）
    try {
      const tasks = await workspaceStore.listWorkspaces()
      const enriched = await Promise.all(tasks.map(async (t) => {
        const root = t.projects?.[0]?.path as string | undefined
        let sessions: SessionMeta[] = []
        if (root) {
          try {
            const ss = getCachedSessionStore(root)
            const all = await ss.listSessions()
            sessions = all
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 10)
          } catch { /* workspace 可能还没有 sessions 目录 */ }
        }
        const workspaceSessionIds = new Set(sessions.map(session => session.id))
        const runningSessionIds = runtimes.listRunning().filter(sessionId => workspaceSessionIds.has(sessionId))
        const taskStatuses = Object.fromEntries(
          Object.entries(sessionTaskStates.snapshot()).filter(([sessionId]) => workspaceSessionIds.has(sessionId))
        )
        return { ...t, sessions, runningSessionIds, taskStatuses }
      }))
      broadcastToMobile('workspace:list:response', { requestId: '', tasks: enriched })
    } catch {}
    // 广播所有正在运行的会话状态，让手机端同步“其他会话仍在跑”的跟踪
    for (const sid of runtimes.listRunning()) {
      broadcastToMobile('stream:agent:running', {
        sessionId: sid,
        messageCount: runtimes.getOrCreate(sid).getMessages().length,
      })
    }
    for (const state of sessionTaskStates.listActive()) {
      broadcastToMobile('session:task_status', state)
    }
  })


  return {
    getActiveSessionStore,
    getCachedSessionStore,
    sendWorkspaceInfoToMobile,
    broadcastToMobile,
    sessionTaskStates,
    getMobileSessionId: () => mobileSessionId,
    setMobileSessionId: (id: string | null) => { mobileSessionId = id },
  }
} // end of registerMobileRelayHandler
