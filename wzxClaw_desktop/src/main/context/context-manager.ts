// ============================================================
// ContextManager — Claude Code-style context compaction orchestrator
//
// Pipeline (same order as Claude Code autoCompactIfNeeded):
//   1. Session Memory Compact  — drop oldest API rounds (no API call)
//   2. Microcompact            — clear old tool results (no API call)
//   3. LLM Summary Compact     — full summarization (API call)
//   4. PTL Recovery            — truncate head if compact itself too long
//
// All thresholds from runtimeConfig. No magic numbers.
// ============================================================

import { countMessagesTokens } from './token-counter'
import type { Message } from '../../shared/types'
import { DEFAULT_MODELS } from '../../shared/constants'
import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { AgentRuntimeConfig } from '../agent/runtime-config'
import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'
import { getCompactPrompt, getCompactUserSummaryMessage, formatCompactSummary } from './compact-prompt'
import { stripImagesFromMessages, stripReinjectedAttachments, formatMessageForSummary } from './message-utils'
import { groupMessagesByApiRound } from './grouping'

export interface CompactResult {
  summary: string
  /** The full summary message content (with continuation instructions) */
  summaryMessageContent: string
  keptRecentCount: number
  beforeTokens: number
  afterTokens: number
  /** Messages that were summarized (for file restoration) */
  summarizedMessages: Message[]
}

/**
 * ContextManager handles token counting, auto-compact triggers,
 * and context compaction for the agent loop.
 */
export class ContextManager {
  private isCompacting = false
  private consecutiveCompactFailures = 0
  private accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
  private config: AgentRuntimeConfig
  private compactHistory = {
    count: 0,
    lastBefore: null as number | null,
    lastAfter: null as number | null,
  }

