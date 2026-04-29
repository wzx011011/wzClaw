import type { Message, LLMProvider, ToolDefinition, ContentBlock } from '../../shared/types'

// ============================================================
// MessageBuilder (per D-25, D-26)
// ============================================================

/**
 * Converts internal Message[] to provider-specific format for LLM API calls.
 * OpenAI and Anthropic have different message schemas, especially for
 * tool calls and tool results.
 */
export class MessageBuilder {
  /**
   * Convert internal messages to provider-specific format.
   *
   * OpenAI format:
   *   - user: { role: 'user', content: string }
   *   - assistant: { role: 'assistant', content: string, tool_calls?: [...] }
   *   - tool_result: { role: 'tool', tool_call_id: string, content: string }
   *
   * Anthropic format:
   *   - user: { role: 'user', content: string }
   *   - assistant: { role: 'assistant', content: [{ type: 'text', text }, ...tool_use blocks] }
   *   - tool_result: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] }
   */
  buildMessages(
    internalMessages: Message[],
    provider: LLMProvider
  ): Array<{ role: string; content: unknown }> {
    if (provider === 'anthropic') {
      return this.buildAnthropicMessages(internalMessages)
    }
    return this.buildOpenAIMessages(internalMessages)
  }

  /**
   * Build system prompt with appended tool descriptions (per D-26).
   */
  buildSystemPrompt(basePrompt: string, toolDefinitions: ToolDefinition[]): string {
    if (toolDefinitions.length === 0) {
      return basePrompt
    }

    let prompt = basePrompt + '\n\n## Available Tools\n\n'

    for (const tool of toolDefinitions) {
      prompt += `### ${tool.name}\n\n${tool.description}\n\n`
      prompt += `Input Schema:\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n\n`
    }

    return prompt.trimEnd()
  }

  private buildOpenAIMessages(
    messages: Message[]
  ): Array<{ role: string; content: unknown }> {
    const result: Array<{ role: string; content: unknown }> = []

    for (const msg of messages) {
      switch (msg.role) {
        case 'user':
          result.push({ role: 'user', content: msg.content })
          break

        case 'assistant': {
          const openaiMsg: Record<string, unknown> = {
            role: 'assistant',
            // tool_calls 时 content 为空字符串，OpenAI/DeepSeek API 要求传 null 而非 ""
            content: msg.content || null
          }

          // DeepSeek 扩展思考：兼容内部 camelCase 和历史/SDK 原始 snake_case。
          const reasoningContent =
            (msg as Record<string, unknown>).reasoningContent ??
            (msg as Record<string, unknown>).reasoning_content
          if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
            openaiMsg.reasoning_content = reasoningContent
          }

          if ((msg.toolCalls?.length ?? 0) > 0) {
            openaiMsg.tool_calls = msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input)
              }
            }))
          }

          result.push(openaiMsg as { role: string; content: unknown })
          break
        }

        case 'tool_result': {
          // OpenAI 要求 tool 消息必须紧跟有 tool_calls 的 assistant 消息。
          // 上下文压缩或历史截断后可能出现孤立的 tool_result，需过滤掉，
          // 否则 API 返回 400 "Messages with role 'tool' must be a response to
          // a preceding message with 'tool_calls'"。
          const prev = result[result.length - 1]
          const prevHasToolCalls =
            prev?.role === 'assistant' &&
            Array.isArray((prev as Record<string, unknown>).tool_calls) &&
            ((prev as Record<string, unknown>).tool_calls as unknown[]).length > 0
          if (!prevHasToolCalls) break  // 跳过孤立的 tool_result

          result.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: msg.content
          })
          break
        }
      }
    }

    // 尾部清理：如果最后一条是没有后续 tool 消息的 assistant(tool_calls)，
    // OpenAI 要求每个 tool_call 必须有对应的 tool 回复，否则截掉该 assistant 消息。
    while (result.length > 0) {
      const last = result[result.length - 1]
      const lastToolCalls = (last as Record<string, unknown>).tool_calls as unknown[] | undefined
      if (last.role === 'assistant' && lastToolCalls && lastToolCalls.length > 0) {
        result.pop()
      } else {
        break
      }
    }

    return result
  }

  private buildAnthropicMessages(
    messages: Message[]
  ): Array<{ role: string; content: unknown }> {
    const result: Array<{ role: string; content: unknown }> = []

    for (const msg of messages) {
      switch (msg.role) {
        case 'user':
          result.push({ role: 'user', content: msg.content })
          break

        case 'assistant': {
          // Use contentBlocks if available (preserves interleaved text/tool ordering)
          if (msg.contentBlocks && msg.contentBlocks.length > 0) {
            const blocks = msg.contentBlocks.map((block: ContentBlock) => {
              if (block.type === 'text') {
                return { type: 'text', text: block.text }
              }
              if (block.type === 'thinking') {
                // Anthropic 要求原样回传 thinking block（含 signature）
                return { type: 'thinking', thinking: block.thinking, signature: block.signature }
              }
              return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
            })
            // Anthropic API rejects empty content arrays
            if (blocks.length === 0) {
              blocks.push({ type: 'text', text: ' ' })
            }
            result.push({ role: 'assistant', content: blocks })
            break
          }

          // Fallback: reconstruct from content + toolCalls (legacy messages)
          const contentBlocks: Array<Record<string, unknown>> = []

          // Add text block only if there's non-empty text content
          if (msg.content && msg.content.trim()) {
            contentBlocks.push({ type: 'text', text: msg.content })
          }

          // Add tool_use blocks
          for (const tc of (msg.toolCalls ?? [])) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input ?? {}
            })
          }

          // Anthropic API rejects empty content arrays — ensure at least one block
          if (contentBlocks.length === 0) {
            contentBlocks.push({ type: 'text', text: ' ' })
          }

          result.push({
            role: 'assistant',
            content: contentBlocks
          })
          break
        }

        case 'tool_result': {
          // Anthropic requires alternating roles. Merge consecutive tool_result
          // messages into a single 'user' message with multiple tool_result blocks.
          const toolBlock = {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: msg.content,
            is_error: msg.isError
          }
          const prev = result[result.length - 1]
          if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
            // Append to existing user message's content array
            ;(prev.content as Array<Record<string, unknown>>).push(toolBlock)
          } else {
            result.push({
              role: 'user',
              content: [toolBlock]
            })
          }
          break
        }
      }
    }

    return result
  }
}
