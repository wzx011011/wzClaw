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

// 平台能力契约 — 由各 DataSource 实现声明支持的子集
// 注：此类型在 @wzxclaw/brain 中也有同名定义（供 agent-server 端使用），
// web-ui 不直接依赖 brain（浏览器端），故保留本地定义。两边字段必须一致。

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
  | 'usage_updated'
  | 'session_running'
  | 'sub_tool_use_start'
  | 'sub_tool_use_end'
  | 'sub_text'

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

/** 用量/费用更新事件 */
export interface UsageUpdatedStreamPayload {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalCostUSD: number
}

/** 会话运行状态变更事件 */
export interface SessionRunningStreamPayload {
  readonly sessionId: string
  readonly status: 'running' | 'idle'
}

/** 子代理工具调用开始事件 */
export interface SubToolUseStartStreamPayload {
  readonly toolCallId: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly parentToolCallId?: string
}

/** 子代理工具调用结束事件 */
export interface SubToolUseEndStreamPayload {
  readonly toolCallId: string
  readonly output: string
  readonly isError: boolean
}

/** 子代理文本增量事件 */
export interface SubTextStreamPayload {
  readonly delta: string
  readonly parentToolCallId?: string
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
  usage_updated: UsageUpdatedStreamPayload
  session_running: SessionRunningStreamPayload
  sub_tool_use_start: SubToolUseStartStreamPayload
  sub_tool_use_end: SubToolUseEndStreamPayload
  sub_text: SubTextStreamPayload
}

/** Stream 事件回调函数类型 */
export type StreamEventCallback<T extends StreamEventType = StreamEventType> =
  (payload: StreamPayloadMap[T]) => void

// ---- 会话相关类型 ----

export type SessionOwner = 'desktop-local' | 'nas-remote'

export interface SessionConfig {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly workspaceId?: string
  readonly model?: string
  readonly provider?: string
  readonly targetHandId?: string
  readonly owner?: SessionOwner
  readonly workingDirectory?: string
  readonly projectRoots?: string[]
  readonly metadata?: Record<string, unknown>
}

export type SessionConfigPatch = Partial<Omit<SessionConfig, 'id' | 'createdAt' | 'updatedAt'>>

/** 会话元信息 */
export interface SessionMeta {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  readonly preview?: string
  readonly isRunning?: boolean
  readonly workspaceId?: string
  readonly model?: string
  readonly provider?: string
  readonly targetHandId?: string
  readonly owner?: SessionOwner
}

// ---- 工作区相关类型 ----

export interface Project {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly addedAt: number
}

export interface Workspace {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly projects: Project[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly lastSessionId?: string
  readonly systemPrompt?: string
}

export interface WorkspaceUpdate {
  readonly title?: string
  readonly description?: string
  readonly archived?: boolean
  readonly lastSessionId?: string
  readonly systemPrompt?: string
}

// ---- 平台能力 ----

/**
 * RuntimeCapabilities — DataSource 声明的运行时能力。
 * UI 通过 useCapabilities() 读取并条件渲染。
 * 与 @wzxclaw/brain 的同名接口保持字段一致。
 */
export interface RuntimeCapabilities {
  readonly workspace: boolean
  readonly fs: boolean
  readonly terminal: boolean
  readonly preview: boolean
  readonly tools: boolean
  readonly permission: boolean
  readonly mcp: boolean
  readonly skills: boolean
  readonly plugins: boolean
  readonly hosts: boolean
  readonly indexing: boolean
  readonly insights: boolean
  readonly browser: boolean
  readonly notifications: boolean
}

export interface SessionListOptions {
  readonly workspaceId?: string
}

export interface CreateSessionOptions extends SessionConfigPatch {}

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
  /** 当前工作区，用于解析 workingDirectory/projectRoots */
  readonly workspaceId?: string
  /** 指定本轮工具调用使用的 Hand */
  readonly targetHandId?: string
  /** 附加图片（base64 编码） */
  readonly images?: Array<{
    readonly data: string
    readonly mimeType: string
    readonly name?: string
  }>
}

// ---- IDE 子通道类型 ----

/** 文件树节点 */
export interface FileTreeNode {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly children?: FileTreeNode[]
}

/** 文件变更事件 */
export interface FileWatchEvent {
  readonly type: 'create' | 'modify' | 'delete' | 'rename'
  readonly path: string
}

/** 文件系统通道 — readFile/writeFile/tree/watch */
export interface FsChannel {
  readFile(path: string): Promise<{ content: string }>
  writeFile(path: string, content: string): Promise<void>
  tree(dirPath: string, depth?: number): Promise<FileTreeNode[]>
  watch(path: string, callback: (events: FileWatchEvent[]) => void): () => void
}

/** 终端 spawn 选项 */
export interface TerminalSpawnOptions {
  readonly shell?: string
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly cols?: number
  readonly rows?: number
}

/** 终端通道 — spawn/write/resize/kill + 数据流 */
export interface TerminalChannel {
  spawn(options: TerminalSpawnOptions): Promise<string>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  kill(terminalId: string): Promise<void>
  onData(terminalId: string, callback: (data: string) => void): () => void
  onExit(terminalId: string, callback: (exitCode: number) => void): () => void
}

/** 预览通道 — open/reload/url 监听 */
export interface PreviewChannel {
  open(url: string): Promise<void>
  reload(): Promise<void>
  getUrl(): string | null
  onUrlChange(callback: (url: string | null) => void): () => void
}

