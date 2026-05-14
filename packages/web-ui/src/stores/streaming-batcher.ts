// ============================================================
// StreamingBatcher — rAF 文本批处理，减少逐 token 重渲染
// 从桌面端提取，无 Electron 依赖
// ============================================================

/** ChatMessage 类型 — web-ui 内部使用的消息结构 */
export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool_result'
  readonly content: string
  readonly thinkingContent?: string
  readonly timestamp: number
  readonly isStreaming?: boolean
  readonly toolCalls?: ToolCallInfo[]
  readonly usage?: { inputTokens: number; outputTokens: number }
  readonly model?: string
  readonly isCompacted?: boolean
  readonly images?: Array<{ data: string; mimeType: string; name?: string }>
}

/** 工具调用信息 */
export interface ToolCallInfo {
  readonly id: string
  readonly name: string
  readonly status: 'running' | 'completed' | 'error'
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly isError?: boolean
  readonly progress?: string
}

/** Store 访问器接口 — StreamingBatcher 通过此接口与 Zustand store 交互 */
interface BatchStoreAccessors {
  get: () => { isStreaming: boolean; streamingMessageId: string | null; messages: ChatMessage[] }
  set: (partial: Record<string, unknown>) => void
}

/**
 * 将流式文本/思考事件通过 requestAnimationFrame 合并，
 * 避免每个 token 触发一次 Zustand set -> React 重渲染。
 */
export class StreamingBatcher {
  private textBuffer = ''
  private textFrame: number | null = null
  private thinkingBuffer = ''
  private thinkingFrame: number | null = null
  private store: BatchStoreAccessors

  constructor(store: BatchStoreAccessors) {
    this.store = store
  }

  /** 追加文本 token 到缓冲区，调度 rAF flush */
  appendText(content: string): void {
    this.textBuffer += content
    this.scheduleTextFlush()
  }

  /** 追加 thinking token 到缓冲区，调度 rAF flush */
  appendThinking(content: string): void {
    this.thinkingBuffer += content
    this.scheduleThinkingFlush()
  }

  /** 重置所有缓冲区和待执行的 rAF */
  reset(): void {
    this.textBuffer = ''
    this.thinkingBuffer = ''
    if (this.textFrame !== null) {
      cancelAnimationFrame(this.textFrame)
      this.textFrame = null
    }
    if (this.thinkingFrame !== null) {
      cancelAnimationFrame(this.thinkingFrame)
      this.thinkingFrame = null
    }
  }

  /** 同步刷新所有缓冲区（用于 tool_start/end/error 等需要立即排空的场景） */
  flushNow(): void {
    this.flushTextBatch()
    this.flushThinkingBatch()
  }

  /** 刷新文本缓冲区 */
  private flushTextBatch(): void {
    if (this.textFrame !== null) {
      cancelAnimationFrame(this.textFrame)
      this.textFrame = null
    }

    const batch = this.textBuffer
    this.textBuffer = ''
    if (!batch) return

    const { isStreaming, streamingMessageId, messages } = this.store.get()
    if (!isStreaming && !streamingMessageId) return

    // 尝试更新已有的 streaming 消息
    const nextMessages = streamingMessageId
      ? updateMessageById(messages, streamingMessageId, (message) => ({
          ...message,
          content: message.content + batch
        }))
      : null

    if (nextMessages) {
      this.store.set({
        isWaitingForResponse: false,
        messages: nextMessages
      })
      return
    }

    // 没有找到 streaming 消息 — 创建新的 assistant 消息
    const newMsg: ChatMessage = {
      id: globalThis.crypto.randomUUID(),
      role: 'assistant',
      content: batch,
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: []
    }

    this.store.set({
      isWaitingForResponse: false,
      streamingMessageId: newMsg.id,
      messages: [...messages, newMsg]
    })
  }

  private scheduleTextFlush(): void {
    if (this.textFrame !== null) return
    this.textFrame = requestAnimationFrame(() => {
      this.textFrame = null
      this.flushTextBatch()
    })
  }

  /** 刷新思考内容缓冲区 */
  private flushThinkingBatch(): void {
    if (this.thinkingFrame !== null) {
      cancelAnimationFrame(this.thinkingFrame)
      this.thinkingFrame = null
    }

    const batch = this.thinkingBuffer
    this.thinkingBuffer = ''
    if (!batch) return

    const { isStreaming, streamingMessageId, messages } = this.store.get()
    if (!isStreaming && !streamingMessageId) return

    const nextMessages = streamingMessageId
      ? updateMessageById(messages, streamingMessageId, (message) => ({
          ...message,
          thinkingContent: (message.thinkingContent ?? '') + batch
        }))
      : null

    if (nextMessages) {
      this.store.set({
        isWaitingForResponse: false,
        messages: nextMessages
      })
      return
    }

    const newMsg: ChatMessage = {
      id: globalThis.crypto.randomUUID(),
      role: 'assistant',
      content: '',
      thinkingContent: batch,
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: []
    }

    this.store.set({
      isWaitingForResponse: false,
      streamingMessageId: newMsg.id,
      messages: [...messages, newMsg]
    })
  }

  private scheduleThinkingFlush(): void {
    if (this.thinkingFrame !== null) return
    this.thinkingFrame = requestAnimationFrame(() => {
      this.thinkingFrame = null
      this.flushThinkingBatch()
    })
  }
}

/**
 * 通过 ID 更新消息 — 快速路径：streaming 场景下目标消息几乎总是最后一个元素
 */
export function updateMessageById(
  messages: ChatMessage[],
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatMessage[] | null {
  const lastIndex = messages.length - 1
  // 快速路径：流式场景下目标消息几乎总是最后一个元素
  if (lastIndex >= 0 && messages[lastIndex]!.id === messageId) {
    const updated = updater(messages[lastIndex]!)
    if (updated === messages[lastIndex]) return null // 无变化
    const next = messages.slice(0, -1)
    next.push(updated)
    return next
  }
  // 慢速路径：全量扫描（极少触发）
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return null

  const nextMessages = [...messages]
  nextMessages[index] = updater(messages[index]!)
  return nextMessages
}
