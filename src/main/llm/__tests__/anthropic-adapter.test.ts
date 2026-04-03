import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicAdapter } from '../anthropic-adapter'

const mockStream = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      stream: mockStream,
    }
  },
}))

describe('AnthropicAdapter', () => {
  beforeEach(() => {
    mockStream.mockReset()
  })

  it('has provider anthropic', () => {
    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    expect(adapter.provider).toBe('anthropic')
  })

  it('streams text_delta events from Anthropic stream', async () => {
    mockStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Claude' } }
        yield { type: 'content_block_stop', index: 0 }
      },
      finalMessage: async () => ({ usage: { input_tokens: 20, output_tokens: 10 } }),
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    const textEvents = events.filter(e => e.type === 'text_delta')
    expect(textEvents).toHaveLength(2)
    expect(textEvents[0]).toEqual({ type: 'text_delta', content: 'Hello' })
    expect(textEvents[1]).toEqual({ type: 'text_delta', content: ' Claude' })

    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents).toHaveLength(1)
    if (doneEvents[0].type === 'done') {
      expect(doneEvents[0].usage).toEqual({ inputTokens: 20, outputTokens: 10 })
    }
  })

  it('accumulates tool use input_json_delta chunks into complete JSON', async () => {
    mockStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // Tool use block
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file' },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file' },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'path":"/tmp/test.ts"}' },
        }
        yield { type: 'content_block_stop', index: 0 }
      },
      finalMessage: async () => ({ usage: { input_tokens: 30, output_tokens: 20 } }),
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'read file' }],
    })) {
      events.push(event)
    }

    const toolStart = events.find(e => e.type === 'tool_use_start')
    expect(toolStart).toEqual({ type: 'tool_use_start', id: 'toolu_01', name: 'read_file' })

    const toolEnd = events.find(e => e.type === 'tool_use_end')
    expect(toolEnd).toBeDefined()
    if (toolEnd && toolEnd.type === 'tool_use_end') {
      expect(toolEnd.id).toBe('toolu_01')
      expect(toolEnd.parsedInput).toEqual({ filepath: '/tmp/test.ts' })
    }
  })

  it('defaults max_tokens to 8192', async () => {
    mockStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
        yield { type: 'content_block_stop', index: 0 }
      },
      finalMessage: async () => ({ usage: { input_tokens: 5, output_tokens: 1 } }),
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    expect(mockStream).toHaveBeenCalledTimes(1)
    const callArgs = mockStream.mock.calls[0][0]
    expect(callArgs.max_tokens).toBe(8192)
  })

  it('passes system prompt as separate system field', async () => {
    mockStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        yield { type: 'content_block_stop', index: 0 }
      },
      finalMessage: async () => ({ usage: { input_tokens: 5, output_tokens: 1 } }),
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are a coding assistant.',
    })) {
      events.push(event)
    }

    const callArgs = mockStream.mock.calls[0][0]
    expect(callArgs.system).toBe('You are a coding assistant.')
    // System messages should NOT be in the messages array
    expect(callArgs.messages.every(m => m.role !== 'system')).toBe(true)
  })

  it('yields error event when API throws', async () => {
    mockStream.mockImplementation(() => {
      throw new Error('Anthropic API error')
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].error).toContain('Anthropic API error')
    }
  })

  it('handles mixed text and tool use in same response', async () => {
    mockStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // Text block
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will read the file.' } }
        yield { type: 'content_block_stop', index: 0 }
        // Tool use block
        yield {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_02', name: 'list_files' },
        }
        yield {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"dir":"/src"}' },
        }
        yield { type: 'content_block_stop', index: 1 }
      },
      finalMessage: async () => ({ usage: { input_tokens: 25, output_tokens: 30 } }),
    })

    const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'list files' }],
    })) {
      events.push(event)
    }

    const textEvents = events.filter(e => e.type === 'text_delta')
    expect(textEvents).toHaveLength(1)
    expect(textEvents[0]).toEqual({ type: 'text_delta', content: 'I will read the file.' })

    const toolStart = events.filter(e => e.type === 'tool_use_start')
    expect(toolStart).toHaveLength(1)

    const toolEnd = events.filter(e => e.type === 'tool_use_end')
    expect(toolEnd).toHaveLength(1)
    if (toolEnd[0].type === 'tool_use_end') {
      expect(toolEnd[0].parsedInput).toEqual({ dir: '/src' })
    }
  })
})
