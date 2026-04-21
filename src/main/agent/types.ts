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

export interface AgentToolCallPreviewEvent {
  type: 'agent:tool_call_preview'
  toolCallId: string
  toolName: string
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
  | AgentToolCallPreviewEvent
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
  conversationId: string
  maxTurns?: number // defaults to MAX_AGENT_TURNS
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
}
