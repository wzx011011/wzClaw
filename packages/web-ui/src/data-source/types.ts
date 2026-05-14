// ============================================================
// DataSource 抽象接口 — UI 与后端通信的统一契约
//
// 两个实现：
// - WebSocketDataSource：远程模式，连接 agent-server
// - IpcDataSource：本地模式，桥接 Electron preload API
//
// 设计原则：
// - UI 组件只依赖 DataSource 接口，不关心底层传输
// - Store 通过工厂函数注入 DataSource（便于测试）
// ============================================================

// ---- Stream 事件类型 ----

/** 流式事件类型枚举 */
export type StreamEventType =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'done'
  | 'compacted'
  | 'tool_progress'
  | 'turn_end'

// ---- Stream 事件 Payload ----

/** 文本增量事件 */
export interface TextStreamPayload {
  readonly delta: string
}

/** 思考内容事件 */
export interface ThinkingStreamPayload {
  readonly content: string
}

/** 工具调用开始事件 */
export interface ToolCallStreamPayload {
  readonly toolCallId: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** 工具执行结果事件 */
export interface ToolResultStreamPayload {
  readonly toolCallId: string
  readonly name: string
  readonly output: string
  readonly isError: boolean
}

/** 工具进度事件 */
export interface ToolProgressStreamPayload {
  readonly toolCallId: string
  readonly toolName: string
  readonly message: string
}

/** 错误事件 */
export interface ErrorStreamPayload {
  readonly error: string
  readonly recoverable: boolean
}

/** 流式完成事件 */
export interface DoneStreamPayload {
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
  readonly turnCount: number
}

/** 上下文压缩事件 */
export interface CompactedStreamPayload {
  readonly beforeTokens: number
  readonly afterTokens: number
}

/** Turn 结束事件 */
export interface TurnEndStreamPayload {
  readonly sessionId: string
}

/** Stream 事件 Payload 联合类型（按 StreamEventType 映射） */
export type StreamPayloadMap = {
  text: TextStreamPayload
  thinking: ThinkingStreamPayload
  tool_call: ToolCallStreamPayload
  tool_result: ToolResultStreamPayload
  error: ErrorStreamPayload
  done: DoneStreamPayload
  compacted: CompactedStreamPayload
  tool_progress: ToolProgressStreamPayload
  turn_end: TurnEndStreamPayload
}

/** Stream 事件回调函数类型 */
export type StreamEventCallback<T extends StreamEventType = StreamEventType> =
  (payload: StreamPayloadMap[T]) => void

// ---- 会话相关类型 ----

/** 会话元信息 */
export interface SessionMeta {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  readonly preview?: string
  readonly isRunning?: boolean
}

/** 原始消息（从后端返回的消息格式） */
export interface RawMessage {
  readonly id?: string
  readonly role: 'user' | 'assistant' | 'tool_result'
  readonly content: string
  readonly timestamp?: number
  readonly toolCalls?: Array<{
    readonly id: string
    readonly name: string
    readonly input: Record<string, unknown>
  }>
  readonly isError?: boolean
  readonly toolCallId?: string
}

// ---- 设置相关类型 ----

/** 应用设置（简化版，仅 web-ui 需要的字段） */
export interface Settings {
  readonly theme?: 'light' | 'dark' | 'system'
  readonly language?: 'zh-CN' | 'en'
  readonly agentUrl?: string
  readonly agentToken?: string
  readonly model?: string
  readonly provider?: string
  [key: string]: unknown
}

// ---- 发送消息选项 ----

/** 发送消息时的附加选项 */
export interface SendMessageOptions {
  /** 附加图片（base64 编码） */
  readonly images?: Array<{
    readonly data: string
    readonly mimeType: string
    readonly name?: string
  }>
}

// ---- DataSource 接口 ----

/**
 * DataSource — UI 与后端通信的统一接口
 *
 * 所有 UI 组件和 Store 只依赖此接口。
 * 具体实现（WebSocket / IPC）在运行时注入。
 */
export interface DataSource {
  // ---- 连接生命周期 ----

  /** 建立连接（WebSocket 会创建新连接，IPC 直接 resolve） */
  connect(): Promise<void>

  /** 断开连接 */
  disconnect(): void

  /** 当前是否已连接 */
  isConnected(): boolean

  /** 监听连接状态变化，返回取消订阅函数 */
  onConnectionChange(callback: (connected: boolean) => void): () => void

  // ---- Agent 操作 ----

  /** 向指定会话发送用户消息 */
  sendMessage(
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void>

  /** 停止指定会话的生成 */
  stopGeneration(sessionId: string): Promise<void>

  // ---- Stream 事件 ----

  /**
   * 订阅流式事件
   * @param eventType 事件类型
   * @param callback 事件回调
   * @returns 取消订阅函数
   */
  onStreamEvent<T extends StreamEventType>(
    eventType: T,
    callback: StreamEventCallback<T>,
  ): () => void

  // ---- 会话 CRUD ----

  /** 获取会话列表 */
  listSessions(): Promise<SessionMeta[]>

  /** 加载会话历史消息 */
  loadSession(sessionId: string): Promise<RawMessage[]>

  /** 创建新会话，返回新会话 ID */
  createSession(): Promise<string>

  /** 删除指定会话 */
  deleteSession(sessionId: string): Promise<void>

  /** 重命名指定会话 */
  renameSession(sessionId: string, title: string): Promise<void>

  // ---- 设置 ----

  /** 获取当前设置 */
  getSettings(): Promise<Settings>

  /** 更新设置 */
  updateSettings(settings: Partial<Settings>): Promise<void>
}
