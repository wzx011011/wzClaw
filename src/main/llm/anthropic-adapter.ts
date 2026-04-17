import Anthropic from '@anthropic-ai/sdk'
import type { StreamEvent } from '../../shared/types'
import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '../../shared/constants'

export class AnthropicAdapter implements LLMAdapter {
  readonly provider = 'anthropic' as const
  private client: Anthropic

  constructor(config: ProviderConfig) {
    // Use authToken (Bearer) for third-party Anthropic-compatible endpoints
    // that don't accept x-api-key. Most endpoints (ZhipuAI, etc.) accept x-api-key.
    const isRealAnthropic = !config.baseURL || config.baseURL.includes('anthropic.com')
    const clientOptions: Record<string, unknown> = { apiKey: config.apiKey }
    if (!isRealAnthropic) {
      // Third-party: suppress default auth header to avoid conflicts
      clientOptions.authToken = undefined
    }
    if (config.baseURL) clientOptions.baseURL = config.baseURL
    this.client = new Anthropic(clientOptions as ConstructorParameters<typeof Anthropic>[0])
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    try {
      // Build system prompt as array with cache_control on the static block.
      // If the prompt contains SYSTEM_PROMPT_CACHE_BOUNDARY, split into two blocks:
      //   Block 1 (static): tool defs + base prompt — cached across turns
      //   Block 2 (dynamic): env info, git, instructions, memory — not cached
      let systemContent: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined
      if (options.systemPrompt) {
        const boundaryIdx = options.systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)
        if (boundaryIdx !== -1) {
          const staticPart = options.systemPrompt.slice(0, boundaryIdx)
          const dynamicPart = options.systemPrompt.slice(boundaryIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length)
          systemContent = [
            { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
          ]
          if (dynamicPart.trim()) {
            systemContent.push({ type: 'text', text: dynamicPart })
          }
        } else {
          systemContent = [{ type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } }]
        }
      }

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

      // Normalize tool schemas: ensure every tool has a valid input_schema
      // with type:"object" and properties:{} — Anthropic API rejects bare {} schemas.
      // Mark the last tool with cache_control for a 3rd cache breakpoint:
      //   BP1: static system prompt, BP2: tool definitions, BP3: conversation history
      const normalizedTools = options.tools?.map((t, i, arr) => ({
        ...t,
        input_schema: {
          type: 'object' as const,
          ...t.input_schema,
          properties: (t.input_schema?.properties as Record<string, unknown>) ?? {},
        },
        ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }))

      const params: any = {
        model: options.model,
        max_tokens: options.maxTokens ?? 8192,
        messages,
        ...(systemContent && { system: systemContent }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(normalizedTools && normalizedTools.length > 0 && {
          tools: normalizedTools as Anthropic.Tool[],
        }),
      }

      // Inject thinking + effort params based on thinkingDepth setting
      // Only apply to real Anthropic API — third-party endpoints may not support these
      const isRealAnthropic = !options.model.startsWith('deepseek') &&
        (!this.client.baseURL || this.client.baseURL.includes('anthropic.com'))
      const depth = options.thinkingDepth
      if (depth && depth !== 'none' && isRealAnthropic) {
        params.output_config = { effort: depth }
        if (depth === 'medium' || depth === 'high') {
          // Use reasonable fixed budget — not max_tokens-1 which leaves zero room for output
          const budgetMap = { medium: 8192, high: 16384 }
          params.thinking = { type: 'enabled', budget_tokens: budgetMap[depth] }
          // Ensure max_tokens is large enough to hold output after thinking
          if (!options.maxTokens || options.maxTokens < 8192) {
            params.max_tokens = 16384
          }
        }
      }

      // Enable prompt caching beta — pass abort signal so stop button kills the HTTP request
      const betas = ['prompt-caching-2024-07-31']
      if (depth && depth !== 'none' && isRealAnthropic) {
        betas.push('interleaved-thinking-2025-05-14')
        betas.push('effort-2025-11-24')
      }
      const stream = this.client.messages.stream(params, {
        headers: { 'anthropic-beta': betas.join(',') },
        signal: options.abortSignal,
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
            // Thinking block — emit empty thinking_delta so UI shows thinking state
            if ((event.content_block as any).type === 'thinking') {
              yield { type: 'thinking_delta', content: '' }
            }
            break
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', content: event.delta.text }
            }
            // Thinking delta — forward thinking content to UI
            if ((event.delta as any).type === 'thinking_delta') {
              yield { type: 'thinking_delta', content: (event.delta as any).thinking }
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
            if (acc && acc.json != null) {
              try {
                const parsedInput = JSON.parse(acc.json || '{}')
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
      // AbortError is a clean stop — don't emit an error event
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))) {
        return
      }
      yield {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

