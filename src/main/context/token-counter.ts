import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'
import type { Message } from '../../shared/types'

// Singleton encoder -- loaded once, reused across calls (per RESEARCH.md Pitfall 3)
const encoder = new Tiktoken(o200k_base)

// Model-specific token count multipliers to correct for tokenizer differences.
// o200k_base (GPT-4o) is the base; other models' tokenizers produce different
// counts, so we apply a correction factor.
const MODEL_MULTIPLIERS: Record<string, number> = {
  // Claude models use a larger vocab — o200k overestimates by ~10%
  'claude': 0.90,
  // DeepSeek uses a different BPE — o200k underestimates slightly
  'deepseek': 1.05,
  // GLM models are broadly similar to GPT-4o
  'glm': 1.0,
}

function getMultiplier(modelId?: string): number {
  if (!modelId) return 1.0
  const lower = modelId.toLowerCase()
  for (const [prefix, mult] of Object.entries(MODEL_MULTIPLIERS)) {
    if (lower.startsWith(prefix)) return mult
  }
  return 1.0
}

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
 * Optionally applies a model-specific correction multiplier.
 */
export function countMessagesTokens(messages: Message[], modelId?: string): number {
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
  return Math.round(total * getMultiplier(modelId))
}
