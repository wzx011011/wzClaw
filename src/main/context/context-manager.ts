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
    const tokens = countMessagesTokens(messages, modelId)
    const limit = this.getContextWindowForModel(modelId)
    // 80% threshold with 15% safety margin for tokenizer discrepancy
    return tokens > limit * 0.8
  }

  /**
   * Compact conversation by summarizing older messages via LLM.
   * Dynamic strategy: keeps enough recent messages to fill ~25% of the context window,
   * rather than a hardcoded count (min 2 messages, max 10).
   * Sets isCompacting flag during execution (circuit breaker).
   */
  async compact(
    messages: Message[],
    gateway: LLMGateway,
    model: string,
    provider: string,
    systemPrompt?: string
  ): Promise<CompactResult> {
    const beforeTokens = countMessagesTokens(messages, model)
    this.isCompacting = true

    try {
      // Dynamic recent count: keep ~25% of context window worth of recent messages
      const contextLimit = this.getContextWindowForModel(model)
      const targetRecentTokens = contextLimit * 0.25
      let recentCount = 0
      let recentTokens = 0
      for (let i = messages.length - 1; i >= 0 && recentCount < 10; i--) {
        const msgTokens = countMessagesTokens([messages[i]], model)
        if (recentTokens + msgTokens > targetRecentTokens && recentCount >= 2) break
        recentTokens += msgTokens
        recentCount++
      }
      recentCount = Math.max(2, recentCount) // At least 2 messages (1 exchange)
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
      const afterTokens = countMessagesTokens(compactedMessages, model)

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
   * Reactive compaction: triggered when the LLM returns a prompt_too_long error.
   * More aggressive than proactive compact — keeps only the last 2 messages
   * (the most recent exchange) to recover as much headroom as possible.
   *
   * Returns the compacted message array; does NOT modify internal state.
   * The caller is responsible for replacing this.messages with the result.
   */
  reactiveCompact(messages: Message[]): Message[] {
    const keptCount = Math.min(2, messages.length)
    return messages.slice(-keptCount)
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
  estimateTokens(messages: Message[], modelId?: string): number {
    return countMessagesTokens(messages, modelId)
  }
}
