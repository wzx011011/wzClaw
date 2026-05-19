import { describe, it, expect } from 'vitest'
import { encodeAgentEvent, decodeStreamMessage } from '../wire-codec.js'
import type { AgentEvent } from '../types.js'
import type { TokenUsage } from '../../types.js'

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

describe('wire-codec', () => {
  describe('encodeAgentEvent', () => {
    it('encodes agent:text', () => {
      const out = encodeAgentEvent({ type: 'agent:text', content: 'hi' })
      expect(out).toEqual({ event: 'stream:text', data: { delta: 'hi' } })
    })

    it('encodes agent:thinking', () => {
      const out = encodeAgentEvent({ type: 'agent:thinking', content: 'pondering' })
      expect(out).toEqual({ event: 'stream:thinking', data: { content: 'pondering' } })
    })

    it('encodes agent:tool_call', () => {
      const out = encodeAgentEvent({
        type: 'agent:tool_call',
        toolCallId: 'tc1',
        toolName: 'FileRead',
        input: { path: '/x' },
      })
      expect(out).toEqual({
        event: 'stream:tool_call',
        data: { toolCallId: 'tc1', name: 'FileRead', input: { path: '/x' } },
      })
    })

    it('encodes agent:tool_result', () => {
      const out = encodeAgentEvent({
        type: 'agent:tool_result',
        toolCallId: 'tc1',
        toolName: 'FileRead',
        output: 'contents',
        isError: false,
      })
      expect(out).toEqual({
        event: 'stream:tool_result',
        data: { toolCallId: 'tc1', name: 'FileRead', output: 'contents', isError: false },
      })
    })

    it('encodes agent:tool_progress', () => {
      const out = encodeAgentEvent({
        type: 'agent:tool_progress',
        toolCallId: 'tc1',
        toolName: 'Shell',
        message: 'running...',
      })
      expect(out).toEqual({
        event: 'stream:tool_progress',
        data: { toolCallId: 'tc1', toolName: 'Shell', message: 'running...' },
      })
    })

    it('encodes agent:error (with errorCode)', () => {
      const out = encodeAgentEvent({
        type: 'agent:error',
        error: 'boom',
        recoverable: true,
        errorCode: 'TURN_ERROR',
      })
      expect(out).toEqual({
        event: 'stream:error',
        data: { error: 'boom', recoverable: true, errorCode: 'TURN_ERROR' },
      })
    })

    it('encodes agent:error (without errorCode)', () => {
      const out = encodeAgentEvent({
        type: 'agent:error',
        error: 'boom',
        recoverable: false,
      })
      expect(out).toEqual({
        event: 'stream:error',
        data: { error: 'boom', recoverable: false },
      })
    })

    it('encodes agent:done', () => {
      const out = encodeAgentEvent({
        type: 'agent:done',
        usage,
        turnCount: 3,
        model: 'gpt-x',
      })
      expect(out).toEqual({
        event: 'stream:done',
        data: { usage, turnCount: 3, model: 'gpt-x' },
      })
    })

    it('encodes agent:compacted', () => {
      const out = encodeAgentEvent({
        type: 'agent:compacted',
        beforeTokens: 1000,
        afterTokens: 200,
        auto: true,
      })
      expect(out).toEqual({
        event: 'stream:compacted',
        data: { beforeTokens: 1000, afterTokens: 200, auto: true },
      })
    })

    it('encodes agent:turn_end', () => {
      const out = encodeAgentEvent({ type: 'agent:turn_end' })
      expect(out).toEqual({ event: 'stream:turn_end', data: {} })
    })

    it('drops agent:tool_call_preview', () => {
      const out = encodeAgentEvent({
        type: 'agent:tool_call_preview',
        toolCallId: 'tc1',
        toolName: 'FileRead',
      })
      expect(out).toBeNull()
    })
  })

  describe('decodeStreamMessage', () => {
    it('decodes stream:text', () => {
      expect(decodeStreamMessage({ event: 'stream:text', data: { delta: 'hi' } })).toEqual({
        type: 'agent:text',
        content: 'hi',
      })
    })

    it('decodes stream:tool_call', () => {
      expect(
        decodeStreamMessage({
          event: 'stream:tool_call',
          data: { toolCallId: 'tc1', name: 'FileRead', input: { path: '/x' } },
        }),
      ).toEqual({
        type: 'agent:tool_call',
        toolCallId: 'tc1',
        toolName: 'FileRead',
        input: { path: '/x' },
      })
    })

    it('decodes stream:turn_end', () => {
      expect(decodeStreamMessage({ event: 'stream:turn_end', data: {} })).toEqual({
        type: 'agent:turn_end',
      })
    })

    it('returns null for unknown event', () => {
      expect(decodeStreamMessage({ event: 'unknown', data: {} })).toBeNull()
    })

    it('returns null for invalid payload shape', () => {
      expect(decodeStreamMessage({ event: 'stream:text', data: {} })).toBeNull()
      expect(
        decodeStreamMessage({ event: 'stream:tool_call', data: { toolCallId: 'x' } }),
      ).toBeNull()
    })
  })

  describe('round-trip', () => {
    const events: AgentEvent[] = [
      { type: 'agent:text', content: 'hi' },
      { type: 'agent:thinking', content: 'reflecting' },
      {
        type: 'agent:tool_call',
        toolCallId: 'tc1',
        toolName: 'FileRead',
        input: { path: '/etc' },
      },
      {
        type: 'agent:tool_result',
        toolCallId: 'tc1',
        toolName: 'FileRead',
        output: 'data',
        isError: false,
      },
      {
        type: 'agent:tool_progress',
        toolCallId: 'tc1',
        toolName: 'Shell',
        message: 'running',
      },
      {
        type: 'agent:error',
        error: 'oops',
        recoverable: false,
        errorCode: 'CANCELLED',
      },
      { type: 'agent:done', usage, turnCount: 1, model: 'm1' },
      { type: 'agent:compacted', beforeTokens: 9, afterTokens: 3, auto: false },
      { type: 'agent:turn_end' },
    ]

    for (const ev of events) {
      it(`round-trips ${ev.type}`, () => {
        const wire = encodeAgentEvent(ev)
        expect(wire).not.toBeNull()
        const decoded = decodeStreamMessage(wire!)
        expect(decoded).toEqual(ev)
      })
    }
  })
})
