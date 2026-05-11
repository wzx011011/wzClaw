// ============================================================
// MobileRelayContext — 移动端 Relay 处理器共享上下文
// 包含所有处理器模块共享的状态和辅助函数类型定义
// ============================================================

import type { RelayClient } from './relay-client'
import type { SessionRuntimeManager } from '../agent/session-runtime-manager'
import type { SessionTaskStateManager } from '../agent/session-task-state-manager'
import type { PermissionManager } from '../permission/permission-manager'
import type { SettingsManager } from '../settings-manager'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-store'
import type { SessionStore } from '../persistence/session-store'
import type { SessionStoreManager } from '../persistence/session-store-manager'
import type { ToolRegistry } from '../tools/tool-registry'
import type { ContextManager } from '../context/context-manager'
import type { PlanModeController } from '../tools/plan-mode'
import type { AgentLoop } from '../agent/agent-loop'
import type { LLMGateway } from '../llm/gateway'
import type { StepManager } from '../steps/step-manager'
import type { NotificationService } from '../notification/notification-service'
import type { AskUserQuestionTool } from '../tools/ask-user'

/**
 * 移动端 Relay 处理器的共享上下文。
 * 所有 handler 模块通过此接口访问共享状态和依赖。
 */
export interface MobileRelayContext {
  // ── 核心依赖 ──
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
  storeManager: SessionStoreManager

  // ── 外部依赖（原闭包变量） ──
  gateway: LLMGateway
  stepManager: StepManager
  notificationService: NotificationService
  askUserTool: AskUserQuestionTool
  /** 清理工具结果磁盘文件 */
  cleanupToolResults: (sessionId: string) => Promise<void>
  /** 检查路径是否在工作区内 */
  isPathWithinWorkspace: (workspaceRoot: string, targetPath: string) => boolean
  /** 获取会话切换信息 */
  getMobileSessionTransition: (params: {
    requestedSessionId?: string | null
    activeSessionId?: string | null
    hasMessages: boolean
    generatedSessionId: string
  }) => { sessionId: string; shouldResetContext: boolean; shouldRestoreHistory: boolean }
  /** 工作区打开后的初始化回调 */
  handleWorkspaceOpened: (rootPath: string, toolRegistry: ToolRegistry) => void
  /** 获取工作目录 */
  getWorkingDirectory: () => string
  /** 更新 sessionStore 的回调 */
  setSessionStore: (store: SessionStore) => void

  // ── 可变状态（通过对象包装实现跨模块共享） ──
  mobileSessionId: { value: string | null }
  mobilePersistedMessageCounts: Map<string, number>
  mobilePersistLocks: Map<string, Promise<void>>
  sessionStore: { value: SessionStore }
  /** 去重 ID 集合 */
  processedMessageIds: Map<string, number>

  // ── 辅助函数 ──
  broadcastToMobile: (event: string, data: unknown) => void
  sendWorkspaceInfoToMobile: () => Promise<void>
  getActiveSessionStore: () => SessionStore
  getStoreForMobile: (activeWorkspaceId: string | null) => Promise<SessionStore>
  persistRuntimeDelta: (sessionId: string, runtime: AgentLoop, reason: string) => Promise<number>
}

/** 移动端消息类型 */
export interface MobileRelayMessage {
  clientId: string
  event: string
  data: Record<string, unknown>
}
