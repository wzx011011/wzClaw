// ============================================================
// WebSocketDataSource — 通过 WebSocket 连接 agent-server
//
// 实现 DataSource 接口，用于远程模式（连接 NAS 上运行的 agent-server）。
// 支持自动重连（指数退避）、事件订阅、请求-响应模式。
// ============================================================

import type {
  DataSource,
  StreamEventType,
  StreamEventCallback,
  StreamPayloadMap,
  SessionMeta,
  RawMessage,
  Settings,
  SendMessageOptions,
} from './types'

/** 客户端 → 服务器消息信封格式 */
interface ClientMessage {
  readonly event: string
  readonly data?: unknown
}

/** 服务器 → 客户端消息信封格式 */
interface ServerMessage {
  readonly event: string
  readonly data?: unknown
}

/**
 * WebSocketDataSource — 远程 WebSocket 连接的 DataSource 实现
 *
 * 特性：
 * - 连接 agent-server 的 Client 协议
 * - 指数退避自动重连（1s → 2s → 4s → ... → 30s 上限）
 * - 事件订阅模式：_listeners 管理所有 stream 事件回调
 * - 请求-响应模式：sendRequest() 发送消息并等待匹配的响应
 * - URL 协议校验：只允许 ws:// 和 wss://（安全考虑）
 */
export class WebSocketDataSource implements DataSource {
  /** WebSocket 连接实例 */
  private ws: WebSocket | null = null

  /** 连接状态 */
  private _connected = false

  /** 连接状态变更回调列表 */
  private readonly _connectionListeners = new Set<(connected: boolean) => void>()

  /** Stream 事件订阅：按事件类型分组 */
  private readonly _listeners = new Map<StreamEventType, Set<StreamEventCallback>>()

  /** 请求-响应模式的 pending Promise 映射 */
  private readonly _pendingRequests = new Map<
    string,
    {
      resolve: (data: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  /** 重连定时器 */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 最大退避时间上限 */
  private readonly MAX_RECONNECT_DELAY = 30_000

  /** 重连退避步长序列 */
  private readonly BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16_000, 30_000]

  /** 当前退避步长索引 */
  private _backoffIndex = 0

  /** 是否已主动调用 disconnect() */
  private _intentionalClose = false

  /** WebSocket 服务器 URL */
  private readonly _url: string

  /** 认证 token（可选） */
  private readonly _token?: string

  constructor(url: string, token?: string) {
    // 安全校验：只允许 ws:// 和 wss:// 协议（T-04-01）
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error(`不安全的 WebSocket 协议: ${parsed.protocol}，仅支持 ws: 和 wss:`)
    }
    this._url = url
    this._token = token
  }

  // ---- 连接生命周期 ----

