// ============================================================
// Chat Store — 工厂模式，通过 DataSource 与后端通信
//
// 从桌面端 chat-store.ts 提取并重构：
// - 工厂函数 createChatStore(dataSource) 返回 Zustand store
// - 所有后端交互通过 DataSource 接口，不直接调用 window.wzxclaw
// - 流式文本通过 StreamingBatcher 做 rAF 合并
// - 代码注释用中文
// ============================================================

import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { DataSource } from '../data-source/types'
import { StreamingBatcher, updateMessageById } from './streaming-batcher'
import type { ChatMessage, ToolCallInfo } from './streaming-batcher'

// ---- Store 类型定义 ----

/** Chat store 状态 */
interface ChatState {
  /** 消息列表 */
  messages: ChatMessage[]
  /** 当前会话 ID */
  conversationId: string
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 是否正在等待首次响应 */
  isWaitingForResponse: boolean
  /** 错误信息 */
  error: string | null
  /** 流式消息 ID（当前正在接收的 assistant 消息） */
  streamingMessageId: string | null
  /** 流式刚结束标记（用于触发滚动到底部） */
  streamJustEnded: boolean
  /** 输入框内容（供 ChatPanel 使用） */
  _inputValue?: string
}

/** Chat store 操作 */
interface ChatActions {
  /** 初始化：订阅 DataSource 的 stream 事件，返回取消订阅函数 */
  init: () => () => void
  /** 发送消息 */
  sendMessage: (content: string) => Promise<void>
  /** 停止生成 */
  stopGeneration: () => Promise<void>
  /** 创建新会话 */
  createSession: () => Promise<void>
  /** 清空当前会话（重置状态） */
  clearConversation: () => void
}

/** Chat store 完整类型 */
export type ChatStore = ChatState & ChatActions

// ---- 工厂函数 ----

/**
 * 创建 chat store 实例
 *
 * @param dataSource 数据源实例（WebSocket / IPC）
 * @returns Zustand store 实例
 */
