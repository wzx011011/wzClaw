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
import type { CreateSessionOptions, DataSource, SessionMeta, RawMessage } from '../data-source/types'
import { StreamingBatcher, updateMessageById } from './streaming-batcher'
import type { ChatMessage, ToolCallInfo } from './streaming-batcher'

/** createChatStore 可选配置：解耦外部依赖（如 hand 选择） */
export interface CreateChatStoreOptions {
  /** 返回当前用户选择的目标 Hand ID（用于路由远程工具调用）。未提供则跳过。 */
  getTargetHandId?: () => string | undefined
}

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
  /** 会话列表 */
  sessions: SessionMeta[]
  /** 当前激活的会话 ID（用于 SessionList 高亮） */
  activeSessionId: string | null
  /** 当前会话的用量/费用信息 */
  sessionCost: { inputTokens: number; outputTokens: number; totalCostUSD: number } | null
  /** 正在运行中的会话 ID 集合（用于 SessionList 显示运行指示器） */
  runningSessionIds: Set<string>
  /** 子代理嵌套工具调用数据（按 parentToolCallId 或 toolCallId 索引） */
  subAgentData: Map<string, { toolCalls: Array<{ id: string; name: string; status: 'running' | 'completed' | 'error'; input?: Record<string, unknown>; output?: string; isError?: boolean }>; text: string }>
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
  createSession: (options?: CreateSessionOptions) => Promise<void>
  /** 清空当前会话（重置状态） */
  clearConversation: () => void
  /** 加载会话列表 */
  loadSessionList: () => Promise<void>
  /** 加载指定会话的历史消息 */
  loadSession: (sessionId: string) => Promise<void>
  /** 切换到指定会话（缓存当前会话，加载目标会话） */
  switchSession: (sessionId: string) => Promise<void>
  /** 删除指定会话 */
  deleteSession: (sessionId: string) => Promise<void>
  /** 重命名指定会话 */
  renameSession: (sessionId: string, title: string) => Promise<void>
}

/** Chat store 完整类型 */
export type ChatStore = ChatState & ChatActions

// ---- 工厂函数 ----

// 模块级会话消息缓存 — switchSession 时缓存当前会话消息
const sessionCache = new Map<string, { messages: ChatMessage[]; conversationId: string }>()

/** 清空会话缓存（DataSource 断开时调用） */
export function clearSessionCache(): void {
  sessionCache.clear()
}

/**
 * 将 RawMessage[] 转换为 ChatMessage[]
 * DataSource 返回的原始消息格式转换为 store 内部使用的 ChatMessage 格式
 */
function buildChatMessagesFromRaw(rawMessages: RawMessage[]): ChatMessage[] {
  return rawMessages.map((raw, index) => ({
    id: raw.id ?? `loaded-${index}`,
    role: raw.role,
    content: raw.content,
    timestamp: raw.timestamp ?? Date.now(),
    isStreaming: false,
    toolCalls: raw.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      status: 'completed' as const,
      input: tc.input,
    })),
  }))
}

/**
 * 创建 chat store 实例
 *
 * @param dataSource 数据源实例（WebSocket / IPC）
 * @param options    可选配置（targetHandId 获取等）
 * @returns Zustand store 实例
 */
