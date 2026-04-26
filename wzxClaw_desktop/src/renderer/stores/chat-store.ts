import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { SessionMeta, MentionItem } from '../../shared/types'
import { useTaskStore } from './task-store'
import { useSettingsStore } from './settings-store'

// ============================================================
// Chat Store (per D-54, D-55, D-56)
// ============================================================

interface ToolCallInfo {
  id: string
  name: string
  status: 'running' | 'completed' | 'error'
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  /** Nested tool calls from a sub-agent spawned by this tool (Agent tool only) */
  children?: ToolCallInfo[]
  /** Accumulated text output from sub-agent streaming (shown as progress) */
  subText?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  thinkingContent?: string
  timestamp: number
  // assistant-only fields
  toolCalls?: ToolCallInfo[]
  isStreaming?: boolean
  usage?: { inputTokens: number; outputTokens: number }
  model?: string
  isCompacted?: boolean
  // @-mention context files/folders (user messages only)
  mentions?: MentionItem[]
}

interface ChatState {
  messages: ChatMessage[]
  conversationId: string
  isStreaming: boolean
  isWaitingForResponse: boolean
  error: string | null
  sessions: SessionMeta[]
  currentTokenUsage: { inputTokens: number; outputTokens: number } | null
  activeSessionId: string
  pendingMentions: MentionItem[]
  streamJustEnded: boolean
  streamingMessageId: string | null
  currentTodos: Array<{ content: string; status: string; activeForm: string }>
  todoCollapsed: boolean
  isLoadingSession: boolean
  loadingSessionId: string | null
}

interface ChatActions {
  init: () => () => void
  sendMessage: (displayContent: string, agentContent?: string) => Promise<void>
  stopGeneration: () => Promise<void>
  clearConversation: () => void
  loadSessionList: () => Promise<void>
  loadSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  duplicateSession: (sessionId: string) => Promise<void>
  createSession: () => void
  switchSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSessionTab: (sessionId: string) => Promise<void>
  addMention: (mention: MentionItem) => void
  removeMention: (path: string) => void
  clearMentions: () => void
}

type ChatStore = ChatState & ChatActions

// ============================================================
// LRU eviction for sessionsCache (模块级 Map，不进 Zustand 避免额外渲染)
// ============================================================

const MAX_SESSIONS_CACHE_SIZE = 10
const LAST_SESSION_RESTORE_DELAY_MS = 80
const sessionAccessOrder: string[] = []
// 会话缓存独立于 Zustand state，切换/更新缓存不触发全局重渲染
const _sessionsCache: Record<string, ChatMessage[]> = {}
let textBatchBuffer = ''
let textBatchFrame: number | null = null

function scheduleDeferredStartupTask(task: () => void, delayMs: number): () => void {
  const timeoutId = setTimeout(task, delayMs)
  return () => clearTimeout(timeoutId)
}

/**
 * Record access to a session in the module-level cache and evict LRU entries.
 * 直接操作 _sessionsCache，不产生新对象，不触发 Zustand 重渲染。
 */
function touchSession(sessionId: string): void {
  // Move session to most-recent position
  const idx = sessionAccessOrder.indexOf(sessionId)
  if (idx >= 0) {
    sessionAccessOrder.splice(idx, 1)
  }
  sessionAccessOrder.push(sessionId)

  // Evict oldest entries if over cap
  while (sessionAccessOrder.length > MAX_SESSIONS_CACHE_SIZE) {
    const oldest = sessionAccessOrder.shift()!
    delete _sessionsCache[oldest]
  }
}

/**
 * Remove a session from the LRU tracking (e.g., on delete).
 */
function removeSessionFromLru(sessionId: string): void {
  const idx = sessionAccessOrder.indexOf(sessionId)
  if (idx >= 0) {
    sessionAccessOrder.splice(idx, 1)
  }
  delete _sessionsCache[sessionId]
}

/**
 * 将持久化的原始消息数组转换为 ChatMessage[]。
 * 可被 loadSession 和 switchSession tail 共用。
 */
