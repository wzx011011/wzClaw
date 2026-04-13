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
      }

      const stream = await this.client.chat.completions.create(params, {
        signal: options.abortSignal ?? undefined,
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
