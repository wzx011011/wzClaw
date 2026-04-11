import Anthropic from '@anthropic-ai/sdk'
import type { StreamEvent } from '../../shared/types'
import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'

export class AnthropicAdapter implements LLMAdapter {
  readonly provider = 'anthropic' as const
  private client: Anthropic

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      authToken: config.apiKey,
      apiKey: null as any,
      ...(config.baseURL && { baseURL: config.baseURL }),
    })
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    try {
      // Build system prompt as array with cache_control on the last block
      // so that long system prompts are cached across turns.
      const systemContent: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined =
        options.systemPrompt
          ? [{ type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } }]
          : undefined

      // Clone messages (excluding system) and mark the second-to-last user
      // message with cache_control so multi-turn history is cached.
      const rawMessages = options.messages.filter((m) => m.role !== 'system') as Anthropic.MessageParam[]
      const messages = rawMessages.map((m) => ({ ...m }))

      const userIndices: number[] = []
      messages.forEach((m, i) => { if (m.role === 'user') userIndices.push(i) })

      // Mark second-to-last user message (the oldest one still worth caching)
      if (userIndices.length >= 2) {
        const targetIdx = userIndices[userIndices.length - 2]
        const msg = messages[targetIdx]
        if (typeof msg.content === 'string') {
          messages[targetIdx] = {
            ...msg,
            content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] as any
          }
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const blocks = [...msg.content]
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } } as any
          messages[targetIdx] = { ...msg, content: blocks }
        }
      }

      const params: any = {
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        messages,
        ...(systemContent && { system: systemContent }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && options.tools.length > 0 && {
          tools: options.tools as Anthropic.Tool[],
        }),
      }

      // Enable prompt caching beta
      const stream = this.client.messages.stream(params, {
        headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
      } as any)

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

      // Get usage from final message, including cache tokens if available
      const finalMessage = await stream.finalMessage()
      const usage = finalMessage.usage as any
      yield {
        type: 'done',
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
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

