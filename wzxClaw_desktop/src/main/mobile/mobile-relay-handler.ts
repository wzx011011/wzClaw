// ============================================================
// Mobile Relay Handler — 移动端 Relay 消息编排器
// 从 index.ts 拆分，编排所有来自 Android 伴侣的 relay 消息
// 具体处理逻辑分散到 domain handler 模块中
// ============================================================

import path from 'path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { RelayClient } from './relay-client'
import type { SessionRuntimeManager } from '../agent/session-runtime-manager'
import { SessionTaskStateManager } from '../agent/session-task-state-manager'
import type { PermissionManager } from '../permission/permission-manager'
import type { SettingsManager } from '../settings-manager'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-store'
import type { SessionStore, SessionMeta } from '../persistence/session-store'
import { SessionStoreManager } from '../persistence/session-store-manager'
import type { ToolRegistry } from '../tools/tool-registry'
import type { ContextManager } from '../context/context-manager'
import type { PlanModeController } from '../tools/plan-mode'
import type { AgentLoop } from '../agent/agent-loop'
import type { LLMGateway } from '../llm/gateway'
import type { StepManager } from '../steps/step-manager'
import type { NotificationService } from '../notification/notification-service'
import type { AskUserQuestionTool } from '../tools/ask-user'
import { cleanupToolResults } from '../context/tool-result-storage'
import { getMobileSessionTransition, isPathWithinWorkspace } from './mobile-session-utils'
import type { MobileRelayContext } from './mobile-relay-context'
import { handleSessionMessage } from './mobile-session-handlers'
import { handleWorkspaceMessage } from './mobile-workspace-handlers'
import { handleFileMessage } from './mobile-file-handlers'
import { handleAgentMessage } from './mobile-agent-handler'

export interface MobileRelayDeps {
  relayClient: RelayClient
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
  // 外部依赖（原闭包变量，现通过 deps 传入）
  gateway: LLMGateway
  stepManager: StepManager
  notificationService: NotificationService
  askUserTool: AskUserQuestionTool
  /** 工作区打开后的初始化回调 */
  handleWorkspaceOpened: (rootPath: string, toolRegistry: ToolRegistry) => void
  /** 获取当前工作目录 */
  getWorkingDirectory: () => string
}

/**
 * Register the mobile relay handler and all related event listeners.
 * Returns an object with helper functions needed by the caller.
 */
export function registerMobileRelayHandler(deps: MobileRelayDeps): {
  getActiveSessionStore: () => SessionStore
  getCachedSessionStore: (primaryRoot: string) => SessionStore  // deprecated, use storeManager
  sendWorkspaceInfoToMobile: () => Promise<void>
  broadcastToMobile: (event: string, data: unknown) => void
  sessionTaskStates: SessionTaskStateManager
  getMobileSessionId: () => string | null
  setMobileSessionId: (id: string | null) => void
} {
  const {
    relayClient,
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
    gateway,
    stepManager,
    notificationService,
    askUserTool,
    handleWorkspaceOpened,
    getWorkingDirectory,
  } = deps

  // ── 可变状态（对象包装，跨 handler 模块共享） ──
  const sessionStoreRef: { value: SessionStore } = { value: undefined as unknown as SessionStore }
  const mobileSessionId = { value: null as string | null }
  const mobilePersistedMessageCounts = new Map<string, number>()
  const mobilePersistLocks = new Map<string, Promise<void>>()
  const processedMessageIds = new Map<string, number>()
  // Centralized SessionStore cache — eliminates repeated new SessionStore + mkdirSync
  const storeManager = new SessionStoreManager()

  /**
   * Return the appropriate SessionStore for the current context.
   * Uses the workspace's primary project path (workspace-based isolation) when a workspace is active.
   */
  const getActiveSessionStore = (): SessionStore => {
    const lastId = settingsManager.getLastSessionId()
    if (lastId) {
      const rt = runtimes.getOrCreate(lastId)
      if (rt.activeWorkspace) {
        const primaryRoot = rt.activeWorkspace.projects[0]?.path ?? workspaceManager.getWorkspaceRoot() ?? process.cwd()
        return storeManager.getForRoot(primaryRoot)
      }
    }
    return sessionStoreRef.value
  }

  /**
   * Resolve the appropriate SessionStore for a mobile request.
   * If activeWorkspaceId is provided, look up the workspace and use its primary project root.
   * Falls back to sessionStore (follows desktop workspace switching).
   */
  const getStoreForMobile = async (activeWorkspaceId: string | null): Promise<SessionStore> => {
    if (activeWorkspaceId) {
      return storeManager.getForWorkspace(activeWorkspaceId, workspaceManager, workspaceStore)
    }
    return sessionStoreRef.value
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
    if (!workspaceRoot || !sessionStoreRef.value) return
    try {
      // 与 getStoreForMobile 保持一致：使用 sessionStore（跟随桌面 workspace 切换）
      const sessions = await sessionStoreRef.value.listSessions()
      // Bug4修复: 优先使用 settingsManager 记录的桌面最后活跃会话，而非手机侧的 mobileSessionId
      broadcastToMobile('session:workspace:info', {
        workspaceName: path.basename(workspaceRoot),
        workspacePath: workspaceRoot,
        activeSessionId: settingsManager.getLastSessionId() ?? mobileSessionId.value,
        sessionCount: sessions.length
      })
    } catch (err) {
      console.error('[sendWorkspaceInfoToMobile]', err)
    }
  }

  // ── 构建共享上下文 ──
  const ctx: MobileRelayContext = {
    relayClient,
    runtimes,
    sessionTaskStates,
    permissionManager,
    settingsManager,
    workspaceManager,
    workspaceStore,
    toolRegistry,
    contextManager,
    planModeController,
    storeManager,
    gateway,
    stepManager,
    notificationService,
    askUserTool,
    cleanupToolResults,
    isPathWithinWorkspace,
    getMobileSessionTransition,
    handleWorkspaceOpened,
    getWorkingDirectory,
    setSessionStore: (store: SessionStore) => {
      sessionStoreRef.value = store
      setSessionStore(store)
    },
    mobileSessionId,
    mobilePersistedMessageCounts,
    mobilePersistLocks,
    sessionStore: sessionStoreRef,
    processedMessageIds,
    broadcastToMobile,
    sendWorkspaceInfoToMobile,
    getActiveSessionStore,
    getStoreForMobile,
    persistRuntimeDelta,
  }

  // Handle mobile client commands — agent (from relay)
  const handleClientMessage = async (msg: { clientId: string; event: string; data: Record<string, unknown> }) => {
    console.log('[handleClientMessage]', msg.clientId, msg.event, JSON.stringify(msg.data)?.substring(0, 200))
    try {
      // 路由到各 domain handler
      if (await handleSessionMessage(msg, ctx)) return
      if (await handleWorkspaceMessage(msg, ctx)) return
      if (await handleFileMessage(msg, ctx)) return
      if (await handleAgentMessage(msg, ctx)) return
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
            const ss = storeManager.getForRoot(root)
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
    // 广播所有正在运行的会话状态，让手机端同步"其他会话仍在跑"的跟踪
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
    getCachedSessionStore: (root: string) => storeManager.getForRoot(root),
    sendWorkspaceInfoToMobile,
    broadcastToMobile,
    sessionTaskStates,
    getMobileSessionId: () => mobileSessionId.value,
    setMobileSessionId: (id: string | null) => { mobileSessionId.value = id },
  }
} // end of registerMobileRelayHandler