function buildChatMessagesFromRaw(rawMessages: Array<Record<string, unknown>>): ChatMessage[] {
  const parsed = rawMessages.map((msg) => ({
    id: (msg.id as string) || uuidv4(),
    role: msg.role as 'user' | 'assistant' | 'tool_result',
    content: msg.content as string,
    thinkingContent: msg.thinkingContent as string | undefined,
    timestamp: msg.timestamp as number,
    toolCalls: msg.toolCalls as Array<{ id: string; name: string; input?: Record<string, unknown> }> | undefined,
    toolCallId: msg.toolCallId as string | undefined,
    isError: msg.isError as boolean | undefined,
    usage: msg.usage as { inputTokens: number; outputTokens: number } | undefined,
    isCompacted: msg.isCompacted as boolean | undefined
  }))

  const toolResultMap = new Map<string, { output: string; isError: boolean }>()
  for (const msg of parsed) {
    if (msg.role === 'tool_result' && msg.toolCallId) {
      toolResultMap.set(msg.toolCallId, {
        output: (msg.content || '').slice(0, 2000),
        isError: !!msg.isError
      })
    }
  }

  const result: ChatMessage[] = []
  for (const msg of parsed) {
    if (msg.role === 'tool_result') continue
    const chatMsg: ChatMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content || '',
      thinkingContent: msg.thinkingContent,
      timestamp: msg.timestamp,
      usage: msg.usage,
      isCompacted: msg.isCompacted
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      chatMsg.toolCalls = msg.toolCalls.map((tc) => {
        const result = toolResultMap.get(tc.id)
        return {
          id: tc.id,
          name: tc.name,
          status: result ? (result.isError ? 'error' as const : 'completed' as const) : 'completed' as const,
          input: tc.input,
          output: result?.output,
          isError: result?.isError
        }
      })
    }
    result.push(chatMsg)
  }
  return result
}

function findMessageIndexById(messages: ChatMessage[], messageId: string): number {
  const lastIndex = messages.length - 1
  if (lastIndex >= 0 && messages[lastIndex]?.id === messageId) {
    return lastIndex
  }
  return messages.findIndex((message) => message.id === messageId)
}