export function createChatStore(dataSource: DataSource): StoreApi<ChatStore> {
  return create<ChatStore>((set, get) => {
    // 初始会话 ID
    const initialId = uuidv4()

    // 创建 StreamingBatcher — 通过 rAF 合并高频文本更新
    const batcher = new StreamingBatcher({
      get: () => {
        const s = get()
        return {
          isStreaming: s.isStreaming,
          streamingMessageId: s.streamingMessageId,
          messages: s.messages
        }
      },
      set: (partial) => set(partial as Partial<ChatStore>)
    })

    return {
      // ---- 初始状态 ----
      messages: [],
      conversationId: initialId,
      isStreaming: false,
      isWaitingForResponse: false,
      error: null,
      streamingMessageId: null,
      streamJustEnded: false,

      // ---- 操作 ----

      /**
       * 初始化：订阅所有 stream 事件
       * 在组件挂载时调用一次，卸载时调用返回的函数取消订阅
       */
      init: () => {
        // 订阅 text 事件 — 流式文本增量
        const unsubText = dataSource.onStreamEvent('text', (payload) => {
          const { delta } = payload as { delta: string }
          batcher.appendText(delta)
        })

        // 订阅 thinking 事件 — 思考内容
        const unsubThinking = dataSource.onStreamEvent('thinking', (payload) => {
          const { content } = payload as { content: string }
          batcher.appendThinking(content)
        })

        // 订阅 tool_call 事件 — 工具调用开始
        const unsubToolCall = dataSource.onStreamEvent('tool_call', (payload) => {
          const { toolCallId, name, input } = payload as {
            toolCallId: string
            name: string
            input: Record<string, unknown>
          }
          batcher.flushNow()
          set((state) => {
            if (!state.isStreaming && !state.streamingMessageId) return state

            const { messages } = state
            const streamingMessageId = state.streamingMessageId

            // 尝试在已有 streaming 消息中追加 toolCall
            const nextMessages = streamingMessageId
              ? updateMessageById(messages, streamingMessageId, (message) => ({
                  ...message,
                  toolCalls: [
                    ...(message.toolCalls ?? []),
                    { id: toolCallId, name, status: 'running' as const, input }
                  ]
                }))
              : null

            if (nextMessages) {
              return { isWaitingForResponse: false, messages: nextMessages }
            }

            // 没有 streaming 消息 — 创建新的 assistant 消息
            const newMsg: ChatMessage = {
              id: uuidv4(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              toolCalls: [{ id: toolCallId, name, status: 'running', input }]
            }
            return {
              isWaitingForResponse: false,
              streamingMessageId: newMsg.id,
              messages: [...messages, newMsg]
            }
          })
        })

        // 订阅 tool_result 事件 — 工具执行结果
        const unsubToolResult = dataSource.onStreamEvent('tool_result', (payload) => {
          const { toolCallId, output, isError } = payload as {
            toolCallId: string
            name: string
            output: string
            isError: boolean
          }
          set((state) => {
            const { messages, streamingMessageId } = state
            if (!streamingMessageId) return state

            const nextMessages = updateMessageById(messages, streamingMessageId, (m) => ({
              ...m,
              toolCalls: m.toolCalls?.map((tc: ToolCallInfo) =>
                tc.id === toolCallId
                  ? {
                      ...tc,
                      output,
                      isError,
                      status: isError ? 'error' as const : 'completed' as const
                    }
                  : tc
              )
            }))
            return nextMessages ? { messages: nextMessages } : state
          })
        })

        // 订阅 error 事件
        const unsubError = dataSource.onStreamEvent('error', (payload) => {
          const { error } = payload as { error: string }
          batcher.flushNow()
          set((state) => {
            const streamingMessageId = state.streamingMessageId
            const nextMessages = streamingMessageId
              ? updateMessageById(state.messages, streamingMessageId, (message) => ({
                  ...message,
                  isStreaming: false
                }))
              : null

            if (nextMessages) {
              return {
                isStreaming: false,
                isWaitingForResponse: false,
                streamingMessageId: null,
                error,
                messages: nextMessages
              }
            }
            return {
              isStreaming: false,
              isWaitingForResponse: false,
              streamingMessageId: null,
              error
            }
          })
        })

        // 订阅 done 事件 — 流式完成
        const unsubDone = dataSource.onStreamEvent('done', (payload) => {
          const { usage } = payload as {
            usage: { inputTokens: number; outputTokens: number }
            turnCount: number
          }
          batcher.flushNow()
          set((state) => {
            // 移除空的尾部 assistant 气泡（stream 结束但无内容）
            let cleaned = state.messages
            const last = cleaned[cleaned.length - 1]
            if (
              last &&
              last.role === 'assistant' &&
              last.isStreaming &&
              !last.content &&
              !last.thinkingContent &&
              (!last.toolCalls || last.toolCalls.length === 0)
            ) {
              cleaned = cleaned.slice(0, -1)
            }

            const streamingMessageId = state.streamingMessageId
            const nextMessages = streamingMessageId
              ? updateMessageById(cleaned, streamingMessageId, (message) => ({
                  ...message,
                  isStreaming: false,
                  usage
                }))
              : null

            if (nextMessages) {
              return {
                isStreaming: false,
                isWaitingForResponse: false,
                streamJustEnded: true,
                streamingMessageId: null,
                messages: nextMessages
              }
            }
            return {
              isStreaming: false,
              isWaitingForResponse: false,
              streamJustEnded: true,
              streamingMessageId: null,
              messages: cleaned
            }
          })
        })

        // 订阅 compacted 事件 — 上下文压缩通知
        const unsubCompacted = dataSource.onStreamEvent('compacted', (payload) => {
          const { beforeTokens, afterTokens } = payload as {
            beforeTokens: number
            afterTokens: number
          }
          set((state) => {
            const compactMsg: ChatMessage = {
              id: uuidv4(),
              role: 'assistant',
              content: `上下文已压缩: ${(beforeTokens / 1000).toFixed(1)}k -> ${(afterTokens / 1000).toFixed(1)}k tokens`,
              timestamp: Date.now(),
              isCompacted: true
            }
            return { messages: [...state.messages, compactMsg] }
          })
        })

        // 返回取消订阅函数
        return () => {
          batcher.reset()
          unsubText()
          unsubThinking()
          unsubToolCall()
          unsubToolResult()
          unsubError()
          unsubDone()
          unsubCompacted()
        }
      },

      /**
       * 发送用户消息
       *
       * 创建 user 消息 + 空 assistant 占位消息，
       * 通过 DataSource 发送到后端
       */
      sendMessage: async (content: string) => {
        const { conversationId, messages } = get()

        const userMsg: ChatMessage = {
          id: uuidv4(),
          role: 'user',
          content,
          timestamp: Date.now()
        }

        const assistantMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: []
        }

        set({
          messages: [...messages, userMsg, assistantMsg],
          isStreaming: true,
          isWaitingForResponse: true,
          error: null,
          streamJustEnded: false,
          streamingMessageId: assistantMsg.id
        })

        try {
          await dataSource.sendMessage(conversationId, content)
        } catch (err) {
          set({
            isStreaming: false,
            streamingMessageId: null,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },

      /**
       * 停止当前生成
       */
      stopGeneration: async () => {
        batcher.flushNow()
        const { conversationId } = get()
        try {
          await dataSource.stopGeneration(conversationId)
        } catch (err) {
          console.error('停止生成失败:', err)
        }
        set({ isStreaming: false })
      },

      /**
       * 创建新会话
       *
       * 通过 DataSource 创建新会话，重置所有状态
       */
      createSession: async () => {
        batcher.reset()
        try {
          const newId = await dataSource.createSession()
          set({
            messages: [],
            conversationId: newId,
            isStreaming: false,
            isWaitingForResponse: false,
            streamingMessageId: null,
            streamJustEnded: false,
            error: null
          })
        } catch (err) {
          // 如果 DataSource 不支持 createSession（如 IPC 模式），使用客户端生成 ID
          const fallbackId = uuidv4()
          set({
            messages: [],
            conversationId: fallbackId,
            isStreaming: false,
            isWaitingForResponse: false,
            streamingMessageId: null,
            streamJustEnded: false,
            error: null
          })
        }
      },

      /**
       * 清空当前会话（不通过后端，仅重置前端状态）
       */
      clearConversation: () => {
        batcher.reset()
        const newId = uuidv4()
        set({
          messages: [],
          conversationId: newId,
          isStreaming: false,
          isWaitingForResponse: false,
          streamingMessageId: null,
          streamJustEnded: false,
          error: null
        })
      }
    }
  })
}
