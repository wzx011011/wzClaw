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
  SessionConfig,
  SessionConfigPatch,
  SessionListOptions,
  CreateSessionOptions,
  SendMessageOptions,
  Workspace,
  WorkspaceUpdate,
  RuntimeCapabilities,
  FsChannel,
  FileTreeNode,
  FileWatchEvent,
  TerminalChannel,
  TerminalSpawnOptions,
  PreviewChannel,
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
  readonly capabilities: RuntimeCapabilities = {
    workspace: true,
    fs: true,
    terminal: true,
    preview: false,      // Desktop-only via IPC
    tools: true,
    permission: true,     // Server supports permission:get/set
    mcp: true,           // Server supports mcp:list
    skills: true,        // Server supports knowledge:get (returns skills)
    plugins: true,       // Server supports plugin:list
    hosts: true,         // Server supports host CRUD + operations
    indexing: true,      // Server supports indexing:search
    insights: false,     // Still stub
    browser: false,      // Desktop-only
    notifications: false,
  }

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
      responseEvent: string
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

  /** 终端数据流监听器 */
  private readonly _terminalDataListeners = new Map<string, Set<(data: string) => void>>()

  /** 终端退出监听器 */
  private readonly _terminalExitListeners = new Map<string, Set<(exitCode: number) => void>>()

  /** fs.watch 未实现警告抑制标记（仅首次调用打印 warn） */
  private _warnedWatch = false

  constructor(url: string, token?: string) {
    // 安全校验：只允许 ws:// 和 wss:// 协议（T-04-01）
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error(`不安全的 WebSocket 协议: ${parsed.protocol}，仅支持 ws: 和 wss:`)
    }
    this._url = url
    this._token = token

    // 初始化 IDE 子通道
    this.fs = this._createFsChannel()
    this.terminal = this._createTerminalChannel()
    this.preview = this._createPreviewChannel()
  }

  // ---- IDE 子通道 ----

  readonly fs?: FsChannel
  readonly terminal?: TerminalChannel
  readonly preview?: PreviewChannel

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
          ? new WebSocket(this._url, `wzxclaw-${this._token}`)
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

  async getCapabilities(): Promise<RuntimeCapabilities> {
    const data = await this._sendRequest('capabilities:get', undefined, 'capabilities')
    return { ...this.capabilities, ...(data as Partial<RuntimeCapabilities>) }
  }

  // ---- Agent 操作 ----

  async sendMessage(
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    this._ensureConnected()
    this._send({
      event: 'chat:send',
      data: { sessionId, message: content, targetHandId: options?.targetHandId, workspaceId: options?.workspaceId },
    })
  }

  async stopGeneration(sessionId: string): Promise<void> {
    this._ensureConnected()
    this._send({ event: 'chat:stop', data: { sessionId } })
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

  async listSessions(options?: SessionListOptions): Promise<SessionMeta[]> {
    const data = await this._sendRequest('session:list', options, 'session:list')
    return Array.isArray(data) ? data as SessionMeta[] : (data as { sessions: SessionMeta[] }).sessions ?? []
  }

  async loadSession(sessionId: string): Promise<RawMessage[]> {
    const data = await this._sendRequest(
      'session:load',
      { sessionId },
      'session:loaded',
    )
    return (data as { messages: RawMessage[] }).messages ?? []
  }

  async createSession(options?: CreateSessionOptions): Promise<string> {
    const data = await this._sendRequest(
      'session:create',
      options,
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

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this._sendRequest(
      'session:rename',
      { sessionId, title },
      'session:renamed',
    )
  }

  async getSessionConfig(sessionId: string): Promise<SessionConfig | null> {
    const data = await this._sendRequest(
      'session:config:get',
      { sessionId },
      'session:config',
    )
    return (data as { config: SessionConfig | null }).config ?? null
  }

  async updateSessionConfig(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const data = await this._sendRequest(
      'session:config:update',
      { sessionId, patch },
      'session:config:updated',
    )
    return (data as { config: SessionConfig }).config
  }

  async listWorkspaces(options?: { includeArchived?: boolean }): Promise<Workspace[]> {
    const data = await this._sendRequest('workspace:list', options, 'workspace:list')
    return Array.isArray(data) ? data as Workspace[] : (data as { workspaces: Workspace[] }).workspaces ?? []
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const data = await this._sendRequest('workspace:get', { workspaceId }, 'workspace:loaded')
    return (data as { workspace: Workspace | null }).workspace ?? null
  }

  async createWorkspace(input: { title: string; description?: string }): Promise<Workspace> {
    const data = await this._sendRequest('workspace:create', input, 'workspace:created')
    return (data as { workspace: Workspace }).workspace
  }

  async updateWorkspace(workspaceId: string, updates: WorkspaceUpdate): Promise<Workspace> {
    const data = await this._sendRequest('workspace:update', { workspaceId, updates }, 'workspace:updated')
    return (data as { workspace: Workspace }).workspace
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this._sendRequest('workspace:delete', { workspaceId }, 'workspace:deleted')
  }

  async addWorkspaceProject(workspaceId: string, folderPath: string): Promise<Workspace> {
    const data = await this._sendRequest('workspace:add-project', { workspaceId, folderPath }, 'workspace:updated')
    return (data as { workspace: Workspace }).workspace
  }

  async removeWorkspaceProject(workspaceId: string, projectId: string): Promise<Workspace> {
    const data = await this._sendRequest('workspace:remove-project', { workspaceId, projectId }, 'workspace:updated')
    return (data as { workspace: Workspace }).workspace
  }

  // ---- 权限模式 ----

  async getPermissionMode(): Promise<string> {
    const data = await this._sendRequest('permission:get', {}, 'permission:mode')
    return (data as { mode: string }).mode
  }

  async setPermissionMode(mode: string): Promise<string> {
    const data = await this._sendRequest('permission:set', { mode }, 'permission:mode')
    return (data as { mode: string }).mode
  }

  async answerAskUser(questionId: string, answer: string): Promise<void> {
    this._send({ event: 'ask-user:answer', data: { questionId, answer } })
  }

  // ---- 会话控制 ----

  async exportSession(sessionId: string): Promise<{ messages: RawMessage[]; config: SessionConfig | null }> {
    const data = await this._sendRequest('session:export', { sessionId }, 'session:exported')
    return data as { messages: RawMessage[]; config: SessionConfig | null }
  }

  async duplicateSession(sessionId: string): Promise<string> {
    const data = await this._sendRequest('session:duplicate', { sessionId }, 'session:duplicated')
    return (data as { newSessionId: string }).newSessionId
  }

  async compactSession(sessionId: string): Promise<void> {
    await this._sendRequest('session:compact', { sessionId }, 'session:compacted')
  }

  async rewindSession(sessionId: string, keepMessageCount: number): Promise<void> {
    await this._sendRequest('session:rewind', { sessionId, keepMessageCount }, 'session:rewound')
  }

  // ---- Knowledge ----

  async getKnowledge(): Promise<{ skills: string; commands: string; memory: string }> {
    const data = await this._sendRequest('knowledge:get', {}, 'knowledge')
    return data as { skills: string; commands: string; memory: string }
  }

  // ---- MCP ----

  async listMcpTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    const data = await this._sendRequest('mcp:list', {}, 'mcp:list')
    return (data as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }).tools
  }

  // ---- Hosts ----

  async listHosts(includeArchived?: boolean): Promise<Array<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; archived?: boolean
    createdAt: number; updatedAt: number
  }>> {
    const data = await this._sendRequest('host:list', { includeArchived }, 'host:list')
    return (data as { hosts: Array<{
      id: string; name: string; address: string; port: number
      username: string; authType: string; tags?: string[]
      description?: string; archived?: boolean
      createdAt: number; updatedAt: number
    }> }).hosts ?? []
  }

  async getHost(hostId: string): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; archived?: boolean
    createdAt: number; updatedAt: number
  } | null> {
    const data = await this._sendRequest('host:get', { hostId }, 'host:get')
    return (data as { host: unknown }).host as any ?? null
  }

  async createHost(input: {
    name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string
  }): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; createdAt: number; updatedAt: number
  }> {
    const data = await this._sendRequest('host:create', input, 'host:created')
    return (data as { host: any }).host
  }

  async updateHost(hostId: string, updates: Record<string, unknown>): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; createdAt: number; updatedAt: number
  }> {
    const data = await this._sendRequest('host:update', { hostId, updates }, 'host:updated')
    return (data as { host: any }).host
  }

  async deleteHost(hostId: string): Promise<void> {
    await this._sendRequest('host:delete', { hostId }, 'host:deleted')
  }

  // ---- Plugins ----

  async listPlugins(): Promise<Array<{
    id: string; name: string; description?: string
    enabled: boolean; version?: string
  }>> {
    const data = await this._sendRequest('plugin:list', {}, 'plugin:list')
    return (data as { plugins: Array<{
      id: string; name: string; description?: string
      enabled: boolean; version?: string
    }> }).plugins ?? []
  }

  // ---- Indexing ----

  async getIndexingStatus(): Promise<{
    available: boolean; backend: string
    indexedFiles: number; lastIndexed: number | null
  }> {
    const data = await this._sendRequest('indexing:status', {}, 'indexing:status')
    return data as { available: boolean; backend: string; indexedFiles: number; lastIndexed: number | null }
  }

  async searchIndex(query: string, limit?: number): Promise<{ results: unknown }> {
    const data = await this._sendRequest('indexing:search', { query, limit }, 'indexing:search')
    return data as { results: unknown }
  }

  // ---- Insights ----

  async getInsightsStatus(): Promise<{
    available: boolean; reportExists: boolean; lastGenerated: number | null
  }> {
    const data = await this._sendRequest('insights:status', {}, 'insights:status')
    return data as { available: boolean; reportExists: boolean; lastGenerated: number | null }
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

      const requestKey = `${responseEvent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestKey)
        reject(new Error(`请求超时: ${sendEvent}`))
      }, timeout)

      this._pendingRequests.set(requestKey, { resolve, reject, timer, responseEvent })

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

    // 1. 检查 pending request（按 responseEvent 匹配，取最早的一个）
    let matchedKey: string | null = null
    let matchedPending: { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; responseEvent: string } | null = null
    for (const [key, pending] of this._pendingRequests) {
      if (pending.responseEvent === msgEvent) {
        matchedKey = key
        matchedPending = pending
        break
      }
    }
    if (matchedPending && matchedKey) {
      clearTimeout(matchedPending.timer)
      this._pendingRequests.delete(matchedKey)
      matchedPending.resolve(data)
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
      return
    }

    // 3. 转发到 IDE 通道事件（terminal data/exit 等）
    this._dispatchChannelEvent(msgEvent, data)
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
      'stream:turn_end': 'turn_end',
      'stream:tool_progress': 'tool_progress',
      'usage:updated': 'usage_updated',
      'session:running': 'session_running',
      'stream:sub_tool_use_start': 'sub_tool_use_start',
      'stream:sub_tool_use_end': 'sub_tool_use_end',
      'stream:sub_text': 'sub_text',
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

  // ---- IDE 子通道工厂 ----

  /** 创建 FsChannel — 通过 agent-server 转发到 NAS Hand FileRead/FileWrite */
  private _createFsChannel(): FsChannel {
    return {
      readFile: async (path: string) => {
        const data = await this._sendRequest('fs:readFile', { path }, 'fs:readFile:result', 15_000)
        return data as { content: string }
      },
      writeFile: async (path: string, content: string) => {
        await this._sendRequest('fs:writeFile', { path, content }, 'fs:writeFile:result', 15_000)
      },
      tree: async (dirPath: string, depth?: number) => {
        const data = await this._sendRequest('fs:tree', { dirPath, depth }, 'fs:tree:result', 15_000)
        return (data as { nodes: FileTreeNode[] }).nodes
      },
      watch: (path: string, _callback: (events: FileWatchEvent[]) => void) => {
        // WebSocket 模式暂不支持实时文件 watch。
        // capabilities.fs 仍为 true（readFile/writeFile/tree 可用），
        // 但 watch 需要 NAS Hand 长连接事件流，未实现 → 仅警告一次，返回 no-op。
        if (!this._warnedWatch) {
          this._warnedWatch = true
          console.warn(
            `[WebSocketDataSource] fs.watch() is not implemented in remote mode (requested path: ${path}). ` +
              `Falling back to no-op. Use polling or capability-gate this feature.`
          )
        }
        return () => {}
      },
    }
  }

  /** 创建 TerminalChannel — 通过 agent-server 转发到 NAS Hand ShellExecute */
  private _createTerminalChannel(): TerminalChannel {
    return {
      spawn: async (options: TerminalSpawnOptions) => {
        const data = await this._sendRequest(
          'terminal:spawn',
          options,
          'terminal:spawned',
          10_000,
        )
        return (data as { terminalId: string }).terminalId
      },
      write: async (terminalId: string, data: string) => {
        this._ensureConnected()
        await this._sendRequest(
          'terminal:write',
          { terminalId, data },
          'terminal:write:ack',
          3_000,
        )
      },
      resize: async (terminalId: string, cols: number, rows: number) => {
        this._ensureConnected()
        await this._sendRequest(
          'terminal:resize',
          { terminalId, cols, rows },
          'terminal:resize:ack',
          3_000,
        )
      },
      kill: async (terminalId: string) => {
        await this._sendRequest(
          'terminal:kill',
          { terminalId },
          'terminal:killed',
          5_000,
        )
      },
      onData: (terminalId: string, callback: (data: string) => void) => {
        let listeners = this._terminalDataListeners.get(terminalId)
        if (!listeners) {
          listeners = new Set()
          this._terminalDataListeners.set(terminalId, listeners)
        }
        listeners.add(callback)
        return () => {
          listeners!.delete(callback)
          if (listeners!.size === 0) {
            this._terminalDataListeners.delete(terminalId)
          }
        }
      },
      onExit: (terminalId: string, callback: (exitCode: number) => void) => {
        let listeners = this._terminalExitListeners.get(terminalId)
        if (!listeners) {
          listeners = new Set()
          this._terminalExitListeners.set(terminalId, listeners)
        }
        listeners.add(callback)
        return () => {
          listeners!.delete(callback)
          if (listeners!.size === 0) {
            this._terminalExitListeners.delete(terminalId)
          }
        }
      },
    }
  }

  /** 创建 PreviewChannel — 基于 agent-server URL 代理 */
  private _createPreviewChannel(): PreviewChannel {
    let currentUrl: string | null = null
    const urlListeners = new Set<(url: string | null) => void>()

    return {
      open: async (url: string) => {
        currentUrl = url
        for (const cb of urlListeners) {
          try { cb(url) } catch { /* ignore */ }
        }
      },
      reload: async () => {
        // 远程模式：reload 由 iframe 自身处理
      },
      getUrl: () => currentUrl,
      onUrlChange: (callback: (url: string | null) => void) => {
        urlListeners.add(callback)
        return () => { urlListeners.delete(callback) }
      },
    }
  }

  /** 分发 IDE 通道事件（terminal data/exit） */
  private _dispatchChannelEvent(msgEvent: string, data: unknown): void {
    if (msgEvent === 'terminal:data') {
      const payload = data as { terminalId: string; data: string }
      const listeners = this._terminalDataListeners.get(payload.terminalId)
      if (listeners) {
        for (const cb of listeners) {
          try { cb(payload.data) } catch { /* ignore */ }
        }
      }
    } else if (msgEvent === 'terminal:exit') {
      const payload = data as { terminalId: string; exitCode: number }
      const listeners = this._terminalExitListeners.get(payload.terminalId)
      if (listeners) {
        for (const cb of listeners) {
          try { cb(payload.exitCode) } catch { /* ignore */ }
        }
      }
    }
  }
}
