---
plan: 01-02
phase: 01
wave: 1
depends_on: ["01"]
status: pending
requirements_addressed: [LLM-01, LLM-02, LLM-05, LLM-06]
files_modified:
  - src/main/llm/types.ts
  - src/main/llm/gateway.ts
  - src/main/llm/openai-adapter.ts
  - src/main/llm/anthropic-adapter.ts
  - src/main/llm/__tests__/openai-adapter.test.ts
  - src/main/llm/__tests__/anthropic-adapter.test.ts
  - src/main/llm/__tests__/gateway.test.ts
autonomous: true
---

# Plan 01-02: LLM Gateway with OpenAI + Anthropic Adapters

<objective>
Implement the LLM Gateway — a unified interface that streams responses from both OpenAI-compatible and Anthropic APIs. Each provider has its own adapter that normalizes streaming events into a common AsyncGenerator<StreamEvent> interface. Tool call accumulation handles partial JSON from both providers. System prompt is included in all requests.
</objective>

<must_haves>
- OpenAI adapter streams text responses token-by-token via AsyncGenerator
- Anthropic adapter streams text responses token-by-token via AsyncGenerator
- Tool call arguments accumulated from partial chunks into complete parsed JSON
- System prompt included in all LLM requests
- Gateway routes to correct adapter based on provider config
- All adapters have unit tests with mocked SDK calls
</must_haves>

## Tasks

<task type="auto">
  <id>01-02-01</id>
  <title>Create LLM Gateway types and interface</title>
  <read_first>
    - src/shared/types.ts (StreamEvent, LLMConfig, LLMProvider types)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-01 through D-07, D-21, D-22)
    - .planning/phases/01-foundation/01-RESEARCH.md (Pattern 1: Unified StreamEvent)
  </read_first>
  <action>
    Create `src/main/llm/types.ts`:

    ```typescript
    import type { StreamEvent, LLMProvider } from '../../shared/types'

    export interface ProviderConfig {
      provider: LLMProvider
      apiKey: string
      baseURL?: string
      defaultModel?: string
    }

    export interface StreamOptions {
      model: string
      messages: Array<{ role: string; content: unknown }>
      systemPrompt?: string
      maxTokens?: number
      temperature?: number
      tools?: Array<{
        name: string
        description: string
        input_schema: Record<string, unknown>
      }>
      abortSignal?: AbortSignal
    }

    export interface LLMAdapter {
      readonly provider: LLMProvider
      stream(options: StreamOptions): AsyncGenerator<StreamEvent>
    }
    ```

    Create `src/main/llm/gateway.ts`:

    ```typescript
    import type { StreamEvent, LLMProvider } from '../../shared/types'
    import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'
    import { OpenAIAdapter } from './openai-adapter'
    import { AnthropicAdapter } from './anthropic-adapter'

    export class LLMGateway {
      private adapters: Map<LLMProvider, LLMAdapter> = new Map()

      addProvider(config: ProviderConfig): void {
        switch (config.provider) {
          case 'openai':
            this.adapters.set('openai', new OpenAIAdapter(config))
            break
          case 'anthropic':
            this.adapters.set('anthropic', new AnthropicAdapter(config))
            break
          default:
            throw new Error(`Unknown provider: ${config.provider}`)
        }
      }

      async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
        const provider = this.detectProvider(options.model)
        const adapter = this.adapters.get(provider)
        if (!adapter) {
          yield { type: 'error', error: `No adapter configured for provider: ${provider}` }
          return
        }
        yield* adapter.stream(options)
      }

      private detectProvider(model: string): LLMProvider {
        if (model.startsWith('claude')) return 'anthropic'
        return 'openai' // OpenAI, DeepSeek, and any OpenAI-compatible endpoint
      }

      getAdapter(provider: LLMProvider): LLMAdapter | undefined {
        return this.adapters.get(provider)
      }

      hasProvider(provider: LLMProvider): boolean {
        return this.adapters.has(provider)
      }
    }
    ```
  </action>
  <acceptance_criteria>
    - `src/main/llm/types.ts` exports: ProviderConfig, StreamOptions, LLMAdapter
    - `src/main/llm/gateway.ts` exports: LLMGateway class
    - LLMGateway has `stream()` method returning AsyncGenerator<StreamEvent>
    - LLMGateway has `addProvider()`, `detectProvider()`, `hasProvider()` methods
    - `detectProvider('gpt-4o')` returns 'openai'
    - `detectProvider('claude-sonnet-4-20250514')` returns 'anthropic'
    - `detectProvider('deepseek-chat')` returns 'openai'
    - `npx tsc --noEmit` passes
  </acceptance_criteria>
  <automated>grep 'class LLMGateway' src/main/llm/gateway.ts && grep 'LLMAdapter' src/main/llm/types.ts</automated>
