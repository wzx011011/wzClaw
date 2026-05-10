// ============================================================
// Message Utilities — Image stripping, content extraction, etc.
// Migrated from Claude Code compact.ts stripImagesFromMessages etc.
// ============================================================

import type { Message, UserMessage } from '../../shared/types'

/**
 * Strip image blocks from user messages before sending for compaction.
 * Images are not needed for generating a conversation summary and can
 * cause the compaction API call itself to hit the prompt-too-long limit.
 * Replaces images with a text marker so the summary still notes that
 * an image was shared.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message
    const userMsg = message as UserMessage
    if (!userMsg.images || userMsg.images.length === 0) return message

    const imgCount = userMsg.images.length
    const marker = '[' + imgCount + ' image' + (imgCount > 1 ? 's' : '') + ']'

    return {
      ...userMsg,
      content: (typeof userMsg.content === 'string' ? userMsg.content : '') + '\n' + marker,
      images: undefined,
    }
  })
}

/**
 * No-op in wzxClaw — we do not have Claude Code's attachment system.
 * Kept as a passthrough so the compact pipeline stays consistent.
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages
}

/**
 * Extract text content from a message for summarization.
 * Handles both string content and structured content (tool calls etc).
 */
export function extractMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  return JSON.stringify(message.content)
}

/**
 * Format a message for inclusion in the compact prompt.
 * Includes role, timestamp, and content (with tool call details for assistants).
 */
export function formatMessageForSummary(message: Message): string {
  const ts = message.timestamp
    ? new Date(message.timestamp).toISOString().slice(11, 19)
    : '??:??:??'
  const prefix = '[' + message.role + ' @' + ts + ']'

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    const toolNames = message.toolCalls.map(tc => tc.name + '(' + JSON.stringify(tc.input).slice(0, 200) + ')').join(', ')
    const textContent = typeof message.content === 'string' ? message.content : ''
    return prefix + ' ' + textContent + '\n[Tools: ' + toolNames + ']'
  }

  if (message.role === 'tool_result') {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    const truncated = content.length > 2000
      ? content.slice(0, 2000) + '\n[... tool result truncated for compact ...]'
      : content
    return prefix + ' [tool_result for ' + (message as any).toolCallId + ']:\n' + truncated
  }

  return prefix + ' ' + (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
}
