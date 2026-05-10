/**
 * chat-store-streaming.test.ts
 *
 * End-to-end unit tests for the streaming event pipeline:
 *   IPC callback → store state mutation → message shape
 *
 * Covers P0-P3 fixes:
 *   - streamingMessageId tracking (O(1) message lookup)
 *   - rAF text batching (synchronous in tests via immediate rAF mock)
 *   - onStreamToolResult using streamingMessageId (P2 fix)
 *   - turn_end → isWaitingForResponse (no phantom placeholder)
 *
 * All IPC callbacks are captured when init() is called, then invoked
 * directly so tests stay fully synchronous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../chat-store'

// Deterministic UUIDs — inner counter avoids vi.mock hoisting issues
vi.mock('uuid', () => {
  let _seq = 0
  return { v4: () => `uuid-${++_seq}` }
})

// ──────────────────────────────────────────────────────────
// Queue-based requestAnimationFrame mock
// Callbacks are stored and executed on demand via flushRaf()
// This allows testing rAF-batching without synchronous execution
// order issues (synchronous rAF overrides textBatchFrame=null).
// ──────────────────────────────────────────────────────────
const rafQueue = new Map<number, FrameRequestCallback>()
let rafIdSeq = 0

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
  const id = ++rafIdSeq
  rafQueue.set(id, cb)
  return id
})
vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
  rafQueue.delete(id)
})

/** Flush all pending rAF callbacks (simulates browser frame render) */
function flushRaf(): void {
  const pending = [...rafQueue.values()]
  rafQueue.clear()
  pending.forEach(cb => cb(0))
}

// ──────────────────────────────────────────────────────────
// IPC callback capture — populated by mockWzxclaw handlers
// ──────────────────────────────────────────────────────────
type TextPayload = { content: string; sessionId: string }
type ToolStartPayload = { id: string; name: string; sessionId: string }
type ToolResultPayload = { id: string; output: string; isError: boolean; toolName?: string; sessionId: string }
type EndPayload = { usage: { inputTokens: number; outputTokens: number }; sessionId: string }
type ErrorPayload = { error: string; sessionId: string }
type RetryPayload = { attempt: number; maxAttempts: number; delayMs: number; sessionId: string }

let cbText: ((p: TextPayload) => void) | null = null
let cbThinking: ((p: TextPayload) => void) | null = null
let cbToolStart: ((p: ToolStartPayload) => void) | null = null
let cbToolResult: ((p: ToolResultPayload) => void) | null = null
let cbEnd: ((p: EndPayload) => void) | null = null
let cbError: ((p: ErrorPayload) => void) | null = null
let cbTurnEnd: ((p: { sessionId: string }) => void) | null = null
let cbRetrying: ((p: RetryPayload) => void) | null = null

const mockWzxclaw = {
  sendMessage: vi.fn().mockResolvedValue({}),
  stopGeneration: vi.fn(),
  onStreamText:          vi.fn((cb: typeof cbText)       => { cbText       = cb; return vi.fn() }),
  onStreamThinking:      vi.fn((cb: typeof cbThinking)   => { cbThinking   = cb; return vi.fn() }),
  onStreamToolStart:     vi.fn((cb: typeof cbToolStart)  => { cbToolStart  = cb; return vi.fn() }),
  onStreamToolResult:    vi.fn((cb: typeof cbToolResult) => { cbToolResult = cb; return vi.fn() }),
  onStreamEnd:           vi.fn((cb: typeof cbEnd)        => { cbEnd        = cb; return vi.fn() }),
  onStreamError:         vi.fn((cb: typeof cbError)      => { cbError      = cb; return vi.fn() }),
  onStreamTurnEnd:       vi.fn((cb: typeof cbTurnEnd)    => { cbTurnEnd    = cb; return vi.fn() }),
  onStreamRetrying:      vi.fn((cb: typeof cbRetrying)   => { cbRetrying   = cb; return vi.fn() }),
  // Optional handlers — not used in streaming tests, just need to exist
  onMobileUserMessage:      vi.fn().mockReturnValue(vi.fn()),
  onSessionCompacted:       vi.fn().mockReturnValue(vi.fn()),
  onSessionContextRestored: vi.fn().mockReturnValue(vi.fn()),
  onAskUserQuestion:        vi.fn().mockReturnValue(vi.fn()),
  onPlanModeEntered:        vi.fn().mockReturnValue(vi.fn()),
  onPlanModeExited:         vi.fn().mockReturnValue(vi.fn()),
  onSessionRestore:         vi.fn().mockReturnValue(vi.fn()),
  onTodoUpdated:            vi.fn().mockReturnValue(vi.fn()),
  onDataChanged:            vi.fn().mockReturnValue(vi.fn()),
  listSessions:  vi.fn().mockResolvedValue({ sessions: [], runningSessionIds: [] }),
  loadSession:   vi.fn().mockResolvedValue([]),
  deleteSession: vi.fn().mockResolvedValue({ success: true }),
  renameSession: vi.fn().mockResolvedValue({ success: true }),
}

