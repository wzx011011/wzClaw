import { z } from 'zod'

// ============================================================
// 从 @wzxclaw/brain 重新导出核心共享类型
// 桌面端特有类型定义在下方
// ============================================================

import type {
  ContentBlock as _ContentBlock,
  TextContentBlock as _TextContentBlock,
  ToolUseContentBlock as _ToolUseContentBlock,
  ThinkingContentBlock as _ThinkingContentBlock,
  Message,
  UserMessage as _UserMessage,
  AssistantMessage as _AssistantMessage,
  ToolResultMessage as _ToolResultMessage,
  ImageContent as _ImageContent,
  ToolCall as _ToolCall,
  ToolResult as _ToolResult,
  ToolDefinition as _ToolDefinition,
  StreamEvent as _StreamEvent,
  TextDeltaEvent as _TextDeltaEvent,
  ThinkingDeltaEvent as _ThinkingDeltaEvent,
  ThinkingBlockDoneEvent as _ThinkingBlockDoneEvent,
  ToolUseStartEvent as _ToolUseStartEvent,
  ToolUseDeltaEvent as _ToolUseDeltaEvent,
  ToolUseEndEvent as _ToolUseEndEvent,
  StreamErrorEvent as _StreamErrorEvent,
  StreamDoneEvent as _StreamDoneEvent,
  TokenUsage as _TokenUsage,
  LLMProvider,
  Project as _Project,
  Workspace as _Workspace,
  CompactResult as _CompactResult,
} from '@wzxclaw/brain'

export type {
  _ContentBlock as ContentBlock,
  _TextContentBlock as TextContentBlock,
  _ToolUseContentBlock as ToolUseContentBlock,
  _ThinkingContentBlock as ThinkingContentBlock,
  Message,
  _UserMessage as UserMessage,
  _AssistantMessage as AssistantMessage,
  _ToolResultMessage as ToolResultMessage,
  _ImageContent as ImageContent,
  _ToolCall as ToolCall,
  _ToolResult as ToolResult,
  _ToolDefinition as ToolDefinition,
  _StreamEvent as StreamEvent,
  _TextDeltaEvent as TextDeltaEvent,
  _ThinkingDeltaEvent as ThinkingDeltaEvent,
  _ThinkingBlockDoneEvent as ThinkingBlockDoneEvent,
  _ToolUseStartEvent as ToolUseStartEvent,
  _ToolUseDeltaEvent as ToolUseDeltaEvent,
  _ToolUseEndEvent as ToolUseEndEvent,
  _StreamErrorEvent as StreamErrorEvent,
  _StreamDoneEvent as StreamDoneEvent,
  _TokenUsage as TokenUsage,
  LLMProvider,
  _Project as Project,
  _Workspace as Workspace,
  _CompactResult as CompactResult,
}

// ============================================================
// Appearance Settings
// ============================================================

export type ThemeMode = 'system' | 'light' | 'dark'
export type AccentColor = 'green' | 'purple'

// ============================================================
// Session Config
// ============================================================

export type SessionOwner = 'desktop-local' | 'nas-remote'

export interface SessionConfig {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspaceId?: string
  model?: string
  provider?: string
  targetHandId?: string
  owner?: SessionOwner
  workingDirectory?: string
  projectRoots?: string[]
  metadata?: Record<string, unknown>
}

export type SessionConfigPatch = Partial<Omit<SessionConfig, 'id' | 'createdAt' | 'updatedAt'>>

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
  preview?: string // 第一条用户消息摘要
  isRunning?: boolean // 是否正在生成
  taskStatus?: SessionTaskState // 桌面端权威任务状态
  todoSummary?: string // e.g. "3/5 完成 · 当前: 编写测试"
}

export type SessionTaskStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface SessionTaskState {
  sessionId: string
  runId: string
  status: SessionTaskStatus
  phase?: string | null
  message?: string | null
  startedAt: number
  updatedAt: number
  completedAt?: number | null
  error?: string | null
  recoverable?: boolean | null
  persistedMessageCount?: number
}

// ============================================================
// LLM Configuration (per D-15, D-16)
// ============================================================

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
  z.object({ type: z.literal('thinking_block_done'), thinking: z.string(), signature: z.string().optional() }),
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
  | { type: 'action'; execute: (args: string) => void | Promise<void> }

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
// Host Management Types — SSH-based server management
// ============================================================

/** SSH 连接的远程主机 */
export interface Host {
  id: string              // uuid
  name: string            // 显示名称
  host: string            // IP 或域名
  port: number            // SSH 端口，默认 22
  username: string        // SSH 用户名
  authType: 'password' | 'key'  // 认证方式
  description?: string
  tags?: string[]         // 如 ['nas', 'production']
  status: 'online' | 'offline' | 'unknown'
  lastConnectedAt?: number
  createdAt: number
  updatedAt: number
  archived: boolean
}

/** 系统监控数据 */
export interface HostMonitorData {
  hostname: string
  os: string
  kernel: string
  uptime: number          // 秒
  cpu: {
    model: string
    cores: number
    usagePercent: number
  }
  memory: {
    totalMB: number
    usedMB: number
    availableMB: number
    usagePercent: number
  }
  disks: Array<{
    filesystem: string
    mount: string
    totalGB: number
    usedGB: number
    availableGB: number
    usagePercent: number
  }>
  network: Array<{
    interface: string
    rxBytes: number
    txBytes: number
  }>
  timestamp: number
}

/** Docker 容器信息 */
export interface DockerContainer {
  id: string
  name: string
  image: string
  status: string          // Up 2 hours, Exited (0) 5 minutes ago
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead'
  ports: string
  createdAt: number
}

/** SFTP 目录条目 */
export interface SftpEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modTime: number
  permissions: string
}

/** SSH 命令执行事件 */
export interface SshExecEvent {
  type: 'stdout' | 'stderr' | 'exit'
  data: string
  exitCode?: number
}

/** Response type for agent:context_breakdown IPC */
export interface ContextBreakdownResponse {
  systemPromptTokens: number
  systemPromptDynamicTokens: number
  instructionsTokens: number
  commandsTokens: number
  skillsTokens: number
  memoryTokens: number
  toolDefinitionsTokens: number
  builtinToolTokens: number
  mcpToolTokens: number
  conversationTokens: number
  conversationMessageCount: number
  messagesByRole: { user: number; assistant: number; tool_result: number }
  totalEstimatedTokens: number
  contextWindowSize: number
  maxOutputTokens: number
  usagePercent: number
  autocompactBufferTokens: number
  freeSpaceTokens: number
  sessionUsage: {
    inputTokens: number; outputTokens: number
    cacheReadTokens: number; cacheWriteTokens: number
    totalCostUSD: number; model: string
  }
  compactionHistory: {
    compactCount: number; lastBefore: number | null; lastAfter: number | null
  }
  model: string
}

// ============================================================
// Compact Types
// ============================================================

/** Direction for partial compaction */
export type PartialCompactDirection = 'from' | 'up_to'