// ---- DataSource 接口 ----

/**
 * DataSource — UI 与后端通信的统一接口
 *
 * 所有 UI 组件和 Store 只依赖此接口。
 * 具体实现（WebSocket / IPC）在运行时注入。
 */
export interface DataSource {
  readonly capabilities?: RuntimeCapabilities

  // ---- 连接生命周期 ----

  /** 建立连接（WebSocket 会创建新连接，IPC 直接 resolve） */
  connect(): Promise<void>

  /** 断开连接 */
  disconnect(): void

  /** 当前是否已连接 */
  isConnected(): boolean

  /** 监听连接状态变化，返回取消订阅函数 */
  onConnectionChange(callback: (connected: boolean) => void): () => void

  /** 获取运行时能力 */
  getCapabilities?(): Promise<RuntimeCapabilities>

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
  listSessions(options?: SessionListOptions): Promise<SessionMeta[]>

  /** 加载会话历史消息 */
  loadSession(sessionId: string): Promise<RawMessage[]>

  /** 创建新会话，返回新会话 ID */
  createSession(options?: CreateSessionOptions): Promise<string>

  /** 删除指定会话 */
  deleteSession(sessionId: string): Promise<void>

  /** 重命名指定会话 */
  renameSession(sessionId: string, title: string): Promise<void>

  /** 获取指定会话配置 */
  getSessionConfig(sessionId: string): Promise<SessionConfig | null>

  /** 更新指定会话配置 */
  updateSessionConfig(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig>

  /** 导出会话（消息 + 配置） */
  exportSession?(sessionId: string): Promise<{ messages: RawMessage[]; config: SessionConfig | null }>

  /** 复制会话，返回新会话 ID */
  duplicateSession?(sessionId: string): Promise<string>

  /** 压缩会话上下文（触发自动 compaction） */
  compactSession?(sessionId: string): Promise<void>

  /** 回退会话到最后 N 条消息 */
  rewindSession?(sessionId: string, keepMessageCount: number): Promise<void>

  // ---- 工作区 CRUD ----

  listWorkspaces(options?: { includeArchived?: boolean }): Promise<Workspace[]>

  getWorkspace(workspaceId: string): Promise<Workspace | null>

  createWorkspace(input: { title: string; description?: string }): Promise<Workspace>

  updateWorkspace(workspaceId: string, updates: WorkspaceUpdate): Promise<Workspace>

  deleteWorkspace(workspaceId: string): Promise<void>

  addWorkspaceProject(workspaceId: string, folderPath: string): Promise<Workspace>

  removeWorkspaceProject(workspaceId: string, projectId: string): Promise<Workspace>

  // ---- 权限模式 ----

  /** 获取当前权限模式 */
  getPermissionMode?(): Promise<string>

  /** 设置权限模式 */
  setPermissionMode?(mode: string): Promise<string>

  /** 回答 ask-user 问题 */
  answerAskUser?(questionId: string, answer: string): Promise<void>

  // ---- Knowledge (Skills/Commands/Memory) ----

  /** 获取 skills/commands/memory 内容 */
  getKnowledge?(): Promise<{ skills: string; commands: string; memory: string }>

  // ---- MCP ----

  /** 列出 MCP 工具 */
  listMcpTools?(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>

  // ---- Hosts ----

  /** 列出远程主机 */
  listHosts?(includeArchived?: boolean): Promise<Array<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; archived?: boolean
    createdAt: number; updatedAt: number
  }>>

  /** 获取单个主机 */
  getHost?(hostId: string): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; archived?: boolean
    createdAt: number; updatedAt: number
  } | null>

  /** 创建主机 */
  createHost?(input: {
    name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string
  }): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; createdAt: number; updatedAt: number
  }>

  /** 更新主机 */
  updateHost?(hostId: string, updates: Record<string, unknown>): Promise<{
    id: string; name: string; address: string; port: number
    username: string; authType: string; tags?: string[]
    description?: string; createdAt: number; updatedAt: number
  }>

  /** 删除主机 */
  deleteHost?(hostId: string): Promise<void>

  // ---- Plugins ----

  /** 列出插件 */
  listPlugins?(): Promise<Array<{
    id: string; name: string; description?: string
    enabled: boolean; version?: string
  }>>

  // ---- Indexing ----

  /** 获取索引状态 */
  getIndexingStatus?(): Promise<{
    available: boolean; backend: string
    indexedFiles: number; lastIndexed: number | null
  }>

  /** 搜索索引 */
  searchIndex?(query: string, limit?: number): Promise<{ results: unknown }>

  // ---- Insights ----

  /** 获取洞察状态 */
  getInsightsStatus?(): Promise<{
    available: boolean; reportExists: boolean; lastGenerated: number | null
  }>

  // ---- 设置 ----

  /** 获取当前设置 */
  getSettings(): Promise<Settings>

  /** 更新设置 */
  updateSettings(settings: Partial<Settings>): Promise<void>

  // ---- IDE 子通道（capability-driven，可选）----

  /** 文件系统操作（Electron 本地 / 远程 Hand FileRead+FileWrite） */
  readonly fs?: FsChannel

  /** 终端操作（Electron pty / 远程 Hand ShellExecute） */
  readonly terminal?: TerminalChannel

  /** 预览操作（Electron BrowserView / iframe） */
  readonly preview?: PreviewChannel
}
