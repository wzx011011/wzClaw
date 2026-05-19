// ============================================================
// 端到端集成测试 — 验证完整的消息收发流程
//
// 使用 FakeWebSocket 模拟 agent-server，测试：
// 1. 完整消息收发流程：createSession -> sendMessage -> stream:text -> stream:done
// 2. Session CRUD：createSession -> listSessions -> deleteSession
// 3. 连接断开和重连：ws.close() -> onConnectionChange(false) -> 重连 -> onConnectionChange(true)
// 4. 设置持久化：保存 agentUrl -> 新 DataSource 使用新 URL
// 5. 多事件流：连续 stream:text + tool_call + tool_result + done
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketDataSource } from '../data-source/websocket-source'
import { createChatStore } from '../stores/chat-store'
import type { ChatStore } from '../stores/chat-store'
import { useHandStore } from '../stores/hand-store'
import { useI18nStore } from '../i18n/i18n-store'

// ---- FakeWebSocket 模拟 ----

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  url: string
  protocols?: string | string[]
  readyState: number = FakeWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  sentMessages: string[] = []

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}

// ---- 测试辅助 ----

let fakeWs: FakeWebSocket
const OriginalWebSocket = globalThis.WebSocket
const OriginalRAF = globalThis.requestAnimationFrame
const OriginalCAF = globalThis.cancelAnimationFrame
let rafId = 0
const rafCallbacks = new Map<number, FrameRequestCallback>()

function mockRAF(callback: FrameRequestCallback): number {
  rafId += 1
  rafCallbacks.set(rafId, callback)
  return rafId
}

function mockCAF(id: number): void {
  rafCallbacks.delete(id)
}

function flushRAF(): void {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  for (const callback of callbacks) callback(Date.now())
}

function mockWebSocket() {
  // @ts-expect-error — 测试用，覆盖全局 WebSocket
  globalThis.WebSocket = class MockedWebSocket extends FakeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols)
      fakeWs = this
    }
  } as unknown as typeof WebSocket
}

function restoreWebSocket() {
  globalThis.WebSocket = OriginalWebSocket
}

/** 辅助：等待 Promise 执行 */
function flushPromises(): Promise<void> {
  return Promise.resolve()
}

/** 辅助：解析 FakeWebSocket 最后发送的消息 */
function parseLastSent(): { event: string; data?: unknown } | null {
  if (fakeWs.sentMessages.length === 0) return null
  return JSON.parse(fakeWs.sentMessages[fakeWs.sentMessages.length - 1]!) as { event: string; data?: unknown }
}

// ---- 测试 ----

