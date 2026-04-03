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
