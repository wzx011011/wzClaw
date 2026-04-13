// ============================================================
// ConversationManager — 统一管理对话消息的增删改查
// 所有消息操作通过此类进行，保持一致性
// 支持消息优先级分类，指导上下文压缩策略
// ============================================================

import type { Message, ContentBlock, ToolCall } from '../../shared/types'

/**
 * 消息优先级，用于上下文压缩时的淘汰顺序。
 * - critical: 不可压缩（用户原始消息、最近 2 条 assistant）
 * - normal: 一般 assistant / tool_result 消息
 * - compressible: 旧的 tool_result，优先被压缩
 */
export type MessagePriority = 'critical' | 'normal' | 'compressible'

/**
 * ConversationManager 统一管理内部消息队列。
 *
 * 职责：
 * - 追加各类消息（user / assistant / tool_result / system_reminder）
 * - 压缩替换（replaceWithSummary）
 * - 外部加载（loadFromExternal）
 * - 消息优先级分类（用于压缩策略）
 * - 只读访问
 */
export class ConversationManager {
  private messages: Message[] = []

  // ---- 追加消息 ----

  /** 追加用户消息 */
  appendUserMessage(content: string): Message {
    const msg: Message = { role: 'user', content, timestamp: Date.now() }
    this.messages.push(msg)
    return msg
  }

  /** 追加 assistant 消息 */
  appendAssistantMessage(
    content: string,
    toolCalls: ToolCall[],
    contentBlocks?: ContentBlock[],
  ): Message {
    const msg: Message = {
      role: 'assistant',
      content,
      toolCalls,
      contentBlocks,
      timestamp: Date.now(),
    }
    this.messages.push(msg)
    return msg
  }

  /** 追加工具结果消息 */
  appendToolResult(
    toolCallId: string,
    content: string,
    isError: boolean = false,
  ): Message {
    const msg: Message = {
      role: 'tool_result',
      toolCallId,
      content,
      isError,
      timestamp: Date.now(),
    }
    this.messages.push(msg)
    return msg
  }

  /** 追加 system-reminder（作为 user 消息注入） */
  appendSystemReminder(content: string): Message {
    const msg: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    this.messages.push(msg)
    return msg
  }

  // ---- 批量操作 ----

  /**
   * 上下文压缩后替换消息队列。
   */
  replaceWithSummary(summary: string, recentMessages: Message[]): void {
    const summaryMsg: Message = {
      role: 'user',
      content: `[Context Summary]\n${summary}`,
      timestamp: Date.now(),
    }
    this.messages = [summaryMsg, ...recentMessages]
  }

  /**
   * 反应式压缩：只保留最近的消息。
   */
  keepRecent(count: number): void {
    this.messages = this.messages.slice(-count)
  }

  /**
   * 从外部加载消息（恢复会话、替换消息等）。
   */
  loadFromExternal(messages: Message[]): void {
    this.messages = messages
  }

  // ---- 查询 ----

  /** 获取消息的只读快照（浅拷贝） */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /** 获取消息数量 */
  get length(): number {
    return this.messages.length
  }

  /** 获取最后一条消息 */
  getLast(): Message | undefined {
    return this.messages[this.messages.length - 1]
  }

  /** 获取可变的内部引用 */
  getMutableMessages(): Message[] {
    return this.messages
  }

  /**
   * 按 index 更新 tool_result 内容（全局预算裁剪用）。
   */
  updateToolResultContent(index: number, newContent: string): void {
    const msg = this.messages[index]
    if (msg && msg.role === 'tool_result') {
      msg.content = newContent
    }
  }

  /**
   * 获取所有 tool_result 消息及其索引。
   */
  getToolResultEntries(): Array<{ content: string; index: number }> {
    return this.messages
      .map((msg, idx) => ({ msg, idx }))
      .filter(({ msg }) => msg.role === 'tool_result')
      .map(({ msg, idx }) => ({ content: msg.content, index: idx }))
  }

  // ---- 优先级分类 ----

  /**
   * 为每条消息分配压缩优先级。
   * 最近的 2 条 assistant 消息和用户原始消息为 critical，
   * 旧的 tool_result 为 compressible，其余为 normal。
   */
  getMessagePriorities(): Array<{ index: number; priority: MessagePriority }> {
    const result: Array<{ index: number; priority: MessagePriority }> = []
    const len = this.messages.length

    // 找出最近的 2 条 assistant 消息的索引
    const assistantIndices: number[] = []
    for (let i = len - 1; i >= 0 && assistantIndices.length < 2; i--) {
      if (this.messages[i].role === 'assistant') {
        assistantIndices.push(i)
      }
    }
    const criticalSet = new Set(assistantIndices)

    for (let i = 0; i < len; i++) {
      const msg = this.messages[i]

      if (criticalSet.has(i)) {
        result.push({ index: i, priority: 'critical' })
      } else if (msg.role === 'tool_result') {
        // tool_result 如果在 critical assistant 之后（同一轮），属于 normal
        const isAfterCritical = assistantIndices.some(ci => i > ci)
        result.push({ index: i, priority: isAfterCritical ? 'normal' : 'compressible' })
      } else if (msg.role === 'user') {
        // 用户消息一律 critical
        result.push({ index: i, priority: 'critical' })
      } else {
        result.push({ index: i, priority: 'normal' })
      }
    }

    return result
  }

  /**
   * 按优先级获取可压缩的消息索引（用于上下文压缩）。
   * 返回的索引按淘汰优先级排序：compressible > normal（按时间从旧到新）。
   * critical 消息永不返回。
   */
  getCompressibleIndices(): number[] {
    const priorities = this.getMessagePriorities()

    // compressible 优先淘汰（从旧到新），然后 normal（从旧到新）
    const compressible = priorities
      .filter(p => p.priority === 'compressible')
      .sort((a, b) => a.index - b.index)
      .map(p => p.index)

    const normal = priorities
      .filter(p => p.priority === 'normal')
      .sort((a, b) => a.index - b.index)
      .map(p => p.index)

    return [...compressible, ...normal]
  }

  // ---- 生命周期 ----

  /** 清空所有消息 */
  clear(): void {
    this.messages = []
  }
}