function updateMessageById(
  messages: ChatMessage[],
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatMessage[] | null {
  const index = findMessageIndexById(messages, messageId)
  if (index < 0) return null

  const nextMessages = [...messages]
  nextMessages[index] = updater(messages[index])
  return nextMessages
}

export const useChatStore = create<ChatStore>((set, get) => {
  const initialId = uuidv4()

  const flushTextBatch = (): void => {
    if (textBatchFrame !== null) {
      cancelAnimationFrame(textBatchFrame)
      textBatchFrame = null
    }

    const batch = textBatchBuffer
    textBatchBuffer = ''
    if (!batch) return

    // 会话切换后 isStreaming/streamingMessageId 都被清零，丢弃残留文本
    if (!get().isStreaming && !get().streamingMessageId) return

    const { messages, streamingMessageId } = get()
    const nextMessages = streamingMessageId
      ? updateMessageById(messages, streamingMessageId, (message) => ({
          ...message,
          content: message.content + batch
        }))
      : null

    if (nextMessages) {
      set({
        isWaitingForResponse: false,
        messages: nextMessages
      })
      return
    }

    const newMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: batch,
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: []
    }

    set({
      isWaitingForResponse: false,
      streamingMessageId: newMsg.id,
      messages: [...messages, newMsg]
    })
  }

  const scheduleTextFlush = (): void => {
    if (textBatchFrame !== null) return
    textBatchFrame = requestAnimationFrame(() => {
      textBatchFrame = null
      flushTextBatch()
    })
  }

  const resetTextBatch = (): void => {
    if (textBatchFrame !== null) {
      cancelAnimationFrame(textBatchFrame)
      textBatchFrame = null
    }
    textBatchBuffer = ''
  }

  return {
  messages: [],
  conversationId: initialId,
  isStreaming: false,
  isWaitingForResponse: false,
  error: null,
  sessions: [],
  currentTokenUsage: null,
  activeSessionId: initialId,
  pendingMentions: [],
  streamJustEnded: false,
  streamingMessageId: null,
  currentTodos: [],
  todoCollapsed: false,
  isLoadingSession: false,
  loadingSessionId: null,

  /**
   * Subscribe to all 5 stream IPC events. Returns unsubscribe function.
   * Call once on mount (e.g. in IDELayout useEffect), cleanup on unmount.
   */
  init: () => {
    const unsubText = window.wzxclaw.onStreamText((payload) => {
      textBatchBuffer += payload.content
      scheduleTextFlush()
    })

    const unsubThinking = window.wzxclaw.onStreamThinking?.((payload) => {
      set((state) => {
        // 会话切换后丢弃残留的 thinking 事件，避免创建孤儿消息
        if (!state.isStreaming && !state.streamingMessageId) return state

        const { messages } = state
        const streamingMessageId = state.streamingMessageId
        const nextMessages = streamingMessageId
          ? updateMessageById(messages, streamingMessageId, (message) => ({
              ...message,
              thinkingContent: (message.thinkingContent ?? '') + payload.content
            }))
          : null

        if (nextMessages) {
          return {
            isWaitingForResponse: false,
            messages: nextMessages
          }
        }

        const newMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: '',
          thinkingContent: payload.content,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: []
        }
        return {
          isWaitingForResponse: false,
          streamingMessageId: newMsg.id,
          messages: [...messages, newMsg]
        }
      })
    }) ?? (() => {})

    const unsubToolStart = window.wzxclaw.onStreamToolStart((payload) => {
      flushTextBatch()
      set((state) => {
        // 会话切换后丢弃残留的 tool_start 事件，避免创建孤儿消息
        if (!state.isStreaming && !state.streamingMessageId) return state

        const { messages } = state
        const streamingMessageId = state.streamingMessageId
        const nextMessages = streamingMessageId
          ? updateMessageById(messages, streamingMessageId, (message) => ({
              ...message,
              toolCalls: [
                ...(message.toolCalls ?? []),
                { id: payload.id, name: payload.name, status: 'running', input: payload.input }
              ]
            }))
          : null

        if (nextMessages) {
          return {
            isWaitingForResponse: false,
            messages: nextMessages
          }
        }

        const newMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: [{ id: payload.id, name: payload.name, status: 'running', input: payload.input }]
        }
        return {
          isWaitingForResponse: false,
          streamingMessageId: newMsg.id,
          messages: [...messages, newMsg]
        }
      })
    }) ?? (() => {})

    const unsubToolResult = window.wzxclaw.onStreamToolResult((payload) => {
      set((state) => {
        const { messages, streamingMessageId } = state
        // Tool results always arrive before turn_end, so streamingMessageId is still set.
        // Use id-based update (O(1) fast path) instead of O(n) full-scan map.
        if (!streamingMessageId) return state
        const nextMessages = updateMessageById(messages, streamingMessageId, (m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((tc) =>
            tc.id === payload.id
              ? {
                  ...tc,
                  output: payload.output,
                  isError: payload.isError,
                  status: payload.isError ? 'error' : ('completed' as const)
                }
              : tc
          )
        }))
        return nextMessages ? { messages: nextMessages } : state
      })
    })

    const unsubEnd = window.wzxclaw.onStreamEnd((payload) => {
      flushTextBatch()
      set((state) => {
        // Drop a trailing empty assistant bubble if the stream finishes before
        // any text, thinking, or tool activity is attached to it.
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

        const modelLabel = useSettingsStore.getState().getModelLabel()
        const streamingMessageId = state.streamingMessageId
        const nextMessages = streamingMessageId
          ? updateMessageById(cleaned, streamingMessageId, (message) => ({
              ...message,
              isStreaming: false,
              usage: payload.usage,
              model: modelLabel
            }))
          : null

        if (nextMessages) {
          return {
            isStreaming: false,
            isWaitingForResponse: false,
            currentTokenUsage: payload.usage,
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
      // Refresh session list after agent completes (session is now persisted)
      get().loadSessionList()
    })

    const unsubError = window.wzxclaw.onStreamError((payload) => {
      flushTextBatch()
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
            error: payload.error,
            messages: nextMessages
          }
        }
        return {
          isStreaming: false,
          isWaitingForResponse: false,
          streamingMessageId: null,
          error: payload.error
        }
      })
    })

    // Turn-end: finalize current assistant bubble so the next turn starts a new one.
    // Global isStreaming stays true since the agent loop is still running.
    // The renderer shows a transient waiting indicator until the next turn
    // produces text, thinking, or tool activity.
    const unsubTurnEnd = window.wzxclaw.onStreamTurnEnd?.(() => {
      flushTextBatch()
      set((state) => {
        const { messages } = state
        const streamingMessageId = state.streamingMessageId
        const finalizedMessages = streamingMessageId
          ? updateMessageById(messages, streamingMessageId, (message) => ({
              ...message,
              isStreaming: false
            }))
          : null

        if (finalizedMessages) {
          return {
            isWaitingForResponse: true,
            streamingMessageId: null,
            messages: finalizedMessages
          }
        }
        return {
          isWaitingForResponse: true,
          streamingMessageId: null
        }
      })
    }) ?? (() => {})

    // Mobile user messages (from phone via relay)
    const unsubMobileMsg = window.wzxclaw.onMobileUserMessage?.((payload) => {
      set((state) => {
        const userMsg: ChatMessage = {
          id: uuidv4(),
          role: 'user',
          content: payload.content,
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
        return {
          messages: [...state.messages, userMsg, assistantMsg],
          isStreaming: true,
          isWaitingForResponse: true,
          error: null,
          streamingMessageId: assistantMsg.id
        }
      })
    }) ?? (() => {})

    // Session compacted events (per CTX-03, CTX-05)
    const unsubCompacted = window.wzxclaw.onSessionCompacted((payload) => {
      set((state) => {
        const compactMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: payload.auto
            ? `Auto-compacted context: ${(payload.beforeTokens / 1000).toFixed(1)}K -> ${(payload.afterTokens / 1000).toFixed(1)}K tokens (80% threshold reached)`
            : `Context compacted: ${(payload.beforeTokens / 1000).toFixed(1)}K -> ${(payload.afterTokens / 1000).toFixed(1)}K tokens`,
          timestamp: Date.now(),
          isCompacted: true
        }
        return { messages: [...state.messages, compactMsg] }
      })
    })

    // Session context restored — fires after session:load restores the agent loop (Phase 3.4)
    const unsubContextRestored = window.wzxclaw.onSessionContextRestored?.((payload) => {
      set((state) => {
        let note = `Session context restored (${payload.messageCount} messages)`
        if (payload.compacted) {
          note += ` — compacted ${(payload.beforeTokens / 1000).toFixed(1)}K→${(payload.afterTokens / 1000).toFixed(1)}K tokens`
        }
        const restoredMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: note,
          timestamp: Date.now(),
          isCompacted: true
        }
        return { messages: [...state.messages, restoredMsg] }
      })
    }) ?? (() => {})

    // Retry notifications from the LLM retry wrapper
    const unsubRetrying = window.wzxclaw.onStreamRetrying?.((payload) => {
      flushTextBatch()
      set((state) => {
        const { messages } = state
        const streamingMessageId = state.streamingMessageId
        const retryNote = `[Retrying ${payload.attempt}/${payload.maxAttempts} — waiting ${(payload.delayMs / 1000).toFixed(1)}s...]`
        const nextMessages = streamingMessageId
          ? updateMessageById(messages, streamingMessageId, (message) => ({
              ...message,
              content: message.content ? `${message.content}\n${retryNote}` : retryNote
            }))
          : null

        if (nextMessages) {
          return {
            messages: nextMessages
          }
        }
        const statusMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: retryNote,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: []
        }
        return {
          messages: [...messages, statusMsg],
          streamingMessageId: statusMsg.id
        }
      })
    }) ?? (() => {})

    // Sub-agent tool calls: attach children to the parent Agent ToolCall
    const unsubSubToolStart = window.wzxclaw.onSubStreamToolStart?.((payload) => {
      set((state) => {
        const { messages, streamingMessageId } = state
        if (!streamingMessageId) return state
        const nextMessages = updateMessageById(messages, streamingMessageId, (m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((tc) =>
            tc.id === payload.parentToolCallId
              ? {
                  ...tc,
                  children: [
                    ...(tc.children ?? []),
                    { id: payload.id, name: payload.name, status: 'running' as const, input: payload.input }
                  ]
                }
              : tc
          )
        }))
        return nextMessages ? { messages: nextMessages } : state
      })
    }) ?? (() => {})

    const unsubSubToolResult = window.wzxclaw.onSubStreamToolResult?.((payload) => {
      set((state) => {
        const { messages, streamingMessageId } = state
        if (!streamingMessageId) return state
        const nextMessages = updateMessageById(messages, streamingMessageId, (m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((tc) =>
            tc.id === payload.parentToolCallId
              ? {
                  ...tc,
                  children: tc.children?.map((child) =>
                    child.id === payload.id
                      ? {
                          ...child,
                          output: payload.output,
                          isError: payload.isError,
                          status: payload.isError ? 'error' as const : 'completed' as const
                        }
                      : child
                  )
                }
              : tc
          )
        }))
        return nextMessages ? { messages: nextMessages } : state
      })
    }) ?? (() => {})

    const unsubSubText = window.wzxclaw.onSubStreamText?.((payload) => {
      set((state) => {
        const { messages, streamingMessageId } = state
        if (!streamingMessageId) return state
        const nextMessages = updateMessageById(messages, streamingMessageId, (m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((tc) =>
            tc.id === payload.parentToolCallId
              ? { ...tc, subText: (tc.subText ?? '') + payload.content }
              : tc
          )
        }))
        return nextMessages ? { messages: nextMessages } : state
      })
    }) ?? (() => {})

    // Let the IDE shell paint before restoring session state.
    // This avoids chat hydration competing with the first visible frame.
    const cancelRestoreLastSession = scheduleDeferredStartupTask(() => {
      window.wzxclaw.getLastSession?.().then((result) => {
        if (result?.sessionId) {
          void get().switchSession(result.sessionId)
        }
      }).catch(() => {})
    }, LAST_SESSION_RESTORE_DELAY_MS)

    // 立即加载会话列表，确保侧边栏在首帧可见
    void get().loadSessionList()

    // Keep the push listener as a fallback (e.g. if main delays the send)
    const unsubRestore = window.wzxclaw.onSessionRestore?.((payload) => {
      if (payload?.sessionId) {
        // Only restore if we haven't already loaded a non-empty session
        if (get().messages.length === 0 && get().loadingSessionId !== payload.sessionId) {
          get().switchSession(payload.sessionId)
        }
      }
    }) ?? (() => {})

    // TodoWrite updates
    const unsubTodo = window.wzxclaw.onTodoUpdated?.((payload) => {
      set({ currentTodos: payload.todos })
    }) ?? (() => {})

    // Data changed notifications (mobile <-> desktop sync) — debounced refresh
    let taskRefreshTimer: ReturnType<typeof setTimeout> | null = null
    let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const unsubDataChanged = window.wzxclaw.onDataChanged?.(({ entity }) => {
      if (entity === 'task') {
        if (taskRefreshTimer) clearTimeout(taskRefreshTimer)
        taskRefreshTimer = setTimeout(() => useTaskStore.getState().loadTasks(), 300)
      }
      if (entity === 'session') {
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
        sessionRefreshTimer = setTimeout(() => get().loadSessionList(), 300)
      }
    }) ?? (() => {})

    // Return combined unsubscribe
    return () => {
      resetTextBatch()
      unsubText()
      unsubThinking()
      unsubToolStart()
      unsubToolResult()
      unsubEnd()
      unsubError()
      unsubTurnEnd()
      unsubMobileMsg()
      unsubCompacted()
      unsubContextRestored()
      unsubRetrying()
      cancelRestoreLastSession()
      unsubRestore()
      unsubTodo()
      unsubDataChanged()
      unsubSubToolStart()
      unsubSubToolResult()
      unsubSubText()
    }
  },

  /**
   * Send a user message to the agent via IPC.
   * Creates a user ChatMessage + empty streaming assistant ChatMessage.
   * If pendingMentions exist, formats file content into the message.
   */
  sendMessage: async (displayContent: string, agentContent?: string) => {
    const { conversationId, messages, pendingMentions } = get()

    // Format mentions into message content for LLM context
    let formattedAgentContent = agentContent ?? displayContent
    if (pendingMentions.length > 0) {
      const contextBlocks = pendingMentions.map((m) => {
        if (m.type === 'folder_mention') {
          return `[Context from ${m.path} (directory tree, ${m.size} entries)]:\n${m.content}\n---`
        }
        return `[Context from ${m.path}]:\n${m.content}\n---`
      }).join('\n')
      formattedAgentContent = `${contextBlocks}\n\n${formattedAgentContent}`
    }

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
      mentions: pendingMentions.length > 0 ? [...pendingMentions] : undefined
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
      streamingMessageId: assistantMsg.id,
      pendingMentions: []
    })

    try {
      await window.wzxclaw.sendMessage({ conversationId, content: formattedAgentContent, activeTaskId: useTaskStore.getState().activeTaskId ?? undefined })
    } catch (err) {
      set({
        isStreaming: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  /**
   * Stop an in-progress agent generation.
   */
  stopGeneration: async () => {
    flushTextBatch()
    try {
      await window.wzxclaw.stopGeneration()
    } catch (err) {
      console.error('Failed to stop generation:', err)
    }
    set({ isStreaming: false })
  },

  /**
   * Clear all messages and reset conversation ID.
   */
  clearConversation: () => {
    flushTextBatch()
    const newId = uuidv4()
    set({
      messages: [],
      conversationId: newId,
      activeSessionId: newId,
      error: null,
      streamingMessageId: null,
      currentTodos: []
    })
  },

  /**
   * Load the list of sessions for the current project.
   */
  loadSessionList: async () => {
    try {
      const { activeTaskId } = useTaskStore.getState()
      const sessions = await window.wzxclaw.listSessions(activeTaskId ? { activeTaskId } : undefined)
      set({ sessions })
    } catch (err) {
      console.error('Failed to load session list:', err)
    }
  },

  /**
   * Load a specific session's messages into the chat.
   * Converts persisted messages to ChatMessage format, updates module-level cache.
   * @param updateMessages - 若为 false，只更新模块级缓存 + 触发 agentLoop 上下文恢复，
   *                         不更新 Zustand messages（用于 cache-hit 后的后台上下文恢复）
   */
  loadSession: async (sessionId: string, options?: { updateMessages?: boolean }) => {
    const updateMessages = options?.updateMessages !== false
    flushTextBatch()
    try {
      const activeTaskId = useTaskStore.getState().activeTaskId
      const rawMessages = await window.wzxclaw.loadSession({
        sessionId,
        ...(activeTaskId ? { activeTaskId } : {})
      })

      const loadedMessages = buildChatMessagesFromRaw(rawMessages as Array<Record<string, unknown>>)

      if (updateMessages) {
        // 更新模块级缓存（不触发 Zustand 重渲染）
        _sessionsCache[sessionId] = loadedMessages
        touchSession(sessionId)
        set({
          messages: loadedMessages,
          conversationId: sessionId,
          error: null,
          streamingMessageId: null
        })
      }
      // updateMessages:false 时只触发了 IPC，agentLoop.restoreContext 在 session:load handler 中异步执行
    } catch (err) {
      console.error('Failed to load session:', err)
      if (updateMessages) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  /**
   * Delete a session and reload the session list.
   * If the deleted session was active, clear the conversation.
   */
  deleteSession: async (sessionId: string) => {
    try {
      const activeTaskId = useTaskStore.getState().activeTaskId
      await window.wzxclaw.deleteSession({ sessionId, ...(activeTaskId ? { activeTaskId } : {}) })
      const { conversationId } = get()
      if (conversationId === sessionId) {
        get().clearConversation()
      }
      await get().loadSessionList()
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  },

  duplicateSession: async (sessionId: string) => {
    try {
      const activeTaskId = useTaskStore.getState().activeTaskId
      const result = await window.wzxclaw.duplicateSession({ sessionId, ...(activeTaskId ? { activeTaskId } : {}) })
      await get().loadSessionList()
      // 切换到复制后的新会话
      await get().switchSession(result.newSessionId)
    } catch (err) {
      console.error('Failed to duplicate session:', err)
    }
  },

  /**
   * Create a new session. Preserves current session messages in cache,
   * generates new UUID, clears messages, and switches to new session.
   */
  createSession: () => {
    flushTextBatch()
    const { messages, conversationId } = get()
    const newId = uuidv4()

    // 缓存当前会话消息（模块级 Map，不触发 Zustand 重渲染）
    if (messages.length > 0) {
      _sessionsCache[conversationId] = messages
      touchSession(conversationId)
    }

    set({
      messages: [],
      conversationId: newId,
      activeSessionId: newId,
      error: null,
      streamingMessageId: null,
      currentTodos: []
    })
  },

  /**
   * Switch to a different session. Saves current messages to module-level cache,
   * loads target from cache or via tail-first IPC, sets activeSessionId.
   * No-op if switching to the same session.
   */
  switchSession: async (sessionId: string) => {
    // 丢弃未刷新的文本缓冲，而非刷入（切换后这些文本属于旧会话）
    resetTextBatch()
    const { activeSessionId, messages, conversationId, loadingSessionId, isStreaming } = get()

    // No-op if switching to same session, or the same load is already in flight.
    if (activeSessionId === sessionId || loadingSessionId === sessionId) return

    // 中断正在进行的生成，避免切换后残留流式事件污染新会话
    if (isStreaming) {
      try { await window.wzxclaw.stopGeneration() } catch {}
    }

    // 保存当前消息到模块级缓存（无 spread，无 Zustand 触发）
    if (messages.length > 0) {
      _sessionsCache[conversationId] = messages
      touchSession(conversationId)
    }

    // 完整重置所有流式和会话级状态，防止旧会话状态泄漏
    const cleanState = {
      isStreaming: false,
      isWaitingForResponse: false,
      streamJustEnded: false,
      streamingMessageId: null as string | null,
      pendingMentions: [] as MentionItem[],
      currentTodos: [] as Array<{ content: string; status: string; activeForm: string }>,
      currentTokenUsage: null as { inputTokens: number; outputTokens: number } | null,
      error: null as string | null
    }

    // 命中缓存 — 立即渲染，无 IPC 开销
    const cached = _sessionsCache[sessionId]
    if (cached) {
      touchSession(sessionId)
      set({
        messages: cached,
        conversationId: sessionId,
        activeSessionId: sessionId,
        isLoadingSession: false,
        loadingSessionId: null,
        ...cleanState
      })
    } else {
      // 未命中缓存 — 两阶段加载：先 tail 快速显示，再完整加载恢复 agent 上下文
      set({
        isLoadingSession: true,
        loadingSessionId: sessionId,
        messages: [],
        conversationId: sessionId,
        activeSessionId: sessionId,
        ...cleanState
      })

      // 阶段1：tail 加载（最近 100 条）— 快速首帧
      try {
        const activeTaskId = useTaskStore.getState().activeTaskId
        const tailResult = await window.wzxclaw.loadSessionTail?.({
          sessionId,
          tailCount: 100,
          ...(activeTaskId ? { activeTaskId } : {})
        })
        // 若切换期间用户再次切换，丢弃过期结果
        if (tailResult && get().loadingSessionId === sessionId) {
          const tailMessages = buildChatMessagesFromRaw(tailResult.messages as Array<Record<string, unknown>>)
          set({
            messages: tailMessages,
            isLoadingSession: false,
            loadingSessionId: null,
          })
          // 阶段2：完整加载（后台）— 触发 agentLoop.restoreContext（updateMessages:false 不覆盖已显示的 tail）
          get().loadSession(sessionId, { updateMessages: false }).catch(() => {})
        }
      } catch {
        // tail 失败则降级为完整加载
        await get().loadSession(sessionId)
        if (get().loadingSessionId === sessionId) {
          set({ isLoadingSession: false, loadingSessionId: null })
        }
      }
    }

    // Persist last session so it can be restored on next app launch
    window.wzxclaw.saveLastSession?.({ sessionId }).catch(() => {})
  },

  /**
   * Rename a session. Updates title in sessions array and calls IPC.
   */
  renameSession: async (sessionId: string, title: string) => {
    try {
      const activeTaskId = useTaskStore.getState().activeTaskId
      await window.wzxclaw.renameSession({ sessionId, title, ...(activeTaskId ? { activeTaskId } : {}) })
      const { sessions } = get()
      set({
        sessions: sessions.map(s =>
          s.id === sessionId ? { ...s, title } : s
        )
      })
    } catch (err) {
      console.error('Failed to rename session:', err)
    }
  },

  /**
   * Delete a session tab. Calls deleteSession IPC, removes from cache,
   * and switches to another session if the deleted one was active.
   */
  deleteSessionTab: async (sessionId: string) => {
    try {
      const activeTaskId = useTaskStore.getState().activeTaskId
      await window.wzxclaw.deleteSession({ sessionId, ...(activeTaskId ? { activeTaskId } : {}) })
      const { activeSessionId } = get()

      // 从模块级缓存和 LRU 中移除
      removeSessionFromLru(sessionId)

      if (activeSessionId === sessionId) {
        // Switch to another session or create new
        const remaining = Object.keys(_sessionsCache)
        if (remaining.length > 0) {
          const targetId = remaining[remaining.length - 1]
          const targetMessages = _sessionsCache[targetId]
          set({
            messages: targetMessages || [],
            conversationId: targetId,
            activeSessionId: targetId,
            streamingMessageId: null
          })
        } else {
          // No cached sessions — reload list and pick first, or create new
          const sessions = await window.wzxclaw.listSessions()
          if (sessions.length > 0) {
            const firstSession = sessions[0]
            set({
              sessions,
              activeSessionId: firstSession.id,
              conversationId: firstSession.id,
              messages: [],
              streamingMessageId: null
            })
            // Load the session data
            await get().loadSession(firstSession.id)
            set({ activeSessionId: firstSession.id })
          } else {
            const newId = uuidv4()
            set({
              sessions,
              messages: [],
              conversationId: newId,
              activeSessionId: newId,
              streamingMessageId: null
            })
          }
        }
      }

      await get().loadSessionList()
    } catch (err) {
      console.error('Failed to delete session tab:', err)
    }
  },

  /**
   * Add a file or folder mention to the pending list for the next message.
   */
  addMention: (mention: MentionItem) => {
    const { pendingMentions } = get()
    // Avoid duplicates
    if (pendingMentions.some((m) => m.path === mention.path)) return
    set({ pendingMentions: [...pendingMentions, mention] })
  },

  /**
   * Remove a pending mention by file path.
   */
  removeMention: (path: string) => {
    const { pendingMentions } = get()
    set({ pendingMentions: pendingMentions.filter((m) => m.path !== path) })
  },

  /**
   * Clear all pending mentions (called after message sent).
   */
  clearMentions: () => {
    set({ pendingMentions: [] })
  }
}})

// ============================================================
// 测试专用访问器（仅供单元测试使用，生产代码请勿引用）
// ============================================================
export const __TEST_ONLY_sessionsCache = {
  get(sessionId: string): ChatMessage[] | undefined { return _sessionsCache[sessionId] },
  set(sessionId: string, messages: ChatMessage[]): void { _sessionsCache[sessionId] = messages },
  reset(): void {
    for (const key of Object.keys(_sessionsCache)) {
      delete _sessionsCache[key]
    }
  }
}
