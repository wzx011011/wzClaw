import { countMessagesTokens } from './token-counter'
import type { Message } from '../../shared/types'
import { DEFAULT_MODELS, MAX_TOOL_RESULT_CHARS } from '../../shared/constants'
import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'

export interface CompactResult {
  summary: string
  keptRecentCount: number
  beforeTokens: number
  afterTokens: number
}

/**
 * ContextManager handles token counting, auto-compact triggers,
 * and context compaction for the agent loop.
 *
 * Key behaviors:
 * - shouldCompact checks if messages exceed 80% of model context window
 * - Circuit breaker prevents compaction during active compaction (CTX-04)
 * - compact() summarizes older messages via LLM, keeps last 4 intact
 * - truncateToolResult caps tool output to MAX_TOOL_RESULT_CHARS
 */
export class ContextManager {
  private isCompacting = false
  private accumulatedUsage = { inputTokens: 0, outputTokens: 0 }

  /**
   * Get the context window size for a model from DEFAULT_MODELS presets.
   * Returns 128000 as default for unknown models.
   */
  getContextWindowForModel(modelId: string): number {
    const preset = DEFAULT_MODELS.find(m => m.id === modelId)
    return preset?.contextWindowSize ?? 128000
  }

  /**
   * Check if messages exceed the compaction threshold (80% of context window).
   * Returns false if already compacting (circuit breaker per CTX-04).
   */
  shouldCompact(messages: Message[], modelId: string): boolean {
    if (this.isCompacting) return false // Circuit breaker (CTX-04)
    const tokens = countMessagesTokens(messages)
    const limit = this.getContextWindowForModel(modelId)
    // 80% threshold with 15% safety margin for tokenizer discrepancy
    return tokens > limit * 0.8
  }

  /**
   * Compact conversation by summarizing older messages via LLM.
   * Keeps last 4 messages (2 exchanges) intact.
   * Sets isCompacting flag during execution (circuit breaker).
   */
  async compact(
    messages: Message[],
    gateway: LLMGateway,
    model: string,
    provider: string,
    systemPrompt?: string
  ): Promise<CompactResult> {
    const beforeTokens = countMessagesTokens(messages)
    this.isCompacting = true

    try {
      // Keep last 4 messages (2 exchanges) intact
      const recentCount = 4
      const toSummarize = messages.slice(0, -recentCount)
      const toKeep = messages.slice(-recentCount)

      if (toSummarize.length === 0) {
        // Nothing to summarize
        return {
          summary: '',
          keptRecentCount: recentCount,
          beforeTokens,
          afterTokens: beforeTokens
        }
      }

      // Build summarization prompt
      const summaryPrompt = `Summarize the following conversation, preserving:
1. What files were read or modified (include file paths)
2. What errors were encountered (include error messages)
3. What decisions were made
4. The user's original intent

Conversation to summarize:
${toSummarize.map(m => `[${m.role}]: ${m.content.substring(0, 500)}`).join('\n')}

Provide a concise summary:`

      // Call LLM for summarization
      const summaryMessages = [
        { role: 'user' as const, content: summaryPrompt, timestamp: Date.now() }
      ]

      let summary = ''
      const streamOptions: StreamOptions = {
        model,
        messages: summaryMessages,
        systemPrompt: 'You are a concise summarizer. Provide brief, structured summaries.',
        abortSignal: undefined
      }

      for await (const event of gateway.stream(streamOptions)) {
        if (event.type === 'text_delta') {
          summary += event.content
        }
      }

      // Build compacted messages: summary as system-like user message + recent messages
      const summaryMessage: Message = {
        role: 'user',
        content: `[Context Summary]\n${summary}`,
        timestamp: Date.now()
      }

      const compactedMessages = [summaryMessage, ...toKeep]
      const afterTokens = countMessagesTokens(compactedMessages)

      return {
        summary,
        keptRecentCount: recentCount,
        beforeTokens,
        afterTokens
      }
    } finally {
      this.isCompacting = false
    }
  }

  /**
   * Track token usage from LLM API responses.
   */
  trackTokenUsage(inputTokens: number, outputTokens: number): void {
    this.accumulatedUsage.inputTokens += inputTokens
    this.accumulatedUsage.outputTokens += outputTokens
  }

  /**
   * Get accumulated token usage totals.
   */
  getTotalUsage(): { inputTokens: number; outputTokens: number } {
    return { ...this.accumulatedUsage }
  }

  /**
   * Reset accumulated usage counters.
   */
  resetUsage(): void {
    this.accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
  }

  /**
   * Truncate tool result content to MAX_TOOL_RESULT_CHARS.
   * Returns content unchanged if under limit.
   */
  static truncateToolResult(content: string): string {
    if (content.length <= MAX_TOOL_RESULT_CHARS) return content
    return content.substring(0, MAX_TOOL_RESULT_CHARS) +
      `\n[truncated ${content.length} -> ${MAX_TOOL_RESULT_CHARS} chars]`
  }

  /**
   * Estimate token count for a message array.
   */
  estimateTokens(messages: Message[]): number {
    return countMessagesTokens(messages)
  }
}
