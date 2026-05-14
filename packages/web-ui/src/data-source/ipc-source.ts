// ============================================================
// IpcDataSource — Electron IPC 桥接的 DataSource 实现
//
// 包装 window.wzxclaw preload API，在 Electron 环境下使用。
// 本地模式不走 WebSocket，直接通过 IPC 与主进程通信。
// ============================================================

import type {
  DataSource,
  StreamEventType,
  StreamEventCallback,
  SessionMeta,
  RawMessage,
  Settings,
  SendMessageOptions,
} from './types'

/**
 * window.wzxclaw 的类型声明（preload API）
 *
 * 只声明 web-ui 实际用到的方法，完整定义在桌面端 preload/index.ts 中。
 */
interface WzxClawApi {
  // Agent
  sendMessage: (request: {
    conversationId: string
    content: string
    images?: Array<{ data: string; mimeType: string; name?: string }>
  }) => Promise<void>
  stopGeneration: (sessionId: string) => Promise<void>

  // Stream listeners（均返回 unsubscribe 函数）
  onStreamText: (cb: (payload: { content: string; sessionId: string }) => void) => () => void
  onStreamThinking: (cb: (payload: { content: string; sessionId: string }) => void) => () => void
  onStreamToolStart: (cb: (payload: {
    id: string
    name: string
    input?: Record<string, unknown>
    sessionId: string
  }) => void) => () => void
  onStreamToolResult: (cb: (payload: {
    id: string
    output: string
    isError: boolean
    toolName: string
    sessionId: string
  }) => void) => () => void
  onStreamToolProgress: (cb: (payload: {
    toolCallId: string
    toolName: string
    message: string
    sessionId?: string
  }) => void) => () => void
  onStreamEnd: (cb: (payload: {
    usage: { inputTokens: number; outputTokens: number }
    sessionId: string
  }) => void) => () => void
  onStreamError: (cb: (payload: { error: string; sessionId: string }) => void) => () => void
  onStreamTurnEnd: (cb: (payload: { sessionId: string }) => void) => () => void

  // Session
  listSessions: (request?: { activeWorkspaceId?: string }) => Promise<SessionMeta[]>
  loadSession: (request: { sessionId: string; activeWorkspaceId?: string }) => Promise<{
    messages: RawMessage[]
  }>
  deleteSession: (request: { sessionId: string }) => Promise<void>
  renameSession: (request: { sessionId: string; title: string }) => Promise<void>

  // Settings
  getSettings: () => Promise<Settings>
  updateSettings: (request: Partial<Settings>) => Promise<void>
}

/** 扩展 Window 类型以包含 wzxclaw API */
declare global {
  interface Window {
    wzxclaw?: WzxClawApi
  }
}

/**
 * IpcDataSource — Electron IPC 桥接实现
 *
 * 适配 window.wzxclaw preload API 到 DataSource 接口。
 * IPC 不需要显式连接管理（主进程始终在线），connect() 仅检测 API 可用性。
 */
export class IpcDataSource implements DataSource {
  /** 是否可用（window.wzxclaw 存在） */
  private _available: boolean

  /** 连接状态监听器 */
  private readonly _connectionListeners = new Set<(connected: boolean) => void>()

  /** Stream 事件订阅的 unsubscribe 函数列表 */
  private readonly _unsubscribers: Array<() => void> = []

  constructor() {
    this._available = typeof window !== 'undefined' && !!window.wzxclaw
  }

  // ---- 连接生命周期 ----

  async connect(): Promise<void> {
    if (!window.wzxclaw) {
      throw new Error('Electron preload API 不可用：window.wzxclaw 未定义')
    }
    this._available = true
    this._notifyConnectionChange(true)
  }

  disconnect(): void {
    // 取消所有 stream 事件订阅
    for (const unsub of this._unsubscribers) {
      unsub()
    }
    this._unsubscribers.length = 0
    this._available = false
    this._notifyConnectionChange(false)
  }

