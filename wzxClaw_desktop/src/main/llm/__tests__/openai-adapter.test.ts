import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIAdapter } from '../openai-adapter'
import type { StreamOptions } from '../types'

// We need to mock the OpenAI module so that when the adapter does
// `new OpenAI(...)`, it gets our mock whose `chat.completions.create`
// returns an async iterable we control.

const mockCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      }
    },
  }
})

describe('OpenAIAdapter', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('has provider openai', () => {
    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    expect(adapter.provider).toBe('openai')
  })

  it('streams text_delta events', async () => {
    // Simulate streaming chunks: two text deltas, then a stop
    mockCreate.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }
      yield { choices: [{ delta: { content: ' world' }, finish_reason: null }] }
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }
    })

    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    const textEvents = events.filter(e => e.type === 'text_delta')
    expect(textEvents).toHaveLength(2)
    expect(textEvents[0]).toEqual({ type: 'text_delta', content: 'Hello' })
    expect(textEvents[1]).toEqual({ type: 'text_delta', content: ' world' })

    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]).toEqual({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it('accumulates tool call chunks into complete parsed JSON', async () => {
    // Simulate tool call streaming: partial JSON arguments split across chunks
    mockCreate.mockImplementation(async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
      }
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"file' } }],
            },
            finish_reason: null,
          },
        ],
      }
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'path":"/tmp/a.ts"}' } }],
            },
            finish_reason: null,
          },
        ],
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 15 } }
    })

    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'read the file' }],
    })) {
      events.push(event)
    }

    const toolStart = events.find(e => e.type === 'tool_use_start')
    expect(toolStart).toEqual({ type: 'tool_use_start', id: 'call_abc', name: 'read_file' })

    const toolEnd = events.find(e => e.type === 'tool_use_end')
    expect(toolEnd).toBeDefined()
    if (toolEnd && toolEnd.type === 'tool_use_end') {
      expect(toolEnd.id).toBe('call_abc')
      expect(toolEnd.parsedInput).toEqual({ filepath: '/tmp/a.ts' })
    }

    const doneEvent = events.find(e => e.type === 'done')
    expect(doneEvent).toBeDefined()
  })

  it('yields error event when API throws', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'))

    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].error).toContain('API rate limit exceeded')
    }
  })

  it('passes system prompt in messages', async () => {
    mockCreate.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: null }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }
    })

    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'You are a coding assistant.',
    })) {
      events.push(event)
    }

    // Verify the create call was made with system message
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0][0]
    // When systemPrompt is set, the first message should be system
    expect(callArgs.messages[0].role).toBe('system')
    expect(callArgs.messages[0].content).toBe('You are a coding assistant.')
  })

  it('passes tools to the API when provided', async () => {
    mockCreate.mockImplementation(async function* () {
      yield { choices: [{ delta: { content: 'using tool' }, finish_reason: null }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
    })

    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
    const events = []
    for await (const event of adapter.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'read file' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })) {
      events.push(event)
    }

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tools).toBeDefined()
    expect(callArgs.tools).toHaveLength(1)
    expect(callArgs.tools[0].type).toBe('function')
    expect(callArgs.tools[0].function.name).toBe('read_file')
  })
})
