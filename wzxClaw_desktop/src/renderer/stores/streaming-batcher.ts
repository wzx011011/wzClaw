// ============================================================
// StreamingBatcher — rAF 文本批处理，减少逐 token 重渲染
// 从 chat-store.ts 模块级变量提取为显式类
// ============================================================
import type { ChatMessage } from '@shared/types'
import { updateMessageById } from './chat-store-utils'

interface BatchStoreAccessors {
  get: () => { isStreaming: boolean; streamingMessageId: string | null; messages: ChatMessage[] }
  set: (partial: Record<string, unknown>) => void
}

/**
 * 将流式文本/思考事件通过 requestAnimationFrame 合并，
 * 避免每个 token 触发一次 Zustand set → React 重渲染。
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

    const crypto = globalThis.crypto
    const newMsg: ChatMessage = {
      id: crypto.randomUUID(),
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

    const crypto = globalThis.crypto
    const newMsg: ChatMessage = {
      id: crypto.randomUUID(),
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
