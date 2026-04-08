import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { SessionMeta } from '../../shared/types'

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
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  timestamp: number
  // assistant-only fields
  toolCalls?: ToolCallInfo[]
  isStreaming?: boolean
  usage?: { inputTokens: number; outputTokens: number }
  isCompacted?: boolean
}

interface ChatState {
  messages: ChatMessage[]
  conversationId: string
  isStreaming: boolean
  error: string | null
  sessions: SessionMeta[]
  currentTokenUsage: { inputTokens: number; outputTokens: number } | null
  activeSessionId: string
  sessionsCache: Record<string, ChatMessage[]>
}

interface ChatActions {
  init: () => () => void
  sendMessage: (content: string) => Promise<void>
  stopGeneration: () => Promise<void>
  clearConversation: () => void
  loadSessionList: () => Promise<void>
  loadSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  createSession: () => void
  switchSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSessionTab: (sessionId: string) => Promise<void>
}

type ChatStore = ChatState & ChatActions

export const useChatStore = create<ChatStore>((set, get) => {
  const initialId = uuidv4()
  return {
  messages: [],
  conversationId: initialId,
  isStreaming: false,
  error: null,
  sessions: [],
  currentTokenUsage: null,
  activeSessionId: initialId,
  sessionsCache: {},

  /**
   * Subscribe to all 5 stream IPC events. Returns unsubscribe function.
   * Call once on mount (e.g. in IDELayout useEffect), cleanup on unmount.
   */
  init: () => {
    const unsubText = window.wzxclaw.onStreamText((payload) => {
      const { messages } = get()
      // Find the last assistant message that is streaming
      const lastAssistantIdx = [...messages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === 'assistant' && m.isStreaming)

      if (lastAssistantIdx) {
        // Append content to existing streaming assistant message
        set({
          messages: messages.map((m, i) =>
            i === lastAssistantIdx.i
              ? { ...m, content: m.content + payload.content }
              : m
          )
        })
      } else {
        // No streaming assistant message — create one
        const newMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: payload.content,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: []
        }
        set({ messages: [...messages, newMsg] })
      }
    })

    const unsubToolStart = window.wzxclaw.onStreamToolStart((payload) => {
      const { messages } = get()
      const lastAssistantIdx = [...messages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === 'assistant')

      if (lastAssistantIdx) {
        set({
          messages: messages.map((m, i) =>
            i === lastAssistantIdx.i
              ? {
                  ...m,
                  toolCalls: [
                    ...(m.toolCalls ?? []),
                    { id: payload.id, name: payload.name, status: 'running' }
                  ]
                }
              : m
          )
        })
      }
    })

    const unsubToolResult = window.wzxclaw.onStreamToolResult((payload) => {
      const { messages } = get()
      // Find any assistant message containing this tool call
      set({
        messages: messages.map((m) => {
          if (!m.toolCalls) return m
          const hasTool = m.toolCalls.some((tc) => tc.id === payload.id)
          if (!hasTool) return m
          return {
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id === payload.id
                ? {
                    ...tc,
                    output: payload.output,
                    isError: payload.isError,
                    status: payload.isError ? 'error' : 'completed'
                  }
                : tc
            )
          }
        })
      })
    })

    const unsubEnd = window.wzxclaw.onStreamEnd((payload) => {
      const { messages } = get()
      // Mark last streaming assistant as complete
      const lastStreamingIdx = [...messages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === 'assistant' && m.isStreaming)

      if (lastStreamingIdx) {
        set({
          isStreaming: false,
          currentTokenUsage: payload.usage,
          messages: messages.map((m, i) =>
            i === lastStreamingIdx.i
              ? { ...m, isStreaming: false, usage: payload.usage }
              : m
          )
        })
      } else {
        set({ isStreaming: false })
      }
    })

    const unsubError = window.wzxclaw.onStreamError((payload) => {
      const { messages } = get()
      // Mark last streaming assistant as not streaming anymore
      const lastStreamingIdx = [...messages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === 'assistant' && m.isStreaming)

      if (lastStreamingIdx) {
        set({
          isStreaming: false,
          error: payload.error,
          messages: messages.map((m, i) =>
            i === lastStreamingIdx.i ? { ...m, isStreaming: false } : m
          )
        })
      } else {
        set({ isStreaming: false, error: payload.error })
      }
    })

    // Session compacted events (per CTX-03, CTX-05)
    const unsubCompacted = window.wzxclaw.onSessionCompacted((payload) => {
      const compactMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: payload.auto
          ? `Auto-compacted context: ${(payload.beforeTokens / 1000).toFixed(1)}K -> ${(payload.afterTokens / 1000).toFixed(1)}K tokens (80% threshold reached)`
          : `Context compacted: ${(payload.beforeTokens / 1000).toFixed(1)}K -> ${(payload.afterTokens / 1000).toFixed(1)}K tokens`,
        timestamp: Date.now(),
        isCompacted: true
      }
      const { messages } = get()
      set({ messages: [...messages, compactMsg] })
    })

    // Load session list on startup
    get().loadSessionList()

    // Return combined unsubscribe
    return () => {
      unsubText()
      unsubToolStart()
      unsubToolResult()
      unsubEnd()
      unsubError()
      unsubCompacted()
    }
  },

  /**
   * Send a user message to the agent via IPC.
   * Creates a user ChatMessage + empty streaming assistant ChatMessage.
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
      error: null
    })

    try {
      await window.wzxclaw.sendMessage({ conversationId, content })
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
    const newId = uuidv4()
    set({
      messages: [],
      conversationId: newId,
      activeSessionId: newId,
      error: null
    })
  },

  /**
   * Load the list of sessions for the current project.
   */
  loadSessionList: async () => {
    try {
      const sessions = await window.wzxclaw.listSessions()
      set({ sessions })
    } catch (err) {
      console.error('Failed to load session list:', err)
    }
  },

  /**
   * Load a specific session's messages into the chat.
   * Converts persisted messages to ChatMessage format.
   */
  loadSession: async (sessionId: string) => {
    try {
      const rawMessages = await window.wzxclaw.loadSession({ sessionId })
      const loadedMessages: ChatMessage[] = (rawMessages as Array<Record<string, unknown>>).map((msg) => ({
        id: (msg.id as string) || uuidv4(),
        role: msg.role as 'user' | 'assistant' | 'tool_result',
        content: msg.content as string,
        timestamp: msg.timestamp as number,
        toolCalls: msg.toolCalls as ToolCallInfo[] | undefined,
        usage: msg.usage as { inputTokens: number; outputTokens: number } | undefined,
        isCompacted: msg.isCompacted as boolean | undefined
      }))
      set({
        messages: loadedMessages,
        conversationId: sessionId,
        error: null
      })
    } catch (err) {
      console.error('Failed to load session:', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  /**
   * Delete a session and reload the session list.
   * If the deleted session was active, clear the conversation.
   */
  deleteSession: async (sessionId: string) => {
    try {
      await window.wzxclaw.deleteSession({ sessionId })
      const { conversationId } = get()
      if (conversationId === sessionId) {
        get().clearConversation()
      }
      await get().loadSessionList()
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  },

  /**
   * Create a new session. Preserves current session messages in cache,
   * generates new UUID, clears messages, and switches to new session.
   */
  createSession: () => {
    const { messages, conversationId } = get()
    const newId = uuidv4()

    // Cache current session messages if any exist
    const newCache = { ...get().sessionsCache }
    if (messages.length > 0) {
      newCache[conversationId] = messages
    }

    set({
      messages: [],
      conversationId: newId,
      activeSessionId: newId,
      error: null,
      sessionsCache: newCache
    })
  },

  /**
   * Switch to a different session. Saves current messages to cache,
   * loads target session from cache or IPC, and sets activeSessionId.
   * No-op if switching to the same session.
   */
  switchSession: async (sessionId: string) => {
    const { activeSessionId, messages, conversationId } = get()

    // No-op if switching to same session
    if (activeSessionId === sessionId) return

    // Save current messages to cache
    const newCache = { ...get().sessionsCache }
    newCache[conversationId] = messages

    // Check cache first
    const cached = newCache[sessionId]
    if (cached) {
      set({
        messages: cached,
        conversationId: sessionId,
        activeSessionId: sessionId,
        sessionsCache: newCache
      })
    } else {
      // Load from IPC
      await get().loadSession(sessionId)
      set({
        activeSessionId: sessionId,
        sessionsCache: newCache
      })
    }
  },

  /**
   * Rename a session. Updates title in sessions array and calls IPC.
   */
  renameSession: async (sessionId: string, title: string) => {
    try {
      await window.wzxclaw.renameSession({ sessionId, title })
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
      await window.wzxclaw.deleteSession({ sessionId })
      const { activeSessionId, sessionsCache } = get()

      // Remove from cache
      const newCache = { ...sessionsCache }
      delete newCache[sessionId]

      if (activeSessionId === sessionId) {
        // Switch to another session or create new
        const remaining = Object.keys(newCache)
        if (remaining.length > 0) {
          const targetId = remaining[remaining.length - 1]
          const targetMessages = newCache[targetId]
          set({
            messages: targetMessages || [],
            conversationId: targetId,
            activeSessionId: targetId,
            sessionsCache: newCache
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
              sessionsCache: newCache
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
              sessionsCache: newCache
            })
          }
        }
      } else {
        set({ sessionsCache: newCache })
      }

      await get().loadSessionList()
    } catch (err) {
      console.error('Failed to delete session tab:', err)
    }
  }
}})
