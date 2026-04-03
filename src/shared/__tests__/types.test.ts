import { describe, it, expect } from 'vitest'
import {
  UserMessageSchema,
  TokenUsageSchema,
  StreamEventSchema,
  type StreamEvent,
  type Message
} from '../types'

describe('UserMessageSchema', () => {
  it('accepts valid user message', () => {
    const result = UserMessageSchema.safeParse({
      role: 'user',
      content: 'Hello',
      timestamp: Date.now()
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty content', () => {
    const result = UserMessageSchema.safeParse({
      role: 'user',
      content: '',
      timestamp: Date.now()
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong role', () => {
    const result = UserMessageSchema.safeParse({
      role: 'assistant',
      content: 'Hello',
      timestamp: Date.now()
    })
    expect(result.success).toBe(false)
  })
})

describe('StreamEventSchema', () => {
  it('validates text_delta event', () => {
    const result = StreamEventSchema.safeParse({
      type: 'text_delta',
      content: 'hello'
    })
    expect(result.success).toBe(true)
  })

  it('validates tool_use_end event', () => {
    const result = StreamEventSchema.safeParse({
      type: 'tool_use_end',
      id: 'call_123',
      parsedInput: { file_path: '/foo.ts' }
    })
    expect(result.success).toBe(true)
  })

  it('validates done event', () => {
    const result = StreamEventSchema.safeParse({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50 }
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown event type', () => {
    const result = StreamEventSchema.safeParse({
      type: 'unknown',
      data: 'hello'
    })
    expect(result.success).toBe(false)
  })
})

describe('TypeScript type narrowing', () => {
  it('Message union type compiles correctly', () => {
    const userMsg: Message = {
      role: 'user',
      content: 'test',
      timestamp: Date.now()
    }
    expect(userMsg.role).toBe('user')

    const toolResult: Message = {
      role: 'tool_result',
      toolCallId: 'call_1',
      content: 'result',
      isError: false,
      timestamp: Date.now()
    }
    expect(toolResult.role).toBe('tool_result')
  })

  it('StreamEvent union type narrows correctly', () => {
    const event: StreamEvent = {
      type: 'text_delta',
      content: 'hello'
    }
    if (event.type === 'text_delta') {
      expect(event.content).toBe('hello')
    }
  })
})
