import { countMessagesTokens } from './token-counter'
import type { Message } from '../../shared/types'
import { DEFAULT_MODELS } from '../../shared/constants'
import type { LLMGateway } from '../llm/gateway'
import type { StreamOptions } from '../llm/types'
import type { AgentRuntimeConfig } from '../agent/runtime-config'
import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'

export interface CompactResult {
  summary: string
  /** 最终写入对话的完整摘要消息内容（含连续指令），用于替换对话 */
  summaryMessageContent: string
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
  private consecutiveCompactFailures = 0
  private accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
  private config: AgentRuntimeConfig
  private compactHistory = { count: 0, lastBefore: null as number | null, lastAfter: null as number | null }

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
   * Get max output tokens for a model from DEFAULT_MODELS presets.
   * Returns 16384 as default for unknown models.
   */
  getMaxOutputTokensForModel(modelId: string): number {
    const preset = DEFAULT_MODELS.find(m => m.id === modelId)
    return preset?.maxTokens ?? 16384
  }

  /**
   * Check if messages exceed the compaction threshold.
   * 电路保护：正在压缩中或连续失败过多时返回 false。
   *
   * 阈值公式（参考 Claude Code）：
   *   contextWindow - maxOutputTokens - safetyBuffer
   * 若 compactThreshold > 0 则使用旧式比例模式。
   * 下限 50% 防止过早触发。
   */
  shouldCompact(messages: Message[], modelId: string): boolean {
    if (this.isCompacting) return false
    if (this.consecutiveCompactFailures >= this.config.maxConsecutiveCompactFailures) return false

    const tokens = countMessagesTokens(messages, modelId)
    const contextWindow = this.getContextWindowForModel(modelId)

    // 兼容旧式比例模式
    if (this.config.compactThreshold > 0) {
      return tokens > contextWindow * this.config.compactThreshold
    }

    // 自动公式：contextWindow - maxOutputTokens - safetyBuffer
    const maxOutputTokens = this.getMaxOutputTokensForModel(modelId)
    const threshold = contextWindow - maxOutputTokens - this.config.compactSafetyBuffer
    // 下限 50%，避免短会话也触发压缩
    const effectiveThreshold = Math.max(threshold, contextWindow * 0.5)
    return tokens > effectiveThreshold
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
      // Pre-compute per-message token counts once (O(n) instead of O(n²))
      const perMsgTokens = messages.map(m => countMessagesTokens([m], model))
      let recentCount = 0
      let recentTokens = 0
      for (let i = messages.length - 1; i >= 0 && recentCount < this.config.compactKeepMax; i--) {
        const msgTokens = perMsgTokens[i]
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

      // 构建摘要 prompt（参考 Claude Code compact prompt 结构）
      const maxChars = this.config.compactSummaryMaxChars
      const summaryPrompt = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Your summary MUST include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable.
4. Errors and fixes: List all errors that you ran into, and how you fixed them.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline ALL pending or in-progress tasks that have NOT been completed yet. This is CRITICAL — list every task the user asked for that is still unfinished, with enough detail to resume work without asking the user again.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request. Include file names and code snippets where applicable.
9. Next Step: List the immediate next step to take based on the most recent work. Include direct quotes from the conversation showing what task was in progress.

Conversation to summarize:
${toSummarize.map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content.substring(0, maxChars) : JSON.stringify(m.content).substring(0, maxChars)}`).join('\n\n')}

Provide a detailed summary following the sections above. Be especially thorough for sections 7, 8, and 9 as they are critical for resuming work.`

      const summaryMessages = [
        { role: 'user' as const, content: summaryPrompt, timestamp: Date.now() }
      ]

      let summary = ''
      const streamOptions: StreamOptions = {
        model,
        messages: summaryMessages,
        systemPrompt: 'You are an expert technical summarizer. Create detailed, structured summaries that capture all the context needed to resume development work. Be thorough, especially for pending tasks and current work status.',
        abortSignal: undefined
      }

      for await (const event of gateway.stream(streamOptions)) {
        if (event.type === 'text_delta') {
          summary += event.content
        }
      }

      const summaryMessage: Message = {
        role: 'user',
        content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}\n\nContinue the conversation from where it left off. If there are pending tasks listed above, resume working on them immediately without asking the user to re-explain — pick up exactly where work stopped.`,
        timestamp: Date.now()
      }

      const compactedMessages = [summaryMessage, ...toKeep]
      const afterTokens = countMessagesTokens(compactedMessages, model)

      this.compactHistory.count++
      this.compactHistory.lastBefore = beforeTokens
      this.compactHistory.lastAfter = afterTokens
      this.consecutiveCompactFailures = 0  // 成功则重置失败计数

      return { summary, summaryMessageContent: summaryMessage.content as string, keptRecentCount: recentCount, beforeTokens, afterTokens }
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

  getCompactHistory(): { count: number; lastBefore: number | null; lastAfter: number | null } {
    return { ...this.compactHistory }
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