</task>

<task type="auto">
  <id>01-02-02</id>
  <title>Implement OpenAI adapter with streaming and tool call accumulation</title>
  <read_first>
    - .planning/phases/01-foundation/01-RESEARCH.md (Pattern 2: OpenAI Adapter Streaming)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-01, D-03, D-05, D-07, D-21)
    - src/main/llm/types.ts (LLMAdapter interface)
    - src/shared/types.ts (StreamEvent types)
  </read_first>
  <action>
    Create `src/main/llm/openai-adapter.ts`:

    ```typescript
    import OpenAI from 'openai'
    import type { StreamEvent } from '../../shared/types'
    import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'

    interface ToolCallAccumulator {
      id: string
      name: string
      arguments: string
    }

    export class OpenAIAdapter implements LLMAdapter {
      readonly provider = 'openai' as const
      private client: OpenAI

      constructor(config: ProviderConfig) {
        this.client = new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL, // undefined for OpenAI, https://api.deepseek.com for DeepSeek
        })
      }

      async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
        try {
          const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: options.model,
            messages: options.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            stream: true,
            ...(options.maxTokens && { max_tokens: options.maxTokens }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
            ...(options.tools && {
              tools: options.tools.map(t => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
            }),
          }

          const stream = await this.client.chat.completions.create(params, {
            signal: options.abortSignal ?? undefined,
          })

          const toolCalls = new Map<number, ToolCallAccumulator>()

          for await (const chunk of stream) {
            const choice = chunk.choices[0]
            if (!choice) continue

            const delta = choice.delta

            // Text content
            if (delta?.content) {
              yield { type: 'text_delta', content: delta.content }
            }

            // Tool call deltas — accumulate partial JSON
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls.has(tc.index)) {
                  toolCalls.set(tc.index, {
                    id: tc.id || '',
                    name: tc.function?.name || '',
                    arguments: '',
                  })
                }
                const acc = toolCalls.get(tc.index)!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.arguments += tc.function.arguments
              }
            }

            // Finish
            if (choice.finish_reason === 'tool_calls') {
              for (const [, acc] of toolCalls) {
                try {
                  const parsedInput = JSON.parse(acc.arguments)
                  yield { type: 'tool_use_start', id: acc.id, name: acc.name }
                  yield { type: 'tool_use_end', id: acc.id, parsedInput }
                } catch {
                  yield { type: 'error', error: `Failed to parse tool call arguments: ${acc.arguments}` }
                }
              }
            }

            if (choice.finish_reason === 'stop' || chunk.choices[0]?.finish_reason != null) {
              // Extract usage from final chunk if available
              const usage = chunk.usage
              yield {
                type: 'done',
                usage: {
                  inputTokens: usage?.prompt_tokens ?? 0,
                  outputTokens: usage?.completion_tokens ?? 0,
                },
              }
              return
            }
          }

          // If we got here without a done event, yield one
          yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } }
        } catch (error) {
          yield {
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }
    }
    ```

    Create `src/main/llm/__tests__/openai-adapter.test.ts`:

    ```typescript
    import { describe, it, expect, vi } from 'vitest'
    import { OpenAIAdapter } from '../openai-adapter'

    // Mock the OpenAI SDK
    vi.mock('openai', () => {
      return {
        default: class MockOpenAI {
          chat = {
            completions: {
              create: vi.fn(),
            },
          }
        },
      }
    })

    describe('OpenAIAdapter', () => {
      it('has provider openai', () => {
        const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })
        expect(adapter.provider).toBe('openai')
      })

      it('streams text_delta events', async () => {
        const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'test-key' })

        // Get the mock and set up streaming response
        const OpenAI = (await import('openai')).default
        const mockInstance = new OpenAI({ apiKey: 'test' })
        const createMock = mockInstance.chat.completions.create as ReturnType<typeof vi.fn>

        // Simulate streaming chunks
        createMock.mockImplementation(async function* () {
          yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }
          yield { choices: [{ delta: { content: ' world' }, finish_reason: null }] }
          yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        })

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
      })
    })
    ```
  </action>
  <acceptance_criteria>
    - `src/main/llm/openai-adapter.ts` exports: OpenAIAdapter class
    - OpenAIAdapter implements LLMAdapter interface
    - OpenAIAdapter.stream() returns AsyncGenerator<StreamEvent>
    - Constructor accepts ProviderConfig with apiKey and optional baseURL
    - Text content chunks yield `text_delta` events
    - Tool call chunks are accumulated and yield `tool_use_start` + `tool_use_end` events
    - System prompt is included in API request params
    - Error handling wraps the entire stream in try/catch
    - `npx tsc --noEmit` passes
  </acceptance_criteria>
  <automated>grep 'class OpenAIAdapter' src/main/llm/openai-adapter.ts</automated>
