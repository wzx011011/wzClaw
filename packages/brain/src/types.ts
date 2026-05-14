// ============================================================
// 共享类型定义 — 从 shared/types.ts 提取的纯逻辑类型
// 无 Electron 依赖，无 Zod schema
// ============================================================

// ============================================================
// Content Block Types (保留交错文本/工具顺序)
// ============================================================

export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
  /** Anthropic 返回不透明签名，后续请求必须原样回传 */
  signature?: string
}

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ThinkingContentBlock

// ============================================================
// Message Types
// ============================================================

export interface ImageContent {
  /** Base64 编码图片数据（无 data: 前缀） */
  data: string
  /** MIME 类型: image/png, image/jpeg, image/gif, image/webp */
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** 原始文件名 */
  name?: string
}

export interface UserMessage {
  /** 唯一消息 ID（新消息自动生成，旧消息反序列化时可能为 undefined） */
  id?: string
  role: 'user'
  content: string
  /** 附加图片（base64） */
  images?: ImageContent[]
  timestamp: number
}

export interface AssistantMessage {
  id?: string
  role: 'assistant'
  content: string
  toolCalls: ToolCall[]
  /** 交错内容块，保留原始文本/工具顺序。
   *  存在时 message-builder 使用此字段而非 content+toolCalls。 */
  contentBlocks?: ContentBlock[]
  timestamp: number
}

export interface ToolResultMessage {
  id?: string
  role: 'tool_result'
  toolCallId: string
  content: string
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ============================================================
// Tool Types
// ============================================================

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  output: string
  isError: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema 对象
}

// ============================================================
// LLM Stream Events
// ============================================================

export interface TextDeltaEvent {
  type: 'text_delta'
  content: string
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta'
  content: string
}

export interface ThinkingBlockDoneEvent {
  type: 'thinking_block_done'
  thinking: string
  /** Anthropic 不透明签名 — 后续请求必须原样回传 */
  signature?: string
}

export interface ToolUseStartEvent {
  type: 'tool_use_start'
  id: string
  name: string
}

export interface ToolUseDeltaEvent {
  type: 'tool_use_delta'
  id: string
  partialJson: string
}

export interface ToolUseEndEvent {
  type: 'tool_use_end'
  id: string
  parsedInput: Record<string, unknown>
}

export interface StreamErrorEvent {
  type: 'error'
  error: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface StreamDoneEvent {
  type: 'done'
  usage: TokenUsage
}

export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ThinkingBlockDoneEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseEndEvent
  | StreamErrorEvent
  | StreamDoneEvent

// ============================================================
// LLM Configuration
// ============================================================

export type LLMProvider = 'openai' | 'anthropic'

// ============================================================
// Context Compact Types
// ============================================================

/** 上下文压缩结果 */
export interface CompactResult {
  summary: string
  /** 最终写入对话的完整摘要消息内容（含连续指令），用于替换对话 */
  summaryMessageContent: string
  keptRecentCount: number
  beforeTokens: number
  afterTokens: number
  /** 压缩后被摘要化的消息（用于文件恢复） */
  summarizedMessages: Message[]
}

// ============================================================
// Workspace — AgentConfig 需要
// ============================================================

/** 项目文件夹 */
export interface Project {
  id: string           // uuid
  path: string         // 绝对路径
  name: string         // 显示名称（文件夹 basename）
  addedAt: number
}

/** 顶层工作单元 */
export interface Workspace {
  id: string           // uuid
  title: string
  description?: string
  projects: Project[]  // 挂载的文件夹
  createdAt: number
  updatedAt: number
  lastSessionId?: string
  systemPrompt?: string
  archived: boolean
}