  isConnected(): boolean {
    return this._available
  }

  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this._connectionListeners.add(callback)
    return () => {
      this._connectionListeners.delete(callback)
    }
  }

  // ---- Agent 操作 ----

  async sendMessage(
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.sendMessage({
      conversationId: sessionId,
      content,
      images: options?.images,
    })
  }

  async stopGeneration(sessionId: string): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.stopGeneration(sessionId)
  }

  // ---- Stream 事件 ----

  onStreamEvent<T extends StreamEventType>(
    eventType: T,
    callback: StreamEventCallback<T>,
  ): () => void {
    this._ensureAvailable()

    // 将 eventType 映射到对应的 window.wzxclaw 方法
    const api = window.wzxclaw!
    let unsub: (() => void) | null = null

    switch (eventType) {
      case 'text':
        unsub = api.onStreamText((payload) => {
          ;(callback as StreamEventCallback<'text'>)({ delta: payload.content })
        })
        break

      case 'thinking':
        unsub = api.onStreamThinking((payload) => {
          ;(callback as StreamEventCallback<'thinking'>)({ content: payload.content })
        })
        break

      case 'tool_call':
        unsub = api.onStreamToolStart((payload) => {
          ;(callback as StreamEventCallback<'tool_call'>)({
            toolCallId: payload.id,
            name: payload.name,
            input: payload.input ?? {},
          })
        })
        break

      case 'tool_result':
        unsub = api.onStreamToolResult((payload) => {
          ;(callback as StreamEventCallback<'tool_result'>)({
            toolCallId: payload.id,
            name: payload.toolName,
            output: payload.output,
            isError: payload.isError,
          })
        })
        break

      case 'tool_progress':
        unsub = api.onStreamToolProgress((payload) => {
          ;(callback as StreamEventCallback<'tool_progress'>)({
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            message: payload.message,
          })
        })
        break

      case 'done':
        unsub = api.onStreamEnd((payload) => {
          ;(callback as StreamEventCallback<'done'>)({
            usage: payload.usage,
            turnCount: 0, // IPC 协议不返回 turnCount
          })
        })
        break

      case 'error':
        unsub = api.onStreamError((payload) => {
          ;(callback as StreamEventCallback<'error'>)({
            error: payload.error,
            recoverable: false, // IPC 协议不区分是否可恢复
          })
        })
        break

      case 'turn_end':
        unsub = api.onStreamTurnEnd((payload) => {
          ;(callback as StreamEventCallback<'turn_end'>)({
            sessionId: payload.sessionId,
          })
        })
        break

      case 'compacted':
        // IPC 没有独立的 compacted stream 事件，通过 onSessionCompacted 处理
        // 这里提供一个空实现，后续可扩展
        unsub = () => {}
        break

      default:
        // 未知事件类型，提供空 unsubscribe
        unsub = () => {}
        break
    }

    this._unsubscribers.push(unsub)
    return unsub
  }

  // ---- 会话 CRUD ----

  async listSessions(): Promise<SessionMeta[]> {
    this._ensureAvailable()
    return window.wzxclaw!.listSessions()
  }

  async loadSession(sessionId: string): Promise<RawMessage[]> {
    this._ensureAvailable()
    const result = await window.wzxclaw!.loadSession({ sessionId })
    return result.messages
  }

  async createSession(): Promise<string> {
    // IPC 没有直接的 createSession，使用 ensureSession + 新 ID
    // 后续由桌面端的 session 管理逻辑处理
    throw new Error('createSession 在 IPC 模式下需通过桌面端 session 管理实现')
  }

  async deleteSession(sessionId: string): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.deleteSession({ sessionId })
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.renameSession({ sessionId, title })
  }

  // ---- 设置 ----

  async getSettings(): Promise<Settings> {
    this._ensureAvailable()
    return window.wzxclaw!.getSettings()
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.updateSettings(settings)
  }

  // ---- 内部方法 ----

  /** 确保 window.wzxclaw 可用 */
  private _ensureAvailable(): void {
    if (!this._available || !window.wzxclaw) {
      throw new Error('Electron preload API 不可用')
    }
  }

  /** 通知连接状态变更 */
  private _notifyConnectionChange(connected: boolean): void {
    for (const cb of this._connectionListeners) {
      try {
        cb(connected)
      } catch {
        // 监听器错误不影响其他监听器
      }
    }
  }
}
