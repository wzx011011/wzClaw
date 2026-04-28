import type { LLMProvider, TokenUsage } from '../../shared/types'
import { MAX_AGENT_TURNS } from '../../shared/constants'

// ============================================================
// Agent Event Types (per D-23)
// ============================================================

export interface AgentTextEvent {
  type: 'agent:text'
  content: string
}

export interface AgentThinkingEvent {
  type: 'agent:thinking'
  content: string
}

export interface AgentToolCallEvent {
  type: 'agent:tool_call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface AgentToolResultEvent {
  type: 'agent:tool_result'
  toolCallId: string
  toolName: string
  output: string
  isError: boolean
}

export interface AgentErrorEvent {
  type: 'agent:error'
  error: string
  recoverable: boolean
}

export interface AgentDoneEvent {
  type: 'agent:done'
  usage: TokenUsage
  turnCount: number
}

export interface AgentCompactedEvent {
  type: 'agent:compacted'
  beforeTokens: number
  afterTokens: number
  auto: boolean
}

export interface AgentTurnEndEvent {
  type: 'agent:turn_end'
}

export type AgentEvent =
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentDoneEvent
  | AgentCompactedEvent
  | AgentTurnEndEvent

// ============================================================
// Agent Configuration
// ============================================================

export interface AgentConfig {
  model: string
  provider: LLMProvider
  systemPrompt: string
  workingDirectory: string
  /** All project roots for the active task. [0] == workingDirectory. */
  projectRoots: string[]
  conversationId: string
  maxTurns?: number // defaults to MAX_AGENT_TURNS
  maxBudgetTokens?: number // 0 = unlimited
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
  /** Langfuse nested span 模式：父 Agent 的 tool:Agent observation，
   *  子 Agent 的 generations/spans 将挂载到该 span 下，而非创建独立的 trace。
   *  使用 unknown 类型避免 agent/types.ts 引入具体 SDK 类型 */
  langfuseParentSpan?: unknown
}