export function createChatStore(
  dataSource: DataSource,
  options: CreateChatStoreOptions = {}
): StoreApi<ChatStore> {
  const getTargetHandId = options.getTargetHandId ?? (() => undefined)
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
      sessions: [],
      activeSessionId: null,
      sessionCost: null,
      runningSessionIds: new Set(),
      subAgentData: new Map(),

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

        // 订阅 usage_updated 事件 — 用量/费用更新
        const unsubUsageUpdated = dataSource.onStreamEvent('usage_updated', (payload) => {
          const { inputTokens, outputTokens, totalCostUSD } = payload as {
            inputTokens: number
            outputTokens: number
            totalCostUSD: number
          }
          set((state) => ({
            sessionCost: {
              inputTokens: (state.sessionCost?.inputTokens ?? 0) + inputTokens,
              outputTokens: (state.sessionCost?.outputTokens ?? 0) + outputTokens,
              totalCostUSD: (state.sessionCost?.totalCostUSD ?? 0) + totalCostUSD,
            }
          }))
        })

        // 订阅 session_running 事件 — 会话运行状态变更
        const unsubSessionRunning = dataSource.onStreamEvent('session_running', (payload) => {
          const { sessionId, status } = payload as {
            sessionId: string
            status: 'running' | 'idle'
          }
          set((state) => {
            const next = new Set(state.runningSessionIds)
            if (status === 'running') {
              next.add(sessionId)
            } else {
              next.delete(sessionId)
            }
            // 返回新的 Set 引用以触发重渲染
            return { runningSessionIds: next }
          })
        })

        // 订阅 sub_tool_use_start 事件 — 子代理工具调用开始
        const unsubSubToolUseStart = dataSource.onStreamEvent('sub_tool_use_start', (payload) => {
          const { toolCallId, name, input, parentToolCallId } = payload as {
            toolCallId: string
            name: string
            input: Record<string, unknown>
            parentToolCallId?: string
          }
          set((state) => {
            const key = parentToolCallId ?? toolCallId
            const next = new Map(state.subAgentData)
            const existing = next.get(key) ?? { toolCalls: [], text: '' }
            next.set(key, {
              ...existing,
              toolCalls: [...existing.toolCalls, { id: toolCallId, name, status: 'running' as const, input }]
            })
            return { subAgentData: next }
          })
        })

        // 订阅 sub_tool_use_end 事件 — 子代理工具调用结束
        const unsubSubToolUseEnd = dataSource.onStreamEvent('sub_tool_use_end', (payload) => {
          const { toolCallId, output, isError } = payload as {
            toolCallId: string
            output: string
            isError: boolean
          }
          set((state) => {
            const next = new Map(state.subAgentData)
            // 查找包含此 toolCallId 的条目
            for (const [key, entry] of next) {
              const tcIdx = entry.toolCalls.findIndex(tc => tc.id === toolCallId)
              if (tcIdx !== -1) {
                const updated = { ...entry }
                updated.toolCalls = [...updated.toolCalls]
                updated.toolCalls[tcIdx] = {
                  ...updated.toolCalls[tcIdx]!,
                  output,
                  isError,
                  status: isError ? 'error' as const : 'completed' as const
                }
                next.set(key, updated)
                break
              }
            }
            return { subAgentData: next }
          })
        })

        // 订阅 sub_text 事件 — 子代理文本增量
        const unsubSubText = dataSource.onStreamEvent('sub_text', (payload) => {
          const { delta, parentToolCallId } = payload as {
            delta: string
            parentToolCallId?: string
          }
          set((state) => {
            const key = parentToolCallId ?? '__default__'
            const next = new Map(state.subAgentData)
            const existing = next.get(key) ?? { toolCalls: [], text: '' }
            next.set(key, { ...existing, text: existing.text + delta })
            return { subAgentData: next }
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
          unsubUsageUpdated()
          unsubSessionRunning()
          unsubSubToolUseStart()
          unsubSubToolUseEnd()
          unsubSubText()
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
          const selectedHandId = getTargetHandId()
          const sessionConfig = await dataSource.getSessionConfig(conversationId).catch(() => null)
          const targetHandId = sessionConfig?.targetHandId ?? selectedHandId
          if (!sessionConfig?.targetHandId && selectedHandId) {
            dataSource.updateSessionConfig(conversationId, { targetHandId: selectedHandId }).catch(() => {})
          }
          await dataSource.sendMessage(conversationId, content, {
            targetHandId,
            workspaceId: sessionConfig?.workspaceId,
          })
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
      createSession: async (options?: CreateSessionOptions) => {
        batcher.reset()
        try {
          const newId = await dataSource.createSession(options)
          const selectedHandId = getTargetHandId()
          if (selectedHandId) {
            await dataSource.updateSessionConfig(newId, { targetHandId: selectedHandId }).catch(() => undefined)
          }
          const sessions = await dataSource.listSessions(options?.workspaceId ? { workspaceId: options.workspaceId } : undefined).catch(() => get().sessions)
          set({
            messages: [],
            conversationId: newId,
            sessions,
            isStreaming: false,
            isWaitingForResponse: false,
            streamingMessageId: null,
            streamJustEnded: false,
            error: null,
            sessionCost: null,
            subAgentData: new Map(),
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
            error: null,
            sessionCost: null,
            subAgentData: new Map(),
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
          error: null,
          sessionCost: null,
          subAgentData: new Map(),
        })
      },

      /**
       * 加载会话列表
       *
       * 调用 dataSource.listSessions()，更新 sessions 状态
       */
      loadSessionList: async () => {
        try {
          const sessions = await dataSource.listSessions()
          set({ sessions })
        } catch (err) {
          console.error('加载会话列表失败:', err)
        }
      },

      /**
       * 加载指定会话的历史消息
       *
       * 调用 dataSource.loadSession(sessionId)，将原始消息转换为 ChatMessage 格式
       */
      loadSession: async (sessionId: string) => {
        try {
          const rawMessages = await dataSource.loadSession(sessionId)
          const messages = buildChatMessagesFromRaw(rawMessages)
          set({
            messages,
            conversationId: sessionId,
            activeSessionId: sessionId,
            isStreaming: false,
            isWaitingForResponse: false,
            streamingMessageId: null,
            streamJustEnded: false,
            error: null,
            sessionCost: null,
            subAgentData: new Map(),
          })
        } catch (err) {
          console.error('加载会话失败:', err)
          set({ error: err instanceof Error ? err.message : String(err) })
        }
      },

      /**
       * 切换到指定会话
       *
       * 1. 缓存当前会话消息到 sessionCache
       * 2. 如果目标会话在缓存中，直接恢复
       * 3. 否则通过 dataSource.loadSession 加载
       */
      switchSession: async (sessionId: string) => {
        const { conversationId, messages } = get()

        // 如果切换到当前会话，不操作
        if (conversationId === sessionId) return

        // 缓存当前会话
        if (messages.length > 0) {
          sessionCache.set(conversationId, { messages, conversationId })
        }

        batcher.reset()

        // 先查缓存
        const cached = sessionCache.get(sessionId)
        if (cached) {
          set({
            messages: cached.messages,
            conversationId: sessionId,
            activeSessionId: sessionId,
            isStreaming: false,
            isWaitingForResponse: false,
            streamingMessageId: null,
            streamJustEnded: false,
            error: null,
            sessionCost: null,
            subAgentData: new Map(),
          })
          return
        }

        // 缓存未命中 — 通过 DataSource 加载
        await get().loadSession(sessionId)
      },

      /**
       * 删除指定会话
       *
       * 调用 dataSource.deleteSession()，从 sessions 列表中移除。
       * 如果删除的是当前会话，则 clearConversation()。
       */
      deleteSession: async (sessionId: string) => {
        try {
          await dataSource.deleteSession(sessionId)

          // 从缓存中移除
          sessionCache.delete(sessionId)

          const { conversationId } = get()
          set((state) => ({
            sessions: state.sessions.filter(s => s.id !== sessionId)
          }))

          // 如果删除的是当前会话，重置状态
          if (conversationId === sessionId) {
            get().clearConversation()
          }
        } catch (err) {
          console.error('删除会话失败:', err)
          set({ error: err instanceof Error ? err.message : String(err) })
        }
      },

      /**
       * 重命名指定会话
       *
       * 调用 dataSource.renameSession()，更新 sessions 数组中对应会话的 title
       */
      renameSession: async (sessionId: string, title: string) => {
        try {
          await dataSource.renameSession(sessionId, title)
          set((state) => ({
            sessions: state.sessions.map(s =>
              s.id === sessionId ? { ...s, title } : s
            )
          }))
        } catch (err) {
          console.error('重命名会话失败:', err)
          set({ error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
  })
}