</task>

<task type="auto">
  <id>01-02-03</id>
  <title>Implement Anthropic adapter with streaming and tool call accumulation</title>
  <read_first>
    - .planning/phases/01-foundation/01-RESEARCH.md (Pattern 3: Anthropic Adapter Streaming)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-02, D-03, D-05, D-07, D-21)
    - .planning/phases/01-foundation/PITFALLS.md (PIT-06: Multi-LLM format differences)
    - src/main/llm/types.ts (LLMAdapter interface)
    - src/shared/types.ts (StreamEvent types)
  </read_first>
  <action>
    Create `src/main/llm/anthropic-adapter.ts`:

    ```typescript
    import Anthropic from '@anthropic-ai/sdk'
    import type { StreamEvent } from '../../shared/types'
    import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'

    export class AnthropicAdapter implements LLMAdapter {
      readonly provider = 'anthropic' as const
      private client: Anthropic

      constructor(config: ProviderConfig) {
        this.client = new Anthropic({ apiKey: config.apiKey })
      }

      async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
        try {
          const params: Anthropic.MessageCreateParams = {
            model: options.model,
            max_tokens: options.maxTokens ?? 8192,
            messages: options.messages
              .filter(m => m.role !== 'system')
              .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content as string,
              })),
            ...(options.systemPrompt && { system: options.systemPrompt }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
          }

          const stream = this.client.messages.stream(params)

          // Track tool call accumulators: contentBlockIndex -> accumulated JSON
          const toolAccumulators = new Map<number, { id: string; name: string; json: string }>()

          for await (const event of stream) {
            switch (event.type) {
              case 'content_block_start': {
                if (event.content_block.type === 'tool_use') {
                  toolAccumulators.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    json: '',
                  })
                  yield {
                    type: 'tool_use_start',
                    id: event.content_block.id,
                    name: event.content_block.name,
                  }
                }
                break
              }

              case 'content_block_delta': {
                if (event.delta.type === 'text_delta') {
                  yield { type: 'text_delta', content: event.delta.text }
                }
                if (event.delta.type === 'input_json_delta') {
                  const acc = toolAccumulators.get(event.index)
                  if (acc) {
                    acc.json += event.delta.partial_json
                  }
                }
                break
              }

              case 'content_block_stop': {
                const acc = toolAccumulators.get(event.index)
                if (acc && acc.json) {
                  try {
                    const parsedInput = JSON.parse(acc.json)
                    yield { type: 'tool_use_end', id: acc.id, parsedInput }
                  } catch {
                    yield { type: 'error', error: `Failed to parse tool input JSON: ${acc.json.slice(0, 100)}` }
                  }
                }
                break
              }
            }
          }

          // Get usage from final message
          const finalMessage = await stream.finalMessage()
          yield {
            type: 'done',
            usage: {
              inputTokens: finalMessage.usage.input_tokens,
              outputTokens: finalMessage.usage.output_tokens,
            },
          }
        } catch (error) {
          yield {
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }
    }
    ```

    Create `src/main/llm/__tests__/anthropic-adapter.test.ts`:

    ```typescript
    import { describe, it, expect, vi } from 'vitest'
    import { AnthropicAdapter } from '../anthropic-adapter'

    vi.mock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          stream: vi.fn(),
        }
      },
    }))

    describe('AnthropicAdapter', () => {
      it('has provider anthropic', () => {
        const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
        expect(adapter.provider).toBe('anthropic')
      })

      it('streams text_delta events from Anthropic stream', async () => {
        const adapter = new AnthropicAdapter({ provider: 'anthropic', apiKey: 'test-key' })
        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const mockInstance = new Anthropic({ apiKey: 'test' })
        const streamMock = mockInstance.messages.stream as ReturnType<typeof vi.fn>

        streamMock.mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Claude' } }
            yield { type: 'content_block_stop', index: 0 }
          },
          finalMessage: async () => ({ usage: { input_tokens: 20, output_tokens: 10 } }),
        })

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

        const doneEvents = events.filter(e => e.type === 'done')
        expect(doneEvents).toHaveLength(1)
      })
    })
    ```
  </action>
  <acceptance_criteria>
    - `src/main/llm/anthropic-adapter.ts` exports: AnthropicAdapter class
    - AnthropicAdapter implements LLMAdapter interface
    - Handles `content_block_start/delta/stop` event types
    - `text_delta` events yield from `content_block_delta` with `delta.type === 'text_delta'`
    - Tool use accumulated from `input_json_delta` partial JSON chunks
    - `max_tokens` defaults to 8192 (Anthropic requires it)
    - System prompt sent as `system` field (not in messages array)
    - `npx tsc --noEmit` passes
  </acceptance_criteria>
  <automated>grep 'class AnthropicAdapter' src/main/llm/anthropic-adapter.ts</automated>
