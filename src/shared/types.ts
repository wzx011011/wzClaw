import { z } from 'zod'

// ============================================================
// Message Types
// ============================================================

export interface UserMessage {
  role: 'user'
  content: string
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: string
  toolCalls: ToolCall[]
  timestamp: number
}

export interface ToolResultMessage {
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
  inputSchema: Record<string, unknown> // JSON Schema object
}

// ============================================================
// LLM Stream Events (per D-06)
// ============================================================

export interface TextDeltaEvent {
  type: 'text_delta'
  content: string
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
}

export interface StreamDoneEvent {
  type: 'done'
  usage: TokenUsage
}

export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseEndEvent
  | StreamErrorEvent
  | StreamDoneEvent

// ============================================================
// File Tree & Editor Types (Phase 3)
// ============================================================

// File tree node for directory explorer
export interface FileTreeNode {
  name: string
  path: string // absolute path
  isDirectory: boolean
  children?: FileTreeNode[]
  isExpanded?: boolean // UI state hint
}

// Tab state for editor
export interface EditorTab {
  id: string // unique tab ID
  filePath: string // absolute file path
  fileName: string // display name (basename)
  content: string // current editor content
  diskContent: string // last saved/on-disk content
  isDirty: boolean // content !== diskContent
  language: string // Monaco language ID (e.g. 'typescript', 'python')
}

// ============================================================
// Conversation
// ============================================================

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

// ============================================================
// Session Persistence (per PERSIST-01 through PERSIST-06)
// ============================================================

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

// ============================================================
// LLM Configuration (per D-15, D-16)
// ============================================================

export type LLMProvider = 'openai' | 'anthropic'

export interface LLMConfig {
  provider: LLMProvider
  model: string
  apiKey: string // Never sent to renderer (per D-14)
  baseURL?: string // Custom endpoint (per D-16)
  systemPrompt?: string // Per D-06 system prompt support
  maxTokens?: number // Anthropic requires this
}

// ============================================================
// Zod Schemas for IPC Validation
// ============================================================

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string().min(1),
  timestamp: z.number()
})

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number()
})

export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), content: z.string() }),
  z.object({ type: z.literal('tool_use_start'), id: z.string(), name: z.string() }),
  z.object({ type: z.literal('tool_use_delta'), id: z.string(), partialJson: z.string() }),
  z.object({ type: z.literal('tool_use_end'), id: z.string(), parsedInput: z.record(z.unknown()) }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('done'), usage: TokenUsageSchema })
])