  async connect(): Promise<void> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
      return // 已连接，跳过
    }

    this._intentionalClose = false

    return new Promise<void>((resolve, reject) => {
      try {
        // 创建 WebSocket 连接，可选带 token 认证
        const ws = this._token
          ? new WebSocket(this._url, this._token)
          : new WebSocket(this._url)

        ws.onopen = () => {
          this.ws = ws
          this._connected = true
          this._backoffIndex = 0
          this._notifyConnectionChange(true)
          resolve()
        }

        ws.onmessage = (event: MessageEvent) => {
          this._handleMessage(event)
        }

        ws.onclose = () => {
          this._connected = false
          this._notifyConnectionChange(false)
          this.ws = null

          // 非主动关闭时，自动重连
          if (!this._intentionalClose) {
            this._scheduleReconnect()
          }
        }

        ws.onerror = () => {
          // onclose 会在此之后触发，处理断开逻辑
          if (!this._connected) {
            reject(new Error(`WebSocket 连接失败: ${this._url}`))
          }
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  disconnect(): void {
    this._intentionalClose = true
    this._cancelReconnect()
    this._clearPendingRequests(new Error('连接已断开'))

    if (this.ws) {
      this.ws.onclose = null // 阻止触发重连
      this.ws.close()
      this.ws = null
    }

    this._connected = false
    this._notifyConnectionChange(false)
  }

  isConnected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN
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
    _options?: SendMessageOptions,
  ): Promise<void> {
    this._ensureConnected()
    this._send({
      event: 'chat:send',
      data: { sessionId, message: content },
    })
  }

  async stopGeneration(_sessionId: string): Promise<void> {
    // agent-server Client 协议暂不支持 stop 消息
    // 预留接口，后续扩展
    throw new Error('stopGeneration 尚未在 WebSocket 协议中实现')
  }

  // ---- Stream 事件 ----

  onStreamEvent<T extends StreamEventType>(
    eventType: T,
    callback: StreamEventCallback<T>,
  ): () => void {
    let listeners = this._listeners.get(eventType)
    if (!listeners) {
      listeners = new Set()
      this._listeners.set(eventType, listeners)
    }
    listeners.add(callback as StreamEventCallback)
    return () => {
      listeners!.delete(callback as StreamEventCallback)
      if (listeners!.size === 0) {
        this._listeners.delete(eventType)
      }
    }
  }

  // ---- 会话 CRUD ----

  async listSessions(): Promise<SessionMeta[]> {
    const data = await this._sendRequest('session:list', undefined, 'session:list')
    return (data as { sessions: SessionMeta[] }).sessions ?? []
  }

  async loadSession(sessionId: string): Promise<RawMessage[]> {
    const data = await this._sendRequest(
      'session:load',
      { sessionId },
      'session:loaded',
    )
    return (data as { messages: RawMessage[] }).messages ?? []
  }

  async createSession(): Promise<string> {
    const data = await this._sendRequest(
      'session:create',
      undefined,
      'session:created',
    )
    return (data as { sessionId: string }).sessionId
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this._sendRequest(
      'session:delete',
      { sessionId },
      'session:deleted',
    )
  }

  async renameSession(_sessionId: string, _title: string): Promise<void> {
    // agent-server Client 协议暂不支持 rename
    // 预留接口，后续扩展
    throw new Error('renameSession 尚未在 WebSocket 协议中实现')
  }

  // ---- 设置 ----

  async getSettings(): Promise<Settings> {
    // WebSocket 模式下，设置在客户端本地管理
    // 后续可扩展为从服务器拉取
    return {}
  }

  async updateSettings(_settings: Partial<Settings>): Promise<void> {
    // WebSocket 模式下，设置在客户端本地管理
    // 后续可扩展为推送到服务器
  }

  // ---- 内部方法 ----

  /** 发送原始消息到 WebSocket */
  private _send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }
    this.ws.send(JSON.stringify(message))
  }

  /**
   * 发送请求并等待匹配的响应
   *
   * @param sendEvent 发送的事件名
   * @param sendData 发送的数据
   * @param responseEvent 等待的响应事件名
   * @param timeout 超时时间（默认 10s）
   */
  private _sendRequest(
    sendEvent: string,
    sendData: unknown,
    responseEvent: string,
    timeout = 10_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this._ensureConnected()

      const requestKey = responseEvent

      // 如果已有相同类型的 pending 请求，先取消
      const existing = this._pendingRequests.get(requestKey)
      if (existing) {
        clearTimeout(existing.timer)
        this._pendingRequests.delete(requestKey)
      }

      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestKey)
        reject(new Error(`请求超时: ${sendEvent}`))
      }, timeout)

      this._pendingRequests.set(requestKey, { resolve, reject, timer })

      this._send({ event: sendEvent, data: sendData })
    })
  }

  /**
   * 处理收到的 WebSocket 消息
   *
   * 解析 JSON，按 event 字段分发：
   * 1. 检查是否有匹配的 pending request
   * 2. 转发到 stream 事件监听器
   */
  private _handleMessage(event: MessageEvent): void {
    let message: ServerMessage
    try {
      message = JSON.parse(event.data as string) as ServerMessage
    } catch {
      return // 无效 JSON，忽略
    }

    const { event: msgEvent, data } = message

    // 1. 检查 pending request
    const pending = this._pendingRequests.get(msgEvent)
    if (pending) {
      clearTimeout(pending.timer)
      this._pendingRequests.delete(msgEvent)
      pending.resolve(data)
      return
    }

    // 2. 转发到 stream 事件监听器
    const streamEvent = this._serverEventToStreamType(msgEvent)
    if (streamEvent) {
      const listeners = this._listeners.get(streamEvent)
      if (listeners) {
        const payload = this._normalizePayload(streamEvent, data)
        for (const cb of listeners) {
          try {
            cb(payload)
          } catch {
            // 监听器错误不影响其他监听器
          }
        }
      }
    }
  }

  /**
   * 将服务器事件名映射到 StreamEventType
   *
   * 映射规则：
   * - stream:text → 'text'
   * - stream:thinking → 'thinking'
   * - stream:tool_call → 'tool_call'
   * - stream:tool_result → 'tool_result'
   * - stream:error → 'error'
   * - stream:done → 'done'
   * - stream:compacted → 'compacted'
   */
  private _serverEventToStreamType(serverEvent: string): StreamEventType | null {
    const mapping: Record<string, StreamEventType> = {
      'stream:text': 'text',
      'stream:thinking': 'thinking',
      'stream:tool_call': 'tool_call',
      'stream:tool_result': 'tool_result',
      'stream:error': 'error',
      'stream:done': 'done',
      'stream:compacted': 'compacted',
    }
    return mapping[serverEvent] ?? null
  }

  /**
   * 将服务器 payload 标准化为接口定义的 payload 格式
   */
  private _normalizePayload(eventType: StreamEventType, data: unknown): StreamPayloadMap[StreamEventType] {
    // 服务器返回的格式已经是符合 StreamPayloadMap 的结构
    // 直接返回即可（服务器端 ClientHandler 已做了映射）
    return data as StreamPayloadMap[typeof eventType]
  }

  /** 确保已连接，否则抛出错误 */
  private _ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error('WebSocket 未连接')
    }
  }

  /** 通知所有连接状态监听器 */
  private _notifyConnectionChange(connected: boolean): void {
    for (const cb of this._connectionListeners) {
      try {
        cb(connected)
      } catch {
        // 监听器错误不影响其他监听器
      }
    }
  }

  /** 安排重连（指数退避） */
  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return

    const delay = this.BACKOFF_STEPS[this._backoffIndex] ?? this.MAX_RECONNECT_DELAY
    this._backoffIndex = Math.min(this._backoffIndex + 1, this.BACKOFF_STEPS.length - 1)

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null
      try {
        await this.connect()
      } catch {
        // connect 失败后会自动再次 scheduleReconnect（在 onclose 中）
      }
    }, delay)
  }

  /** 取消重连定时器 */
  private _cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  /** 清理所有 pending request */
  private _clearPendingRequests(error: Error): void {
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pendingRequests.clear()
  }
}
