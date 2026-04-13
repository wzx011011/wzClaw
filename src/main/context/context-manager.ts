import { countMessagesTokens } from './token-counter'
import type { Message } from '../../shared/types'
import { DEFAULT_MODELS } from '../../shared/constants'
import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { AgentRuntimeConfig } from '../agent/runtime-config'
import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'

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
 * 所有阈值从 runtimeConfig 读取，不再硬编码魔法数字。
 */
export class ContextManager {
  private isCompacting = false
  private accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
  private config: AgentRuntimeConfig

  constructor(config?: Partial<AgentRuntimeConfig>) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config }
  }

  /** 获取当前运行时配置 */
  getConfig(): AgentRuntimeConfig {
    return this.config
  }

  /**
   * Get the context window size for a model from DEFAULT_MODELS presets.
   * Returns 128000 as default for unknown models.
   */
  getContextWindowForModel(modelId: string): number {
    const preset = DEFAULT_MODELS.find(m => m.id === modelId)
    return preset?.contextWindowSize ?? 128000
  }

  /**
   * Check if messages exceed the compaction threshold.
   * Returns false if already compacting (circuit breaker).
   */
  shouldCompact(messages: Message[], modelId: string): boolean {
    if (this.isCompacting) return false
    const tokens = countMessagesTokens(messages, modelId)
    const limit = this.getContextWindowForModel(modelId)
    return tokens > limit * this.config.compactThreshold
  }

  /**
   * Compact conversation by summarizing older messages via LLM.
   * Dynamic strategy: keeps enough recent messages to fill compactKeepRatio of the context window,
   * bounded by compactKeepMin and compactKeepMax.
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
      const contextLimit = this.getContextWindowForModel(model)
      const targetRecentTokens = contextLimit * this.config.compactKeepRatio
      let recentCount = 0
      let recentTokens = 0
      for (let i = messages.length - 1; i >= 0 && recentCount < this.config.compactKeepMax; i--) {
        const msgTokens = countMessagesTokens([messages[i]], model)
        if (recentTokens + msgTokens > targetRecentTokens && recentCount >= this.config.compactKeepMin) break
        recentTokens += msgTokens
        recentCount++
      }
      recentCount = Math.max(this.config.compactKeepMin, recentCount)
      const toSummarize = messages.slice(0, -recentCount)
      const toKeep = messages.slice(-recentCount)

      if (toSummarize.length === 0) {
        return { summary: '', keptRecentCount: recentCount, beforeTokens, afterTokens: beforeTokens }
      }

      // 构建摘要 prompt
      const maxChars = this.config.compactSummaryMaxChars
      const summaryPrompt = `Summarize the following conversation, preserving:
1. What files were read or modified (include file paths)
2. What errors were encountered (include error messages)
3. What decisions were made
4. The user's original intent

Conversation to summarize:
${toSummarize.map(m => `[${m.role}]: ${m.content.substring(0, maxChars)}`).join('\n')}

Provide a concise summary:`

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

      const summaryMessage: Message = {
        role: 'user',
        content: `[Context Summary]\n${summary}`,
        timestamp: Date.now()
      }

      const compactedMessages = [summaryMessage, ...toKeep]
      const afterTokens = countMessagesTokens(compactedMessages, model)

      return { summary, keptRecentCount: recentCount, beforeTokens, afterTokens }
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
  }

  /**
   * Reactive compaction: keeps only the last reactiveCompactKeepCount messages.
   */
  reactiveCompact(messages: Message[]): Message[] {
    const keptCount = Math.min(this.config.reactiveCompactKeepCount, messages.length)
    return messages.slice(-keptCount)
  }

  /**
   * Truncate tool result content to maxToolResultChars.
   */
  static truncateToolResult(content: string, maxChars?: number): string {
    const limit = maxChars ?? DEFAULT_RUNTIME_CONFIG.maxToolResultChars
    if (content.length <= limit) return content
    return content.substring(0, limit) + `\n[truncated ${content.length} -> ${limit} chars]`
  }

  estimateTokens(messages: Message[], modelId?: string): number {
    return countMessagesTokens(messages, modelId)
  }
}
