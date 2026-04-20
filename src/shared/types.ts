import { z } from 'zod'

// ============================================================
// Content Block Types (preserves interleaved text/tool ordering)
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

export type ContentBlock = TextContentBlock | ToolUseContentBlock

// ============================================================
// Message Types
// ============================================================

export interface UserMessage {
  /** 唯一消息 ID（新消息自动生成，旧消息反序列化时可能为 undefined） */
  id?: string
  role: 'user'
  content: string
  timestamp: number
}

export interface AssistantMessage {
  id?: string
  role: 'assistant'
  content: string
  toolCalls: ToolCall[]
  /** Interleaved content blocks preserving original text/tool ordering.
   *  When present, message-builder uses this instead of content+toolCalls. */
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
  inputSchema: Record<string, unknown> // JSON Schema object
}

// ============================================================
// LLM Stream Events (per D-06)
// ============================================================

export interface TextDeltaEvent {
  type: 'text_delta'
  content: string
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta'
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

/** Thinking depth controls extended reasoning effort */
export type ThinkingDepth = 'none' | 'low' | 'medium' | 'high'

// Permission modes matching Z Code's 4-mode system
export type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

export interface LLMConfig {
  provider: LLMProvider
  model: string
  apiKey: string // Never sent to renderer (per D-14)
  baseURL?: string // Custom endpoint (per D-16)
  systemPrompt?: string // Per D-06 system prompt support
  maxTokens?: number // Anthropic requires this
}

// ============================================================
// File Mention Types (MENTION-01 through MENTION-06)
// ============================================================

export interface FileMention {
  type: 'file_mention'
  path: string
  content: string
  size: number
}

export interface FolderMention {
  type: 'folder_mention'
  path: string
  content: string  // directory tree summary text
  size: number     // number of entries
}

export type MentionItem = FileMention | FolderMention

// ============================================================
// Diff Preview Types (DIFF-01 through DIFF-07)
// ============================================================

export interface DiffHunk {
  id: string
  startIndex: number
  endIndex: number
  type: 'add' | 'delete' | 'replace'
  originalLines: string[]
  modifiedLines: string[]
  status: 'pending' | 'accepted' | 'rejected'
}

export interface PendingDiff {
  id: string
  filePath: string
  originalContent: string
  modifiedContent: string
  hunks: DiffHunk[]
  toolCallId: string
  timestamp: number
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
  z.object({ type: z.literal('thinking_delta'), content: z.string() }),
  z.object({ type: z.literal('tool_use_start'), id: z.string(), name: z.string() }),
  z.object({ type: z.literal('tool_use_delta'), id: z.string(), partialJson: z.string() }),
  z.object({ type: z.literal('tool_use_end'), id: z.string(), parsedInput: z.record(z.unknown()) }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('done'), usage: TokenUsageSchema })
])

export const FileMentionSchema = z.object({
  type: z.literal('file_mention'),
  path: z.string().min(1),
  content: z.string(),
  size: z.number().nonnegative()
})

export const FolderMentionSchema = z.object({
  type: z.literal('folder_mention'),
  path: z.string().min(1),
  content: z.string(),
  size: z.number().nonnegative()
})

// ============================================================
// Terminal Types (per TERM-01 through TERM-07)
// ============================================================

export interface TerminalInstance {
  id: string
  title: string
  isActive: boolean
}

// ============================================================
// Slash Command Types (SLASH-01)
// ============================================================

export interface SlashCommand {
  name: string          // without slash, e.g. "init"
  description: string
  args?: string
  handler: SlashCommandHandler
}

export type SlashCommandHandler =
  | { type: 'inject-prompt'; getPrompt: (args: string, workspaceRoot: string) => Promise<string> }
  | { type: 'action'; execute: (args: string) => void }

// ============================================================
// Step Management Types (per TASK-01 through TASK-05)
// ============================================================

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface AgentStep {
  id: string
  subject: string
  description: string
  status: StepStatus
  blockedBy: string[]    // step IDs this step depends on
  createdAt: number
  updatedAt: number
}

// ============================================================
// Task Management Types — top-level user work units
// ============================================================

/** A folder-based code repository mounted under a Task */
export interface Project {
  id: string           // uuid
  path: string         // absolute folder path
  name: string         // display name (basename of folder)
  addedAt: number
}

/** Top-level user work unit — can have 0-N Projects (folders) */
export interface Task {
  id: string           // uuid
  title: string
  description?: string
  projects: Project[]  // mounted folders
  createdAt: number
  updatedAt: number
  lastSessionId?: string // most recent chat session
  archived: boolean
}
