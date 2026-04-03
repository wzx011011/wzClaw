import type { LLMProvider } from '../../shared/types'
import { MAX_AGENT_TURNS } from '../../shared/constants'

// ============================================================
// Agent Event Types (per D-23)
// ============================================================

export interface AgentTextEvent {
  type: 'agent:text'
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

export interface AgentPermissionRequestEvent {
  type: 'agent:permission_request'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface AgentErrorEvent {
  type: 'agent:error'
  error: string
  recoverable: boolean
}

export interface AgentDoneEvent {
  type: 'agent:done'
  usage: { inputTokens: number; outputTokens: number }
  turnCount: number
}

export type AgentEvent =
  | AgentTextEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentPermissionRequestEvent
  | AgentErrorEvent
  | AgentDoneEvent

// ============================================================
// Agent Configuration
// ============================================================

export interface AgentConfig {
  model: string
  systemPrompt: string
  workingDirectory: string
  conversationId: string
  maxTurns?: number // defaults to MAX_AGENT_TURNS
}
