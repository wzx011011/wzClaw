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
            content: msg.content
          }

          if (msg.toolCalls.length > 0) {
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

        case 'tool_result':
          result.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: msg.content
          })
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
          for (const tc of msg.toolCalls) {
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
