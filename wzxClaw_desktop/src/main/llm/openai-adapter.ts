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
      const isDeepSeekV4 = options.model.startsWith('deepseek-v4')
      const isDeepSeekReasoner = options.model === 'deepseek-reasoner'
      const isOpenAIReasoner = options.model.startsWith('o1') || options.model.startsWith('o3') || options.model.startsWith('o4')

      // deepseek-v4 thinking mode：若历史消息含 reasoning_content，说明之前在 thinking mode，
      // 必须在本次请求也显式开启，否则 API 400 "reasoning_content must be passed back"
      const hasReasoningHistory = (options.messages as Array<Record<string, unknown>>)
        .some(m => m['role'] === 'assistant' && m['reasoning_content'])
      const enableDeepSeekV4Thinking = isDeepSeekV4 && (
        (options.thinkingDepth && options.thinkingDepth !== 'none') || hasReasoningHistory
      )

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: options.model,
        messages: options.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: true,
        ...(options.systemPrompt && {
          messages: [
            { role: 'system', content: options.systemPrompt },
            ...(options.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
          ],
        }),
        ...(options.maxTokens && { max_tokens: options.maxTokens }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && {
          tools: options.tools.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
        }),
        // deepseek-v4-pro/flash：显式启用 thinking mode + reasoning_effort
        ...(enableDeepSeekV4Thinking && {
          thinking: { type: 'enabled' } as any,
          reasoning_effort: (options.thinkingDepth && options.thinkingDepth !== 'none')
            ? options.thinkingDepth
            : 'high',
        }),
        // OpenAI o-series：只传 reasoning_effort
        ...(isOpenAIReasoner && options.thinkingDepth && options.thinkingDepth !== 'none'
          && { reasoning_effort: options.thinkingDepth }),
      }

      // deepseek-reasoner 多轮对话：reasoning_content 不能传回 API，否则 400
      if (isDeepSeekReasoner) {
        params.messages = (params.messages as Array<Record<string, unknown>>).map(m => {
          if (m['role'] === 'assistant' && m['reasoning_content']) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { reasoning_content: _rc, ...rest } = m
            return rest
          }
          return m
        }) as OpenAI.Chat.Completions.ChatCompletionMessageParam[]
      }

      const stream = await this.client.chat.completions.create(params, {
        signal: options.abortSignal ?? undefined,
        timeout: options.timeoutMs ?? 600_000,
      })

      const toolCalls = new Map<number, ToolCallAccumulator>()
      let lastUsage = { inputTokens: 0, outputTokens: 0 }

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        // Text content
        if (delta?.content) {
          yield { type: 'text_delta', content: delta.content }
        }

        // DeepSeek reasoning_content（扩展思考模式）— 作为 thinking_delta 发出
        const anyDelta = delta as Record<string, unknown> | undefined
        if (anyDelta?.['reasoning_content'] && typeof anyDelta['reasoning_content'] === 'string') {
          yield { type: 'thinking_delta', content: anyDelta['reasoning_content'] }
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

        // Finish — tool calls
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
          // Capture usage from the tool_calls finish chunk (don't yield done — agent loop continues)
          const usage = chunk.usage
          if (usage) {
            lastUsage = { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 }
          }
        }

        // Finish — only yield done for 'stop' (not 'tool_calls')
        if (choice.finish_reason === 'stop') {
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

      // If we got here without a done event (e.g. tool_calls finish), yield one with captured usage
      yield { type: 'done', usage: lastUsage }
    } catch (error) {
      yield {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
