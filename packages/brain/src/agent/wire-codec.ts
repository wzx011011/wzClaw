// ============================================================
// AgentEvent Wire Codec
// ----------------------------------------------------------------
// Bidirectional codec between AgentEvent (in-process generator events)
// and WireStreamMessage (`{event: 'stream:*', data}` JSON envelopes used
// on the WebSocket between agent-server ↔ client).
//
// This codec is the single source of truth for the wire format and
// is shared by anything that drives an AgentLoop and needs to publish
// events to a remote client (agent-server, future desktop local mode,
// mobile replay tools, etc.).
// ============================================================

import type { AgentEvent } from './types.js'

/** Wire envelope shape: `{event, data}` JSON. */
export interface WireStreamMessage {
  event: string
  data: unknown
}

/**
 * Encode an in-process `AgentEvent` into a wire envelope.
 * Returns `null` for event types that should not be forwarded over the wire
 * (e.g. `agent:tool_call_preview` is intentionally not mapped to keep wire
 * traffic lean).
 *
 * Mapping table:
 * - agent:text          → stream:text          { delta }
 * - agent:thinking      → stream:thinking      { content }
 * - agent:tool_call     → stream:tool_call     { toolCallId, name, input }
 * - agent:tool_result   → stream:tool_result   { toolCallId, name, output, isError }
 * - agent:tool_progress → stream:tool_progress { toolCallId, toolName, message }
 * - agent:error         → stream:error         { error, recoverable, errorCode? }
 * - agent:done          → stream:done          { usage, turnCount, model? }
 * - agent:compacted     → stream:compacted     { beforeTokens, afterTokens, auto? }
 * - agent:turn_end      → stream:turn_end      {}
 * - agent:tool_call_preview → (dropped)
 */
export function encodeAgentEvent(event: AgentEvent): WireStreamMessage | null {
  switch (event.type) {
    case 'agent:text':
      return { event: 'stream:text', data: { delta: event.content } }
    case 'agent:thinking':
      return { event: 'stream:thinking', data: { content: event.content } }
    case 'agent:tool_call':
      return {
        event: 'stream:tool_call',
        data: { toolCallId: event.toolCallId, name: event.toolName, input: event.input },
      }
    case 'agent:tool_result':
      return {
        event: 'stream:tool_result',
        data: {
          toolCallId: event.toolCallId,
          name: event.toolName,
          output: event.output,
          isError: event.isError,
        },
      }
    case 'agent:tool_progress':
      return {
        event: 'stream:tool_progress',
        data: { toolCallId: event.toolCallId, toolName: event.toolName, message: event.message },
      }
    case 'agent:error':
      return {
        event: 'stream:error',
        data: {
          error: event.error,
          recoverable: event.recoverable,
          ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
        },
      }
    case 'agent:done':
      return {
        event: 'stream:done',
        data: {
          usage: event.usage,
          turnCount: event.turnCount,
          ...(event.model !== undefined ? { model: event.model } : {}),
        },
      }
    case 'agent:compacted':
      return {
        event: 'stream:compacted',
        data: {
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
          auto: event.auto,
        },
      }
    case 'agent:turn_end':
      return { event: 'stream:turn_end', data: {} }
    case 'agent:tool_call_preview':
      // Intentionally dropped — clients don't need preview events over the wire.
      return null
    default:
      return null
  }
}

/**
 * Reverse mapping: decode a wire envelope back to an `AgentEvent`.
 * Useful for clients that want a uniform `AgentEvent` stream (testing,
 * replay tools, future mobile-direct mode). Returns `null` for unknown
 * envelopes or those whose data shape is invalid.
 */
export function decodeStreamMessage(msg: WireStreamMessage): AgentEvent | null {
  if (!msg || typeof msg.event !== 'string') return null
  const data = (msg.data ?? {}) as Record<string, unknown>

  switch (msg.event) {
    case 'stream:text':
      if (typeof data.delta !== 'string') return null
      return { type: 'agent:text', content: data.delta }
    case 'stream:thinking':
      if (typeof data.content !== 'string') return null
      return { type: 'agent:thinking', content: data.content }
    case 'stream:tool_call':
      if (typeof data.toolCallId !== 'string' || typeof data.name !== 'string') return null
      return {
        type: 'agent:tool_call',
        toolCallId: data.toolCallId,
        toolName: data.name,
        input: (data.input ?? {}) as Record<string, unknown>,
      }
    case 'stream:tool_result':
      if (typeof data.toolCallId !== 'string' || typeof data.name !== 'string') return null
      return {
        type: 'agent:tool_result',
        toolCallId: data.toolCallId,
        toolName: data.name,
        output: typeof data.output === 'string' ? data.output : '',
        isError: data.isError === true,
      }
    case 'stream:tool_progress':
      if (typeof data.toolCallId !== 'string' || typeof data.toolName !== 'string') return null
      return {
        type: 'agent:tool_progress',
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        message: typeof data.message === 'string' ? data.message : '',
      }
    case 'stream:error':
      if (typeof data.error !== 'string') return null
      return {
        type: 'agent:error',
        error: data.error,
        recoverable: data.recoverable === true,
        ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
      }
    case 'stream:done':
      if (typeof data.turnCount !== 'number') return null
      return {
        type: 'agent:done',
        usage: data.usage as AgentEvent extends { type: 'agent:done'; usage: infer U } ? U : never,
        turnCount: data.turnCount,
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
      }
    case 'stream:compacted':
      if (typeof data.beforeTokens !== 'number' || typeof data.afterTokens !== 'number') return null
      return {
        type: 'agent:compacted',
        beforeTokens: data.beforeTokens,
        afterTokens: data.afterTokens,
        auto: data.auto === true,
      }
    case 'stream:turn_end':
      return { type: 'agent:turn_end' }
    default:
      return null
  }
}