const CLEAN_STATE = {
  messages: [],
  conversationId: 'test-session',
  isStreaming: true,
  isWaitingForResponse: false,
  error: null,
  sessions: [],
  currentTokenUsage: null,
  activeSessionId: 'test-session',
  sessionsCache: {},
  pendingMentions: [],
  streamJustEnded: false,
  streamingMessageId: null,
  currentTodos: [],
  todoCollapsed: false,
}

let cleanup: (() => void) | null = null

beforeEach(() => {
  // Reset module-level batch state (not covered by CLEAN_STATE)
  rafQueue.clear()
  ;(globalThis as Record<string, unknown>).window = { wzxclaw: { ...mockWzxclaw } }
  useChatStore.setState(CLEAN_STATE)
  cleanup = useChatStore.getState().init()
})

afterEach(() => {
  cleanup?.()
  rafQueue.clear()
  vi.clearAllMocks()   // clears call history but preserves mockReturnValue / mockImplementation
})

// ──────────────────────────────────────────────────────────
// Helper: put store into a "currently streaming" state with
// an existing assistant message, avoiding sendMessage IPC.
// ──────────────────────────────────────────────────────────
function setStreamingMessage(overrides: Partial<{
  id: string
  content: string
  thinkingContent: string
  toolCalls: Array<{ id: string; name: string; status: 'running' | 'completed' | 'error' }>
}> = {}) {
  const id = overrides.id ?? 'stream-msg'
  useChatStore.setState({
    isStreaming: true,
    isWaitingForResponse: false,
    streamingMessageId: id,
    messages: [{
      id,
      role: 'assistant',
      content: overrides.content ?? '',
      thinkingContent: overrides.thinkingContent,
      timestamp: 1000,
      isStreaming: true,
      toolCalls: overrides.toolCalls ?? [],
    }],
  })
  return id
}

// ══════════════════════════════════════════════════════════
// 1. onStreamText — rAF-batched text delta
// ══════════════════════════════════════════════════════════

describe('onStreamText', () => {
  it('creates a new assistant message when no streamingMessageId', () => {
    cbText!({ content: 'Hello', sessionId: 'test-session' })
    flushRaf()

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].role).toBe('assistant')
    expect(state.messages[0].content).toBe('Hello')
    expect(state.messages[0].isStreaming).toBe(true)
    expect(state.streamingMessageId).toBe(state.messages[0].id)
    expect(state.isWaitingForResponse).toBe(false)
  })

  it('appends text to the existing streaming message', () => {
    setStreamingMessage({ content: 'Hi ' })

    cbText!({ content: 'there!', sessionId: 'test-session' })
    flushRaf()

    const { messages } = useChatStore.getState()
    expect(messages[0].content).toBe('Hi there!')
    // streamingMessageId unchanged
    expect(useChatStore.getState().streamingMessageId).toBe('stream-msg')
  })

  it('batches multiple deltas into a single flush (1 rAF = all pending text)', () => {
    setStreamingMessage({ content: '' })

    // All 3 events queue into the same rAF batch
    cbText!({ content: 'A', sessionId: 'test-session' })
    cbText!({ content: 'B', sessionId: 'test-session' })
    cbText!({ content: 'C', sessionId: 'test-session' })
    // Only one rAF is pending (subsequent calls hit the guard)
    expect(rafQueue.size).toBe(1)

    flushRaf()
    expect(useChatStore.getState().messages[0].content).toBe('ABC')
  })
})

// ══════════════════════════════════════════════════════════
// 2. onStreamThinking — thinking delta
// ══════════════════════════════════════════════════════════

describe('onStreamThinking', () => {
  it('creates a new assistant message when no streamingMessageId', () => {
    cbThinking!({ content: 'Let me think...', sessionId: 'test-session' })
    flushRaf()  // thinking is now rAF-batched

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].thinkingContent).toBe('Let me think...')
    expect(state.messages[0].content).toBe('')
    expect(state.streamingMessageId).toBe(state.messages[0].id)
    expect(state.isWaitingForResponse).toBe(false)
  })

  it('appends thinking to the existing streaming message', () => {
    setStreamingMessage({ thinkingContent: 'Step 1. ' })

    cbThinking!({ content: 'Step 2.', sessionId: 'test-session' })
    flushRaf()  // thinking is now rAF-batched

    const { messages } = useChatStore.getState()
    expect(messages[0].thinkingContent).toBe('Step 1. Step 2.')
  })
})

// ══════════════════════════════════════════════════════════
// 3. onStreamToolStart — tool call registration
// ══════════════════════════════════════════════════════════

