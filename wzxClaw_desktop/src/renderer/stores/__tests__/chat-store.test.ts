import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../chat-store'
import type { ChatMessage } from '../chat-store'

// Mock uuid to return a predictable value
vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-new'
}))

// Store original global state
const mockWzxclaw = {
  sendMessage: vi.fn(),
  stopGeneration: vi.fn(),
  onStreamText: vi.fn().mockReturnValue(vi.fn()),
  onStreamToolStart: vi.fn().mockReturnValue(vi.fn()),
  onStreamToolResult: vi.fn().mockReturnValue(vi.fn()),
  onStreamEnd: vi.fn().mockReturnValue(vi.fn()),
  onStreamError: vi.fn().mockReturnValue(vi.fn()),
  onSessionCompacted: vi.fn().mockReturnValue(vi.fn()),
  listSessions: vi.fn().mockResolvedValue([]),
  loadSession: vi.fn().mockResolvedValue([]),
  deleteSession: vi.fn().mockResolvedValue({ success: true }),
  renameSession: vi.fn().mockResolvedValue({ success: true }),
  compactContext: vi.fn().mockResolvedValue(null)
}

beforeEach(() => {
  // Set up global window.wzxclaw mock
  ;(globalThis as Record<string, unknown>).window = { wzxclaw: { ...mockWzxclaw } }

  // Reset store to initial state
  useChatStore.setState({
    messages: [],
    conversationId: 'test-initial-id',
    isStreaming: false,
    error: null,
    sessions: [],
    currentTokenUsage: null,
    activeSessionId: 'test-initial-id',
    sessionsCache: {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function getWzxclaw(): Record<string, ReturnType<typeof vi.fn>> {
  return (globalThis as unknown as { window: { wzxclaw: Record<string, ReturnType<typeof vi.fn>> } }).window.wzxclaw
}

describe('ChatStore multi-session', () => {
  describe('createSession', () => {
    it('should generate new UUID, set as activeSessionId, add to sessions array', () => {
      const { createSession } = useChatStore.getState()
      createSession()

      const state = useChatStore.getState()
      // UUID mock returns 'mock-uuid-new' for the new session
      expect(state.activeSessionId).toBe('mock-uuid-new')
      expect(state.conversationId).toBe('mock-uuid-new')
      expect(state.messages).toEqual([])
    })

    it('should preserve current session messages before switching', () => {
      // Set up existing messages in current session
      const existingMessages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi there', timestamp: Date.now() }
      ]
      useChatStore.setState({
        messages: existingMessages,
        conversationId: 'old-session-id',
        activeSessionId: 'old-session-id'
      })

      const { createSession } = useChatStore.getState()
      createSession()

      const state = useChatStore.getState()
      // New session should have empty messages
      expect(state.messages).toEqual([])
      // But old session messages should be cached
      expect(state.sessionsCache['old-session-id']).toEqual(existingMessages)
    })
  })

  describe('switchSession', () => {
    it('should save current messages, load target session, set activeSessionId', async () => {
      // Set up current session with messages
      const currentMessages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Current session msg', timestamp: Date.now() }
      ]
      useChatStore.setState({
        messages: currentMessages,
        conversationId: 'session-a',
        activeSessionId: 'session-a'
      })

      // Mock loadSession to return messages for target session
      const targetMessages = [
        { id: 'target-msg-1', role: 'user', content: 'Target session', timestamp: 1000 }
      ]
      getWzxclaw().loadSession.mockResolvedValueOnce(targetMessages)

      const { switchSession } = useChatStore.getState()
      await switchSession('session-b')

      const state = useChatStore.getState()
      expect(state.activeSessionId).toBe('session-b')
      expect(state.conversationId).toBe('session-b')
      // Current messages should be cached
      expect(state.sessionsCache['session-a']).toEqual(currentMessages)
    })

    it('should be a no-op when switching to the same session', async () => {
      useChatStore.setState({
        conversationId: 'session-a',
        activeSessionId: 'session-a',
        messages: [{ id: 'msg-1', role: 'user', content: 'Test', timestamp: Date.now() }]
      })

      const messagesBefore = useChatStore.getState().messages
      const { switchSession } = useChatStore.getState()
      await switchSession('session-a')

      const state = useChatStore.getState()
      expect(state.activeSessionId).toBe('session-a')
      expect(state.messages).toBe(messagesBefore) // same reference, no change
    })

    it('should load from cache if available instead of calling IPC', async () => {
      const cachedMessages: ChatMessage[] = [
        { id: 'cached-1', role: 'user', content: 'Cached', timestamp: 1000 }
      ]

      useChatStore.setState({
        conversationId: 'session-a',
        activeSessionId: 'session-a',
        messages: [],
        sessionsCache: {
          'session-b': cachedMessages
        }
      })

      const { switchSession } = useChatStore.getState()
      await switchSession('session-b')

      const state = useChatStore.getState()
      expect(state.messages).toEqual(cachedMessages)
      expect(getWzxclaw().loadSession).not.toHaveBeenCalled()
    })
  })

  describe('deleteSessionTab', () => {
    it('should remove session from sessions array', async () => {
      getWzxclaw().deleteSession.mockResolvedValueOnce({ success: true })
      getWzxclaw().listSessions.mockResolvedValueOnce([
        { id: 'session-a', title: 'Session A', createdAt: 1000, updatedAt: 1000, messageCount: 2 }
      ])

      useChatStore.setState({
        conversationId: 'session-a',
        activeSessionId: 'session-a',
        sessions: [
          { id: 'session-a', title: 'Session A', createdAt: 1000, updatedAt: 1000, messageCount: 2 },
          { id: 'session-b', title: 'Session B', createdAt: 2000, updatedAt: 2000, messageCount: 1 }
        ]
      })

      const { deleteSessionTab } = useChatStore.getState()
      await deleteSessionTab('session-b')

      expect(getWzxclaw().deleteSession).toHaveBeenCalledWith({ sessionId: 'session-b' })
    })

    it('should switch to last remaining session if active session is deleted', async () => {
      getWzxclaw().deleteSession.mockResolvedValueOnce({ success: true })
      getWzxclaw().listSessions.mockResolvedValueOnce([
        { id: 'session-c', title: 'Session C', createdAt: 3000, updatedAt: 3000, messageCount: 1 }
      ])

      useChatStore.setState({
        conversationId: 'session-a',
        activeSessionId: 'session-a',
        sessions: [
          { id: 'session-a', title: 'Session A', createdAt: 1000, updatedAt: 1000, messageCount: 2 },
          { id: 'session-c', title: 'Session C', createdAt: 3000, updatedAt: 3000, messageCount: 1 }
        ],
        sessionsCache: {
          'session-c': [{ id: 'msg-c', role: 'user', content: 'C msg', timestamp: 3000 }]
        }
      })

      const { deleteSessionTab } = useChatStore.getState()
      await deleteSessionTab('session-a')

      const state = useChatStore.getState()
      expect(state.activeSessionId).toBe('session-c')
    })
  })

  describe('renameSession', () => {
    it('should update session title in sessions array and call IPC', async () => {
      getWzxclaw().renameSession.mockResolvedValueOnce({ success: true })

      useChatStore.setState({
        sessions: [
          { id: 'session-a', title: 'Old Title', createdAt: 1000, updatedAt: 1000, messageCount: 2 }
        ]
      })

      const { renameSession } = useChatStore.getState()
      await renameSession('session-a', 'New Title')

      expect(getWzxclaw().renameSession).toHaveBeenCalledWith({
        sessionId: 'session-a',
        title: 'New Title'
      })

      const state = useChatStore.getState()
      const session = state.sessions.find(s => s.id === 'session-a')
      expect(session?.title).toBe('New Title')
    })
  })
})