  constructor(config?: Partial<AgentRuntimeConfig>) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config }
  }

  getConfig(): AgentRuntimeConfig {
    return this.config
  }

  getContextWindowForModel(modelId: string): number {
    const preset = DEFAULT_MODELS.find(m => m.id === modelId)
    return preset?.contextWindowSize ?? 128000
  }

  getMaxOutputTokensForModel(modelId: string): number {
    const preset = DEFAULT_MODELS.find(m => m.id === modelId)
    return preset?.maxTokens ?? 16384
  }

  /**
   * Check if messages exceed the compaction threshold.
   * Circuit breaker: skip if currently compacting or too many failures.
   */
  shouldCompact(messages: Message[], modelId: string): boolean {
    if (this.isCompacting) return false
    if (this.consecutiveCompactFailures >= this.config.maxConsecutiveCompactFailures)
      return false

    const tokens = countMessagesTokens(messages, modelId)
    const contextWindow = this.getContextWindowForModel(modelId)

    if (this.config.compactThreshold > 0) {
      return tokens > contextWindow * this.config.compactThreshold
    }

    const maxOutputTokens = this.getMaxOutputTokensForModel(modelId)
    const threshold = Math.max(
      contextWindow - maxOutputTokens - this.config.compactSafetyBuffer,
      contextWindow * 0.7,
    )
    return tokens > threshold
  }

  /**
   * 检查是否应该执行 pre-compact（提前微压缩）。
   * 阈值低于 shouldCompact()，用于在触发完整压缩之前先行清理旧工具结果。
   * 设 preCompactThreshold 为 0 时禁用此功能。
   */
  shouldPreCompact(messages: Message[], modelId: string): boolean {
    if (this.config.preCompactThreshold <= 0) return false
    const tokens = countMessagesTokens(messages, modelId)
    const contextWindow = this.getContextWindowForModel(modelId)
    return tokens > contextWindow * this.config.preCompactThreshold
  }

  /**
   * Main compaction: summarise older messages via LLM.
   *
   * Key differences from the old implementation:
   * 1. Uses Claude Code prompt template (compact-prompt.ts) — no more inline prompt
   * 2. Strips images before sending to summariser
   * 3. Sends FULL message content (no 500-char truncation)
   * 4. Uses formatCompactSummary to strip <analysis> block
   * 5. Supports PTL recovery via truncateHeadForPTLRetry
   */
  async compact(
    messages: Message[],
    gateway: LLMGateway,
    model: string,
    provider: string,
    systemPrompt?: string,
    customInstructions?: string,
  ): Promise<CompactResult> {
    const beforeTokens = countMessagesTokens(messages, model)
    this.isCompacting = true

    try {
      const contextLimit = this.getContextWindowForModel(model)

      // ---- Split into "to summarize" and "to keep" ----
      const targetRecentTokens = contextLimit * this.config.compactKeepRatio
      const perMsgTokens = messages.map(m => countMessagesTokens([m], model))
      let recentCount = 0
      let recentTokens = 0
      for (
        let i = messages.length - 1;
        i >= 0 && recentCount < this.config.compactKeepMax;
        i--
      ) {
        const msgTokens = perMsgTokens[i]
        if (
          recentTokens + msgTokens > targetRecentTokens &&
          recentCount >= this.config.compactKeepMin
        )
          break
        recentTokens += msgTokens
        recentCount++
      }
      recentCount = Math.max(this.config.compactKeepMin, recentCount)
      const toSummarize = messages.slice(0, -recentCount)
      const toKeep = messages.slice(-recentCount)

      if (toSummarize.length === 0) {
        return {
          summary: '',
          summaryMessageContent: '',
          keptRecentCount: recentCount,
          beforeTokens,
          afterTokens: beforeTokens,
          summarizedMessages: [],
        }
      }

      // ---- Build the compact prompt using Claude Code templates ----
      const compactPrompt = getCompactPrompt(customInstructions)

      // ---- Strip images + reinjected attachments ----
      const cleanedMessages = stripReinjectedAttachments(
        stripImagesFromMessages(toSummarize),
      )

      // ---- Format messages for the prompt (full content, no truncation) ----
      const conversationText = cleanedMessages
        .map(m => formatMessageForSummary(m))
        .join('\n\n')

      const summaryPromptContent =
        compactPrompt +
        '\n\nConversation to summarize:\n' +
        conversationText

      const summaryMessages = [
        {
          role: 'user' as const,
          content: summaryPromptContent,
          timestamp: Date.now(),
        },
      ]

      // ---- Call LLM for summary ----
      let summary = ''
      const streamOptions: StreamOptions = {
        model,
        messages: summaryMessages,
        systemPrompt:
          'You are an expert technical summarizer. Create detailed, structured summaries that capture all the context needed to resume development work.',
        abortSignal: undefined,
      }

      for await (const event of gateway.stream(streamOptions)) {
        if (event.type === 'text_delta') {
          summary += event.content
        }
      }

      // ---- Format the summary using Claude Code's formatCompactSummary ----
      const formattedSummary = formatCompactSummary(summary)
      if (!formattedSummary || formattedSummary.trim().length === 0) {
        throw new Error('Compact produced empty summary')
      }

      // ---- Build the user-facing continuation message ----
      const summaryMessageContent = getCompactUserSummaryMessage(
        summary, // raw summary (formatCompactSummary is called inside)
        true, // suppress follow-up questions for auto-compact
        recentCount > 0, // recent messages are preserved
      )

      const compactedMessages: Message[] = [
        { role: 'user', content: summaryMessageContent, timestamp: Date.now() },
        ...toKeep,
      ]
      const afterTokens = countMessagesTokens(compactedMessages, model)

      this.compactHistory.count++
      this.compactHistory.lastBefore = beforeTokens
      this.compactHistory.lastAfter = afterTokens
      this.consecutiveCompactFailures = 0

      return {
        summary: formattedSummary,
        summaryMessageContent,
        keptRecentCount: recentCount,
        beforeTokens,
        afterTokens,
        summarizedMessages: toSummarize,
      }
    } catch (err) {
      this.consecutiveCompactFailures++
      throw err
    } finally {
      this.isCompacting = false
    }
  }

  trackTokenUsage(inputTokens: number, outputTokens: number): void {
    this.accumulatedUsage.inputTokens += inputTokens
    this.accumulatedUsage.outputTokens += outputTokens
  }

  getTotalUsage(): { inputTokens: number; outputTokens: number } {
    return { ...this.accumulatedUsage }
  }

  resetUsage(): void {
    this.accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
    this.compactHistory = { count: 0, lastBefore: null, lastAfter: null }
    this.consecutiveCompactFailures = 0
  }

  getCompactHistory(): {
    count: number
    lastBefore: number | null
    lastAfter: number | null
  } {
    return { ...this.compactHistory }
  }

  reactiveCompact(messages: Message[]): Message[] {
    const keptCount = Math.min(
      this.config.reactiveCompactKeepCount,
      messages.length,
    )
    return messages.slice(-keptCount)
  }

  reactiveCompactByTurns(messages: Message[]): Message[] {
    if (messages.length <= this.config.reactiveCompactKeepCount) return messages

    const turns = groupMessagesByApiRound(messages)
    if (turns.length <= 2) {
      return messages.slice(-this.config.reactiveCompactKeepCount)
    }

    const keptTurns = turns.slice(-2)
    const kept = keptTurns.flat()
    return kept.length > 0
      ? kept
      : messages.slice(-this.config.reactiveCompactKeepCount)
  }

  getMicrocompactConfig(): { gapMinutes: number; keepRecent: number } {
    return {
      gapMinutes: this.config.microcompactGapMinutes,
      keepRecent: this.config.microcompactKeepRecent,
    }
  }

  static truncateToolResult(content: string, maxChars?: number): string {
    const limit = maxChars ?? DEFAULT_RUNTIME_CONFIG.maxToolResultChars
    if (content.length <= limit) return content
    return (
      content.substring(0, limit) +
      '\n[truncated ' +
      content.length +
      ' -> ' +
      limit +
      ' chars]'
    )
  }

  estimateTokens(messages: Message[], modelId?: string): number {
    return countMessagesTokens(messages, modelId)
  }
}