describe('Integration: 端到端流程', () => {
  beforeEach(() => {
    mockWebSocket()
    globalThis.requestAnimationFrame = mockRAF
    globalThis.cancelAnimationFrame = mockCAF
    useHandStore.getState().clearSelection()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.requestAnimationFrame = OriginalRAF
    globalThis.cancelAnimationFrame = OriginalCAF
    rafCallbacks.clear()
    restoreWebSocket()
  })

  it('完整消息收发流程：sendMessage -> stream:text -> stream:done', async () => {
    // 创建 DataSource
    const ds = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = ds.connect()
    fakeWs.simulateOpen()
    await connectPromise

    // 创建 Chat Store
    const store = createChatStore(ds)
    const unsub = store.getState().init()

    // 1. 使用已有会话；Session CRUD 在下一个用例单独覆盖
    store.setState({ conversationId: 'test-session-1', activeSessionId: 'test-session-1' } as unknown as Partial<ChatStore>)
    expect(store.getState().conversationId).toBe('test-session-1')

    // 2. 发送消息
    const sendPromise = store.getState().sendMessage('你好')
    await flushPromises()
    fakeWs.simulateMessage({ event: 'session:config', data: { config: null } })
    await sendPromise
    const sentMsg = parseLastSent()
    expect(sentMsg?.event).toBe('chat:send')
    expect(sentMsg?.data).toEqual({ sessionId: 'test-session-1', message: '你好' })

    // 3. 模拟收到 stream:text
    fakeWs.simulateMessage({ event: 'stream:text', data: { delta: '你' } })
    fakeWs.simulateMessage({ event: 'stream:text', data: { delta: '好！' } })

    // 4. 模拟收到 stream:done
    fakeWs.simulateMessage({
      event: 'stream:done',
      data: { usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
    })

    // 等待状态更新
    flushRAF()
    await flushPromises()

    const state = store.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.messages.length).toBeGreaterThanOrEqual(2)
    // 用户消息
    expect(state.messages[0]!.role).toBe('user')
    expect(state.messages[0]!.content).toBe('你好')
    // assistant 消息（流式文本）
    expect(state.messages[1]!.role).toBe('assistant')
    expect(state.messages[1]!.content).toContain('你好')

    unsub()
    ds.disconnect()
  })

  it('Session CRUD：createSession -> listSessions -> deleteSession', async () => {
    const ds = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = ds.connect()
    fakeWs.simulateOpen()
    await connectPromise

    const store = createChatStore(ds)
    const unsub = store.getState().init()

    // 1. 创建会话
    const createPromise = ds.createSession()
    fakeWs.simulateMessage({ event: 'session:created', data: { sessionId: 'sess-1' } })
    const newId = await createPromise
    expect(newId).toBe('sess-1')

    // 2. 列出会话
    const listPromise = ds.listSessions()
    fakeWs.simulateMessage({
      event: 'session:list',
      data: {
        sessions: [
          { id: 'sess-1', title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
        ],
      },
    })
    const sessions = await listPromise
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('sess-1')

    // 通过 store 加载会话列表（会再次发送 session:list 请求）
    const loadListPromise = store.getState().loadSessionList()
    // store 的 loadSessionList 调用了 ds.listSessions()，需要模拟第二次 session:list 响应
    fakeWs.simulateMessage({
      event: 'session:list',
      data: {
        sessions: [
          { id: 'sess-1', title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
        ],
      },
    })
    await loadListPromise
    expect(store.getState().sessions).toHaveLength(1)

    // 3. 删除会话
    const deletePromise = store.getState().deleteSession('sess-1')
    fakeWs.simulateMessage({ event: 'session:deleted', data: {} })
    await deletePromise

    // 验证会话列表已更新
    expect(store.getState().sessions).toHaveLength(0)

    unsub()
    ds.disconnect()
  })

  it('连接断开和重连：ws.close() -> onConnectionChange(false) -> 重连 -> onConnectionChange(true)', async () => {
    const ds = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = ds.connect()
    fakeWs.simulateOpen()
    await connectPromise

    const connectionStates: boolean[] = []
    ds.onConnectionChange((connected) => {
      connectionStates.push(connected)
    })

    // 模拟断线
    fakeWs.simulateClose()
    expect(ds.isConnected()).toBe(false)
    expect(connectionStates).toContain(false)

    // 等待重连定时器触发（1s 后）
    vi.advanceTimersByTime(1000)

    // 新的 FakeWebSocket 已创建，模拟连接成功
    fakeWs.simulateOpen()
    expect(ds.isConnected()).toBe(true)
    expect(connectionStates).toContain(true)

    ds.disconnect()
  })

  it('设置持久化：不同 URL 创建不同 DataSource', async () => {
    // 使用 URL1 创建 DataSource
    const ds1 = new WebSocketDataSource('ws://localhost:8082')
    const connect1 = ds1.connect()
    fakeWs.simulateOpen()
    await connect1
    expect(fakeWs.url).toBe('ws://localhost:8082')
    ds1.disconnect()

    // 使用 URL2 创建 DataSource
    const ds2 = new WebSocketDataSource('wss://nas.example.com/relay')
    const connect2 = ds2.connect()
    fakeWs.simulateOpen()
    await connect2
    expect(fakeWs.url).toBe('wss://nas.example.com/relay')
    ds2.disconnect()

    // 验证两个 URL 不同
    expect(ds1).not.toBe(ds2)
  })

  it('多事件流：连续 stream:text + tool_call + tool_result + done', async () => {
    const ds = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = ds.connect()
    fakeWs.simulateOpen()
    await connectPromise

    const store = createChatStore(ds)
    const unsub = store.getState().init()

    // 设置会话 ID
    store.setState({ conversationId: 'multi-event-session' } as unknown as Partial<ChatStore>)

    // 发送消息
    const sendPromise = store.getState().sendMessage('读取 config.json')
    await flushPromises()
    fakeWs.simulateMessage({ event: 'session:config', data: { config: null } })
    await sendPromise

    // 1. 收到 thinking 事件
    fakeWs.simulateMessage({ event: 'stream:thinking', data: { content: '分析用户请求...' } })

    // 2. 收到 stream:text
    fakeWs.simulateMessage({ event: 'stream:text', data: { delta: '让我读取' } })
    fakeWs.simulateMessage({ event: 'stream:text', data: { delta: ' config.json' } })

    // 3. 收到 tool_call
    fakeWs.simulateMessage({
      event: 'stream:tool_call',
      data: { toolCallId: 'tc-1', name: 'read_file', input: { path: 'config.json' } },
    })

    // 4. 收到 tool_result
    fakeWs.simulateMessage({
      event: 'stream:tool_result',
      data: { toolCallId: 'tc-1', name: 'read_file', output: '{"name": "wzxClaw"}', isError: false },
    })

    // 5. 继续流式文本
    fakeWs.simulateMessage({ event: 'stream:text', data: { delta: '\n文件内容如上。' } })

    // 6. done
    fakeWs.simulateMessage({
      event: 'stream:done',
      data: { usage: { inputTokens: 100, outputTokens: 50 }, turnCount: 1 },
    })

    flushRAF()
    await flushPromises()

    const state = store.getState()
    expect(state.isStreaming).toBe(false)

    // 验证 assistant 消息包含文本和工具调用
    const assistantMsg = state.messages.find(m => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toContain('让我读取')
    expect(assistantMsg!.toolCalls).toBeDefined()
    expect(assistantMsg!.toolCalls!.length).toBeGreaterThanOrEqual(1)
    expect(assistantMsg!.toolCalls![0]!.name).toBe('read_file')
    expect(assistantMsg!.toolCalls![0]!.status).toBe('completed')

    unsub()
    ds.disconnect()
  })

  it('i18n: t() 翻译函数正确工作', () => {
    const { t, setLocale } = useI18nStore.getState()

    // 默认中文
    expect(t('chat.send')).toBe('发送')
    expect(t('common.loading')).toBe('加载中...')

    // 参数替换
    expect(t('common.minutesAgo', { count: 5 })).toBe('5 分钟前')

    // 切换到英文
    setLocale('en')
    const tEn = useI18nStore.getState().t
    expect(tEn('chat.send')).toBe('Send')
    expect(tEn('common.minutesAgo', { count: 5 })).toBe('5 min ago')

    // 回退到中文（英文缺失的 key）
    expect(tEn('nonexistent.key')).toBe('nonexistent.key')

    // 恢复中文
    setLocale('zh-CN')
  })
})