describe('onStreamToolStart', () => {
  it('creates a new assistant message with the tool call when no streamingMessageId', () => {
    cbToolStart!({ id: 'tc-1', name: 'FileRead', sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].toolCalls).toHaveLength(1)
    expect(state.messages[0].toolCalls![0]).toMatchObject({
      id: 'tc-1',
      name: 'FileRead',
      status: 'running',
    })
    expect(state.streamingMessageId).toBe(state.messages[0].id)
  })

  it('appends tool call to the existing streaming message', () => {
    setStreamingMessage({ toolCalls: [{ id: 'tc-0', name: 'Search', status: 'running' }] })

    cbToolStart!({ id: 'tc-1', name: 'FileWrite', sessionId: 'test-session' })

    const { messages } = useChatStore.getState()
    expect(messages[0].toolCalls).toHaveLength(2)
    expect(messages[0].toolCalls![1]).toMatchObject({ id: 'tc-1', name: 'FileWrite', status: 'running' })
  })

  it('flushes pending text before adding tool call (ordering integrity)', () => {
    setStreamingMessage({ content: '' })

    cbText!({ content: 'prefix text ', sessionId: 'test-session' })  // queued in rAF batch
    cbToolStart!({ id: 'tc-1', name: 'RunCommand', sessionId: 'test-session' })  // calls flushTextBatch() directly

    // No flushRaf() needed: toolStart flushed the buffer synchronously
    const { messages } = useChatStore.getState()
    expect(messages[0].content).toBe('prefix text ')
    expect(messages[0].toolCalls).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════
// 4. onStreamToolResult — P2 fix: uses streamingMessageId (O(1))
// ══════════════════════════════════════════════════════════

describe('onStreamToolResult (P2 fix)', () => {
  it('marks tool call completed using streamingMessageId (O(1) path)', () => {
    setStreamingMessage({
      toolCalls: [{ id: 'tc-1', name: 'FileRead', status: 'running' }],
    })

    cbToolResult!({ id: 'tc-1', output: 'file content', isError: false, sessionId: 'test-session' })

    const { messages } = useChatStore.getState()
    const tc = messages[0].toolCalls!.find(t => t.id === 'tc-1')!
    expect(tc.status).toBe('completed')
    expect(tc.output).toBe('file content')
    expect(tc.isError).toBe(false)
  })

  it('marks tool call as error when isError=true', () => {
    setStreamingMessage({
      toolCalls: [{ id: 'tc-err', name: 'FileWrite', status: 'running' }],
    })

    cbToolResult!({ id: 'tc-err', output: 'permission denied', isError: true, sessionId: 'test-session' })

    const tc = useChatStore.getState().messages[0].toolCalls!.find(t => t.id === 'tc-err')!
    expect(tc.status).toBe('error')
    expect(tc.isError).toBe(true)
  })

  it('is a no-op when streamingMessageId is null (guards against race)', () => {
    // streamingMessageId already cleared (e.g. after turn_end)
    const msgId = setStreamingMessage({ toolCalls: [{ id: 'tc-1', name: 'Run', status: 'running' }] })
    useChatStore.setState({ streamingMessageId: null })

    const msgsBefore = useChatStore.getState().messages

    cbToolResult!({ id: 'tc-1', output: 'result', isError: false, sessionId: 'test-session' })

    // State should be identical reference (no mutation)
    expect(useChatStore.getState().messages).toBe(msgsBefore)
    // Tool call still 'running' since update was skipped
    const tc = useChatStore.getState().messages.find(m => m.id === msgId)?.toolCalls?.[0]
    expect(tc?.status).toBe('running')
  })

  it('does not mutate unrelated messages', () => {
    // Two messages: one user, one streaming assistant with the tool
    const userMsg = { id: 'user-1', role: 'user' as const, content: 'do it', timestamp: 1000 }
    const assistantId = 'stream-msg'
    useChatStore.setState({
      isStreaming: true,
      streamingMessageId: assistantId,
      messages: [
        userMsg,
        { id: assistantId, role: 'assistant', content: '', timestamp: 1001, isStreaming: true,
          toolCalls: [{ id: 'tc-x', name: 'Run', status: 'running' }] }
      ]
    })

    cbToolResult!({ id: 'tc-x', output: 'ok', isError: false, sessionId: 'test-session' })

    const { messages } = useChatStore.getState()
    // User message reference unchanged
    expect(messages[0]).toBe(userMsg)
    expect(messages[1].toolCalls![0].status).toBe('completed')
  })
})

// ══════════════════════════════════════════════════════════
// 5. onStreamEnd — finalizes streaming message
// ══════════════════════════════════════════════════════════

describe('onStreamEnd', () => {
  it('finalizes the streaming message and clears isStreaming/streamingMessageId', () => {
    setStreamingMessage({ content: 'Answer here' })

    cbEnd!({ usage: { inputTokens: 100, outputTokens: 50 }, sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.streamingMessageId).toBe(null)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.streamJustEnded).toBe(true)
    const msg = state.messages[0]
    expect(msg.isStreaming).toBe(false)
    expect(msg.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('drops trailing empty assistant bubble if it received no content', () => {
    // Empty streaming message (no text, thinking, or tools)
    useChatStore.setState({
      isStreaming: true,
      streamingMessageId: 'empty-bubble',
      messages: [{ id: 'empty-bubble', role: 'assistant', content: '', timestamp: 1000, isStreaming: true, toolCalls: [] }]
    })

    cbEnd!({ usage: { inputTokens: 10, outputTokens: 0 }, sessionId: 'test-session' })

    expect(useChatStore.getState().messages).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════
// 6. onStreamError — error recovery
// ══════════════════════════════════════════════════════════

describe('onStreamError', () => {
  it('sets error state and clears streaming flags', () => {
    setStreamingMessage({ content: 'partial...' })

    cbError!({ error: 'Rate limit exceeded', sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.streamingMessageId).toBe(null)
    expect(state.error).toBe('Rate limit exceeded')
    // existing message marked not-streaming
    expect(state.messages[0].isStreaming).toBe(false)
  })

  it('clears streamingMessageId even with no streaming message', () => {
    useChatStore.setState({ isStreaming: true, isWaitingForResponse: true, streamingMessageId: null, messages: [] })

    cbError!({ error: 'Network timeout', sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.error).toBe('Network timeout')
  })
})

// ══════════════════════════════════════════════════════════
// 7. onStreamTurnEnd — multi-turn: finalize + wait
// ══════════════════════════════════════════════════════════

describe('onStreamTurnEnd', () => {
  it('finalizes current bubble and sets isWaitingForResponse=true', () => {
    setStreamingMessage({ content: 'Turn 1 answer' })

    cbTurnEnd!({ sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.streamingMessageId).toBe(null)
    expect(state.isWaitingForResponse).toBe(true)
    // global isStreaming stays true (agent loop still running)
    expect(state.isStreaming).toBe(true)
    // message marked done
    expect(state.messages[0].isStreaming).toBe(false)
  })

  it('does NOT create an empty placeholder assistant message (anti-pattern removed)', () => {
    setStreamingMessage({ content: 'Done thinking' })
    const countBefore = useChatStore.getState().messages.length

    cbTurnEnd!({ sessionId: 'test-session' })

    // No new message added — placeholder is shown in ChatPanel via isWaitingForResponse
    expect(useChatStore.getState().messages.length).toBe(countBefore)
  })

  it('handles turn_end when no streaming message exists (edge case)', () => {
    useChatStore.setState({ isStreaming: true, isWaitingForResponse: false, streamingMessageId: null, messages: [] })

    cbTurnEnd!({ sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.isWaitingForResponse).toBe(true)
    expect(state.streamingMessageId).toBe(null)
    expect(state.messages).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════
// 8. onStreamRetrying
// ══════════════════════════════════════════════════════════

describe('onStreamRetrying', () => {
  it('appends retry note to existing streaming message content', () => {
    setStreamingMessage({ content: 'partial answer' })

    cbRetrying!({ attempt: 1, maxAttempts: 3, delayMs: 2000, sessionId: 'test-session' })
    // retrying calls flushTextBatch then set() directly — no rAF needed

    const msg = useChatStore.getState().messages[0]
    expect(msg.content).toContain('Retrying 1/3')
    expect(msg.content).toContain('2.0s')
  })

  it('creates a status message when no streaming message exists', () => {
    useChatStore.setState({ isStreaming: true, streamingMessageId: null, messages: [] })

    cbRetrying!({ attempt: 2, maxAttempts: 3, delayMs: 4000, sessionId: 'test-session' })

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].content).toContain('Retrying 2/3')
    expect(state.streamingMessageId).toBe(state.messages[0].id)
  })
})

// ══════════════════════════════════════════════════════════
// 9. Full happy-path E2E flow
//    thinking → text → tool_start → tool_result → end
// ══════════════════════════════════════════════════════════

describe('Full streaming turn (E2E happy path)', () => {
  it('assembles a complete assistant message across all event types', () => {
    // Agent starts with extended thinking
    cbThinking!({ content: 'I need to read the file first.', sessionId: 'test-session' })
    flushRaf()  // thinking is now rAF-batched
    let state = useChatStore.getState()
    const msgId = state.streamingMessageId!
    expect(msgId).toBeTruthy()
    expect(state.messages[0].thinkingContent).toBe('I need to read the file first.')

    // Text flows — batched into rAF queue
    cbText!({ content: 'Here is ', sessionId: 'test-session' })
    cbText!({ content: 'my answer.', sessionId: 'test-session' })

    // Tool call flushes the pending text batch synchronously first
    cbToolStart!({ id: 'tc-1', name: 'FileRead', sessionId: 'test-session' })
    expect(useChatStore.getState().messages[0].content).toBe('Here is my answer.')
    expect(useChatStore.getState().messages[0].toolCalls).toHaveLength(1)
    expect(useChatStore.getState().messages[0].toolCalls![0].status).toBe('running')

    // Tool completes
    cbToolResult!({ id: 'tc-1', output: 'file: hello.ts', isError: false, sessionId: 'test-session' })
    expect(useChatStore.getState().messages[0].toolCalls![0].status).toBe('completed')
    expect(useChatStore.getState().messages[0].toolCalls![0].output).toBe('file: hello.ts')

    // Stream ends (also flushes any remaining text batch)
    cbEnd!({ usage: { inputTokens: 200, outputTokens: 80 }, sessionId: 'test-session' })
    state = useChatStore.getState()

    // Final assertions
    expect(state.isStreaming).toBe(false)
    expect(state.streamingMessageId).toBe(null)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.streamJustEnded).toBe(true)
    expect(state.messages).toHaveLength(1)

    const msg = state.messages[0]
    expect(msg.id).toBe(msgId)                      // same message throughout
    expect(msg.role).toBe('assistant')
    expect(msg.thinkingContent).toBe('I need to read the file first.')
    expect(msg.content).toBe('Here is my answer.')
    expect(msg.toolCalls).toHaveLength(1)
    expect(msg.toolCalls![0].status).toBe('completed')
    expect(msg.usage).toEqual({ inputTokens: 200, outputTokens: 80 })
    expect(msg.isStreaming).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════
// 10. Multi-turn flow (turn_end between turns)
// ══════════════════════════════════════════════════════════

describe('Multi-turn streaming flow', () => {
  it('correctly separates two consecutive turns into distinct messages', () => {
    // Turn 1: text only
    cbText!({ content: 'Turn 1 content', sessionId: 'test-session' })
    // turn_end calls flushTextBatch(), flushing the pending text batch
    cbTurnEnd!({ sessionId: 'test-session' })
    const turn1Id = useChatStore.getState().messages[0].id

    expect(useChatStore.getState().streamingMessageId).toBe(null)
    expect(useChatStore.getState().isWaitingForResponse).toBe(true)
    expect(useChatStore.getState().messages[0].content).toBe('Turn 1 content')

    // Turn 2: tool call
    cbToolStart!({ id: 'tc-t2', name: 'RunCommand', sessionId: 'test-session' })
    const turn2Id = useChatStore.getState().streamingMessageId!
    expect(turn2Id).not.toBe(turn1Id)   // new message for turn 2

    cbToolResult!({ id: 'tc-t2', output: 'ok', isError: false, sessionId: 'test-session' })

    cbText!({ content: 'Done.', sessionId: 'test-session' })
    // stream end flushes pending text
    cbEnd!({ usage: { inputTokens: 300, outputTokens: 120 }, sessionId: 'test-session' })

    const { messages } = useChatStore.getState()
    expect(messages).toHaveLength(2)

    expect(messages[0].id).toBe(turn1Id)
    expect(messages[0].content).toBe('Turn 1 content')
    expect(messages[0].isStreaming).toBe(false)

    expect(messages[1].id).toBe(turn2Id)
    expect(messages[1].content).toBe('Done.')
    expect(messages[1].toolCalls![0].status).toBe('completed')
    expect(messages[1].isStreaming).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════
// 11. 反卡顿专项 — rAF burst 保护 (anti-jank E2E)
//
// 验证目标：
//   A. 100 个连续 text delta → 只排队 1 个 rAF → 只触发 1 次 setState
//   B. 100 个 thinking delta → 独立 batch，与 text batch 互不干扰
//   C. 会话切换发生在 rAF flush 之前 → 残留文本被丢弃（不产生幽灵消息）
//   D. flush 之后继续来的 delta → 成功排队新 rAF（帧间连续性）
//   E. 极高频交错（text + thinking 混发）→ 最多 2 个 rAF，分别独立 flush
// ══════════════════════════════════════════════════════════

describe('反卡顿 rAF burst 保护 (anti-jank E2E)', () => {
  it('A: 100 个 text delta 只排队 1 个 rAF，flush 后全部累积', () => {
    setStreamingMessage({ content: '' })

    // 模拟高频 LLM token 流（100 个 token）
    for (let i = 0; i < 100; i++) {
      cbText!({ content: `token${i} `, sessionId: 'test-session' })
    }

    // 关键断言：不管来多少 delta，rAF 队列始终只有 1 条（守卫生效）
    expect(rafQueue.size).toBe(1)

    flushRaf()

    const { messages } = useChatStore.getState()
    const fullText = messages[0].content
    // 所有 100 个 token 都被正确累积
    expect(fullText).toBe(Array.from({ length: 100 }, (_, i) => `token${i} `).join(''))
  })

  it('A2: 100 个 text delta 只触发 1 次 Zustand setState（不产生冗余重渲染）', () => {
    setStreamingMessage({ content: '' })

    let stateUpdateCount = 0
    const unsub = useChatStore.subscribe(() => { stateUpdateCount++ })

    for (let i = 0; i < 100; i++) {
      cbText!({ content: `t${i}`, sessionId: 'test-session' })
    }

    // flush 前：还未 setState，仅有 rAF 等待
    const countBeforeFlush = stateUpdateCount

    flushRaf()

    unsub()

    // flush 后恰好 +1 次（100 个 delta → 1 次 setState）
    expect(stateUpdateCount - countBeforeFlush).toBe(1)
    expect(rafQueue.size).toBe(0)
  })

  it('B: thinking 和 text 各自独立 batch，互不干扰', () => {
    setStreamingMessage({ content: '', thinkingContent: '' })

    // 50 个 thinking delta
    for (let i = 0; i < 50; i++) {
      cbThinking!({ content: `th${i} `, sessionId: 'test-session' })
    }
    // 50 个 text delta
    for (let i = 0; i < 50; i++) {
      cbText!({ content: `tx${i} `, sessionId: 'test-session' })
    }

    // 两个 batch 各自独立：thinking rAF + text rAF = 2 个
    expect(rafQueue.size).toBe(2)

    flushRaf()

    const { messages } = useChatStore.getState()
    const msg = messages[0]
    // thinking 和 text 分别累积，无交叉污染
    expect(msg.thinkingContent).toBe(Array.from({ length: 50 }, (_, i) => `th${i} `).join(''))
    expect(msg.content).toBe(Array.from({ length: 50 }, (_, i) => `tx${i} `).join(''))
  })

  it('C: 会话切换发生在 rAF flush 之前 → 残留 delta 被丢弃（不产生幽灵消息）', () => {
    setStreamingMessage({ content: 'existing content' })

    // 50 个 delta 进入 buffer，尚未 flush
    for (let i = 0; i < 50; i++) {
      cbText!({ content: `ghost${i}`, sessionId: 'test-session' })
    }
    expect(rafQueue.size).toBe(1)

    // 模拟会话切换：isStreaming=false + streamingMessageId=null（chat-store 切换逻辑）
    useChatStore.setState({ isStreaming: false, streamingMessageId: null })

    // 现在 flush rAF（模拟浏览器帧到来）
    flushRaf()

    const { messages } = useChatStore.getState()
    // 没有新消息被创建，existing message 未被污染
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('existing content')
  })

  it('D: flush 之后继续到来的 delta 能成功排队新 rAF（帧间连续性）', () => {
    setStreamingMessage({ content: '' })

    // 第一帧：发送一批 delta
    cbText!({ content: 'frame1 ', sessionId: 'test-session' })
    expect(rafQueue.size).toBe(1)
    flushRaf()
    expect(rafQueue.size).toBe(0)
    expect(useChatStore.getState().messages[0].content).toBe('frame1 ')

    // 第二帧：再来一批 delta（确保没有被锁死）
    for (let i = 0; i < 5; i++) {
      cbText!({ content: `f2-${i} `, sessionId: 'test-session' })
    }
    expect(rafQueue.size).toBe(1)  // 新 rAF 成功排队
    flushRaf()

    const content = useChatStore.getState().messages[0].content
    expect(content).toBe('frame1 ' + Array.from({ length: 5 }, (_, i) => `f2-${i} `).join(''))
  })

  it('E: 极高频交错（text + thinking 同帧混发）→ 最多 2 个 rAF，分别独立 flush', () => {
    setStreamingMessage({ content: '', thinkingContent: '' })

    let stateUpdateCount = 0
    const unsub = useChatStore.subscribe(() => { stateUpdateCount++ })

    // 高频交错：每次交替发 text 和 thinking
    for (let i = 0; i < 200; i++) {
      if (i % 2 === 0) cbText!({ content: `t`, sessionId: 'test-session' })
      else cbThinking!({ content: `k`, sessionId: 'test-session' })
    }

    // 无论多少 delta，最多 2 个 rAF（text 1 个 + thinking 1 个）
    expect(rafQueue.size).toBeLessThanOrEqual(2)

    const countBefore = stateUpdateCount
    flushRaf()
    unsub()

    // 2 个 batch flush → 最多 2 次 setState
    expect(stateUpdateCount - countBefore).toBeLessThanOrEqual(2)

    const msg = useChatStore.getState().messages[0]
    // 200 个 token，各 100 个
    expect(msg.content).toBe('t'.repeat(100))
    expect(msg.thinkingContent).toBe('k'.repeat(100))
  })
})

// ============================================================
// Multi-Session Switching E2E Tests
//
// Validates the 3 root-cause fixes:
//   RC1: sessionId filter — events for non-active session are discarded
//   RC2: stream events carry sessionId for correct routing
//   RC3: streamingMessageId restoration on switch-back to running session
// ============================================================
describe('Multi-Session Switching', () => {
  const SESSION_A = 'session-a'
  const SESSION_B = 'session-b'

  /**
   * Helper: set up the store as if session A is streaming
   */
  function setupSessionAStreaming() {
    useChatStore.setState({
      activeSessionId: SESSION_A,
      conversationId: SESSION_A,
      isStreaming: true,
      isWaitingForResponse: false,
      streamingMessageId: 'msg-a-1',
      messages: [
        { id: 'msg-a-0', role: 'user', content: 'task A', timestamp: 100, toolCalls: [] },
        { id: 'msg-a-1', role: 'assistant', content: '', timestamp: 101, isStreaming: true, toolCalls: [] },
      ],
      runningSessionIds: new Set([SESSION_A]),
    })
  }

  // --- RC1: sessionId filter discards events for non-active session ---

  it('RC1a: text_delta for non-active session is discarded', () => {
    setupSessionAStreaming()
    // Switch to session B (simulates switchSession cleanState reset)
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: false,
      streamingMessageId: null,
      messages: [],
      runningSessionIds: new Set([SESSION_A]),
    })

    // Session A is still running in main process, but events arrive with sessionId=A
    const beforeMsgCount = useChatStore.getState().messages.length
    cbText!({ content: 'progress from A', sessionId: SESSION_A })
    flushRaf()

    // Events for session A should be discarded since activeSessionId is B
    expect(useChatStore.getState().messages.length).toBe(beforeMsgCount)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('RC1b: tool_use_start for non-active session is discarded', () => {
    setupSessionAStreaming()
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: false,
      streamingMessageId: null,
      messages: [],
      runningSessionIds: new Set([SESSION_A]),
    })

    const beforeMsgCount = useChatStore.getState().messages.length
    cbToolStart!({ id: 'tc-a1', name: 'FileRead', sessionId: SESSION_A })

    expect(useChatStore.getState().messages.length).toBe(beforeMsgCount)
  })

  it('RC1c: stream:done for non-active session is discarded (does not clear isStreaming)', () => {
    // Set up session B as active and streaming
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: true,
      streamingMessageId: 'msg-b-1',
      messages: [
        { id: 'msg-b-1', role: 'assistant', content: 'B response', timestamp: 200, isStreaming: true, toolCalls: [] },
      ],
      runningSessionIds: new Set([SESSION_A, SESSION_B]),
    })

    // Session A finishes — done event arrives with sessionId=A
    cbEnd!({ usage: { inputTokens: 100, outputTokens: 50 }, sessionId: SESSION_A })

    // Session B should still be streaming — not affected by A's done
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingMessageId).toBe('msg-b-1')
  })

  it('RC1d: stream:turn_end for non-active session is discarded', () => {
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: true,
      streamingMessageId: 'msg-b-1',
      messages: [
        { id: 'msg-b-1', role: 'assistant', content: 'B response', timestamp: 200, isStreaming: true, toolCalls: [] },
      ],
      runningSessionIds: new Set([SESSION_A, SESSION_B]),
    })

    // Session A turn_end with sessionId=A
    cbTurnEnd!({ sessionId: SESSION_A })

    // B should still be streaming
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingMessageId).toBe('msg-b-1')
  })

  // --- RC2: events for the correct active session are processed ---

  it('RC2: events with matching sessionId are processed normally', () => {
    setupSessionAStreaming()

    cbText!({ content: 'Hello ', sessionId: SESSION_A })
    flushRaf()

    const msgs = useChatStore.getState().messages
    const assistantMsg = msgs.find((m: any) => m.id === 'msg-a-1')
    expect(assistantMsg).toBeDefined()
    expect((assistantMsg as any).content).toContain('Hello')
  })

  // --- RC3: streaming state restoration on switch-back ---

  it('RC3a: switch back to running session restores isStreaming and streamingMessageId', () => {
    setupSessionAStreaming()

    // Simulate some text arriving
    cbText!({ content: 'Partial response ', sessionId: SESSION_A })
    flushRaf()

    // Verify text was appended
    const msgsBefore = useChatStore.getState().messages
    const assistantBefore = msgsBefore.find((m: any) => m.id === 'msg-a-1')
    expect((assistantBefore as any).content).toContain('Partial response')

    // Switch to session B
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: false,
      isWaitingForResponse: false,
      streamingMessageId: null,
      messages: [],
      runningSessionIds: new Set([SESSION_A]),  // A still running
    })

    // Events for A arrive while viewing B — should be discarded
    cbText!({ content: 'lost progress ', sessionId: SESSION_A })
    flushRaf()
    expect(useChatStore.getState().messages.length).toBe(0) // B has no messages

    // Switch back to session A — simulates switchSession
    // Load A's messages (from cache/disk) and restore streaming state
    const loadedMessages = [
      { id: 'msg-a-0', role: 'user', content: 'task A', timestamp: 100, toolCalls: [] },
      // Note: buildChatMessagesFromRaw never sets isStreaming=true
      { id: 'msg-a-1', role: 'assistant', content: 'Partial response ', timestamp: 101, toolCalls: [] },
    ]
    useChatStore.setState({
      activeSessionId: SESSION_A,
      conversationId: SESSION_A,
      isStreaming: false,
      isWaitingForResponse: false,
      streamingMessageId: null,
      messages: loadedMessages,
      runningSessionIds: new Set([SESSION_A]),
    })

    // Now apply the switchSession restoration logic:
    // Find last assistant message and mark it as streaming
    const currentMsgs = useChatStore.getState().messages
    const lastAssistant = [...currentMsgs].reverse().find((m: any) => m.role === 'assistant')
    if (lastAssistant) {
      const restoredMessages = currentMsgs.map((m: any) =>
        m.id === lastAssistant.id ? { ...m, isStreaming: true } : m
      )
      useChatStore.setState({
        isStreaming: true,
        isWaitingForResponse: true,
        streamingMessageId: lastAssistant.id,
        messages: restoredMessages,
      })
    }

    // Verify restoration worked
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().streamingMessageId).toBe('msg-a-1')

    // New events for A should now be accepted and append to existing message
    cbText!({ content: 'continued!', sessionId: SESSION_A })
    flushRaf()

    const msgsAfter = useChatStore.getState().messages
    const assistantAfter = msgsAfter.find((m: any) => m.id === 'msg-a-1')
    expect((assistantAfter as any).content).toBe('Partial response continued!')
    expect((assistantAfter as any).isStreaming).toBe(true)

    // Should NOT have created a duplicate assistant message
    const assistantCount = msgsAfter.filter((m: any) => m.role === 'assistant').length
    expect(assistantCount).toBe(1)
  })

  it('RC3b: switch to non-running session does not restore streaming', () => {
    setupSessionAStreaming()

    // A finishes while we're on it
    cbEnd!({ usage: { inputTokens: 100, outputTokens: 50 }, sessionId: SESSION_A })

    // Switch to session B — A is no longer running
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: false,
      streamingMessageId: null,
      messages: [],
      runningSessionIds: new Set(),  // No running sessions
    })

    // Running check: runningSessionIds does NOT have B
    expect(useChatStore.getState().runningSessionIds.has(SESSION_B)).toBe(false)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  // --- Full scenario: two sessions, interleaved events ---

  it('FULL: two concurrent sessions with switch — events correctly routed', () => {
    // Session A starts streaming
    useChatStore.setState({
      activeSessionId: SESSION_A,
      conversationId: SESSION_A,
      isStreaming: true,
      streamingMessageId: 'msg-a-1',
      messages: [
        { id: 'msg-a-0', role: 'user', content: 'task A', timestamp: 100, toolCalls: [] },
        { id: 'msg-a-1', role: 'assistant', content: '', timestamp: 101, isStreaming: true, toolCalls: [] },
      ],
      runningSessionIds: new Set([SESSION_A]),
    })

    // A receives text
    cbText!({ content: 'A text ', sessionId: SESSION_A })
    flushRaf()
    expect((useChatStore.getState().messages.find((m: any) => m.id === 'msg-a-1') as any).content).toBe('A text ')

    // Switch to B (B also starts running)
    useChatStore.setState({
      activeSessionId: SESSION_B,
      conversationId: SESSION_B,
      isStreaming: true,
      streamingMessageId: 'msg-b-1',
      messages: [
        { id: 'msg-b-0', role: 'user', content: 'task B', timestamp: 200, toolCalls: [] },
        { id: 'msg-b-1', role: 'assistant', content: '', timestamp: 201, isStreaming: true, toolCalls: [] },
      ],
      runningSessionIds: new Set([SESSION_A, SESSION_B]),
    })

    // A's events arrive but should be discarded for B
    cbText!({ content: 'A more text', sessionId: SESSION_A })
    flushRaf()
    // B's message should NOT contain A's text
    expect((useChatStore.getState().messages.find((m: any) => m.id === 'msg-b-1') as any).content).toBe('')

    // B receives its own text — should be accepted
    cbText!({ content: 'B response', sessionId: SESSION_B })
    flushRaf()
    expect((useChatStore.getState().messages.find((m: any) => m.id === 'msg-b-1') as any).content).toBe('B response')

    // B finishes
    cbEnd!({ usage: { inputTokens: 50, outputTokens: 10 }, sessionId: SESSION_B })
    expect(useChatStore.getState().isStreaming).toBe(false)

    // Switch back to A — restore streaming state
    const aMessages = [
      { id: 'msg-a-0', role: 'user', content: 'task A', timestamp: 100, toolCalls: [] },
      { id: 'msg-a-1', role: 'assistant', content: 'A text ', timestamp: 101, toolCalls: [] },
    ]
    const lastA = [...aMessages].reverse().find((m: any) => m.role === 'assistant')!
    useChatStore.setState({
      activeSessionId: SESSION_A,
      conversationId: SESSION_A,
      isStreaming: false,
      streamingMessageId: null,
      messages: aMessages.map((m: any) => m.id === lastA.id ? { ...m, isStreaming: true } : m),
      runningSessionIds: new Set([SESSION_A]),
    })
    // Apply restoration
    useChatStore.setState({
      isStreaming: true,
      isWaitingForResponse: true,
      streamingMessageId: lastA.id,
    })

    // A continues receiving text — should append to existing message
    cbText!({ content: ' resumed', sessionId: SESSION_A })
    flushRaf()
    expect((useChatStore.getState().messages.find((m: any) => m.id === 'msg-a-1') as any).content).toBe('A text  resumed')

    // No duplicate messages
    const assistantCount = useChatStore.getState().messages.filter((m: any) => m.role === 'assistant').length
    expect(assistantCount).toBe(1)
  })
})
