import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'
import type { Message } from '../../shared/types'

// Singleton encoder -- loaded once, reused across calls (per RESEARCH.md Pitfall 3)
const encoder = new Tiktoken(o200k_base)

/**
 * Count tokens in a text string using o200k_base BPE encoding.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  return encoder.encode(text).length
}

/**
 * Count tokens across an array of messages.
 * Includes per-message overhead (role, formatting, separators)
 * and tool call input tokens.
 */
export function countMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    // Per-message overhead (role, formatting, separators)
    total += 4
    total += countTokens(msg.content)

    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += countTokens(JSON.stringify(tc.input))
        total += 4 // tool call overhead
      }
    }
  }
  return total
}