</task>

<task type="auto">
  <id>01-02-04</id>
  <title>Create Gateway integration tests</title>
  <read_first>
    - src/main/llm/gateway.ts
    - src/main/llm/openai-adapter.ts
    - src/main/llm/anthropic-adapter.ts
    - src/shared/types.ts
  </read_first>
  <action>
    Create `src/main/llm/__tests__/gateway.test.ts`:

    ```typescript
    import { describe, it, expect } from 'vitest'
    import { LLMGateway } from '../gateway'

    describe('LLMGateway', () => {
      it('detects openai provider for gpt models', () => {
        const gateway = new LLMGateway()
        // Access private method via any
        expect((gateway as any).detectProvider('gpt-4o')).toBe('openai')
        expect((gateway as any).detectProvider('gpt-4o-mini')).toBe('openai')
      })

      it('detects openai provider for deepseek models', () => {
        const gateway = new LLMGateway()
        expect((gateway as any).detectProvider('deepseek-chat')).toBe('openai')
        expect((gateway as any).detectProvider('deepseek-reasoner')).toBe('openai')
      })

      it('detects anthropic provider for claude models', () => {
        const gateway = new LLMGateway()
        expect((gateway as any).detectProvider('claude-sonnet-4-20250514')).toBe('anthropic')
        expect((gateway as any).detectProvider('claude-3-5-haiku-20241022')).toBe('anthropic')
      })

      it('addProvider creates adapter for openai', () => {
        const gateway = new LLMGateway()
        gateway.addProvider({ provider: 'openai', apiKey: 'test-key' })
        expect(gateway.hasProvider('openai')).toBe(true)
        expect(gateway.hasProvider('anthropic')).toBe(false)
      })

      it('addProvider creates adapter for anthropic', () => {
        const gateway = new LLMGateway()
        gateway.addProvider({ provider: 'anthropic', apiKey: 'test-key' })
        expect(gateway.hasProvider('anthropic')).toBe(true)
      })

      it('stream yields error for missing provider', async () => {
        const gateway = new LLMGateway()
        const events = []
        for await (const event of gateway.stream({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          events.push(event)
        }
        expect(events[0].type).toBe('error')
      })
    })
    ```
  </action>
  <acceptance_criteria>
    - `src/main/llm/__tests__/gateway.test.ts` exists
    - Test covers: provider detection for OpenAI, DeepSeek, Anthropic models
    - Test covers: addProvider creates correct adapters
    - Test covers: stream yields error when provider not configured
    - `npx vitest run src/main/llm/__tests__/gateway.test.ts` passes
  </acceptance_criteria>
  <automated>npx vitest run src/main/llm/__tests__/gateway.test.ts</automated>
</task>

<verification>
1. `npx vitest run src/main/llm/__tests__/` — all tests pass
2. `npx tsc --noEmit` — no type errors
3. Gateway correctly routes to OpenAI adapter for gpt/deepseek models
4. Gateway correctly routes to Anthropic adapter for claude models
</verification>

<success_criteria>
- LLMGateway with provider routing based on model name
- OpenAI adapter streams text + accumulates tool calls from partial JSON
- Anthropic adapter streams text + accumulates tool calls from content_block events
- System prompt included in all requests
- Error handling wraps all streaming in try/catch
- All unit tests pass with mocked SDK calls
</success_criteria>

<output>
After completion, create `.planning/phases/01-foundation/02-SUMMARY.md`
</output>
