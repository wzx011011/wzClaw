// ============================================================
// client-handler.ts 测试 — 客户端连接处理 + AgentLoop 桥接
// mock AgentLoop、SessionStore、WebSocket，验证协议映射
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentEvent, AgentConfig } from '@wzxclaw/brain'
import type { ISessionStore, IEventSender, IToolExecutor } from '@wzxclaw/brain'
import type { WebSocket } from 'ws'
import { ClientHandler } from './client-handler.js'

// ---- 工具函数 ----

/** 轮询直到条件为 true 或超时 */
async function pollUntil(
  fn: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

// ---- Mock 工厂 ----

/** 创建 mock WebSocket */
function createMockWs(): WebSocket & { _sent: Array<string> } {
  const sent: string[] = []
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const ws = {
    _sent: sent,
    readyState: 1, // WebSocket.OPEN
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler)
    }),
    removeListener: vi.fn(),
    _listeners: listeners,
    /** 模拟收到消息 */
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners[event] || []
      for (const h of handlers) h(...args)
    },
    /** 获取发送的 JSON 消息 */
    _getSentMessages(): Array<{ event: string; data?: unknown }> {
      return sent.map(s => JSON.parse(s))
    },
  } as unknown as WebSocket & { _sent: string[] }
  return ws
}

/** 创建 mock SessionStore */
function createMockSessionStore(): ISessionStore {
  return {
    appendMessage: vi.fn(() => Promise.resolve()),
    loadSession: vi.fn(() => Promise.resolve([])),
    listSessions: vi.fn(() => Promise.resolve([])),
    deleteSession: vi.fn(() => Promise.resolve()),
  }
}

/** 创建 mock AgentLoop（返回预设事件的 AsyncGenerator） */
function createMockAgentLoop(events: AgentEvent[]) {
  return {
    run: vi.fn(async function* (
      _message: string,
      _config: AgentConfig,
      _sender?: IEventSender,
      _toolExecutor?: IToolExecutor,
    ): AsyncGenerator<AgentEvent, void, unknown> {
      for (const event of events) {
        yield event
      }
    }),
    cancel: vi.fn(),
    getMessages: vi.fn(() => []),
    replaceMessages: vi.fn(),
    isRunning: false,
  }
}

// ---- 测试 ----

describe('ClientHandler', () => {
  let handler: ClientHandler
  let sessionStore: ISessionStore
  let ws: ReturnType<typeof createMockWs>

  beforeEach(() => {
    sessionStore = createMockSessionStore()
    handler = new ClientHandler(sessionStore, {
      execute: vi.fn(() => Promise.resolve({ output: '', isError: false })),
      getDefinitions: vi.fn(() => []),
      isReadOnly: vi.fn(() => false),
    } as unknown as IToolExecutor)
  })

  describe('AgentEvent → Client 协议映射', () => {
    it('agent:text → stream:text', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:text', content: 'Hello' },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      // 触发 chat:send
      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'hi' },
      }))

      // 等待异步 handleChatSend 完成
      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const textMsg = msgs.find(m => m.event === 'stream:text')
      expect(textMsg).toBeDefined()
      expect(textMsg!.data).toEqual({ delta: 'Hello' })

      const doneMsg = msgs.find(m => m.event === 'stream:done')
      expect(doneMsg).toBeDefined()
      expect(doneMsg!.data).toEqual({ usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 })
    })

    it('agent:tool_call → stream:tool_call', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:tool_call', toolCallId: 'tc1', toolName: 'Read', input: { path: '/foo' } },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'read file' },
      }))

      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const toolMsg = msgs.find(m => m.event === 'stream:tool_call')
      expect(toolMsg).toBeDefined()
      expect(toolMsg!.data).toEqual({ toolCallId: 'tc1', name: 'Read', input: { path: '/foo' } })
    })

    it('agent:tool_result → stream:tool_result', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:tool_result', toolCallId: 'tc1', toolName: 'Read', output: 'file content', isError: false },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'read file' },
      }))

      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const resultMsg = msgs.find(m => m.event === 'stream:tool_result')
      expect(resultMsg).toBeDefined()
      expect(resultMsg!.data).toEqual({ toolCallId: 'tc1', name: 'Read', output: 'file content', isError: false })
    })

    it('agent:error → stream:error', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:error', error: 'Something went wrong', recoverable: true },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'error test' },
      }))

      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const errMsg = msgs.find(m => m.event === 'stream:error')
      expect(errMsg).toBeDefined()
      expect(errMsg!.data).toEqual({ error: 'Something went wrong', recoverable: true })
    })

    it('agent:thinking → stream:thinking', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:thinking', content: 'Let me think...' },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'think' },
      }))

      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const thinkMsg = msgs.find(m => m.event === 'stream:thinking')
      expect(thinkMsg).toBeDefined()
      expect(thinkMsg!.data).toEqual({ content: 'Let me think...' })
    })

    it('agent:compacted → stream:compacted', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:compacted', beforeTokens: 10000, afterTokens: 3000, auto: true },
        { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'compact' },
      }))

      await pollUntil(() => ws._sent.length >= 2)

      const msgs = ws._getSentMessages()
      const compactMsg = msgs.find(m => m.event === 'stream:compacted')
      expect(compactMsg).toBeDefined()
      expect(compactMsg!.data).toEqual({ beforeTokens: 10000, afterTokens: 3000 })
    })
  })

  describe('session 操作', () => {
    beforeEach(() => {
      ws = createMockWs()
      handler.handleConnection(ws)
    })

    it('session:list → 调用 SessionStore.listSessions() 并返回结果', async () => {
      const sessions = [
        { id: 's1', title: 'Chat 1', updatedAt: 1000 },
        { id: 's2', title: 'Chat 2', updatedAt: 2000 },
      ]
      ;(sessionStore.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue(sessions)

      ws._emit('message', JSON.stringify({ event: 'session:list' }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:list'))

      const msgs = ws._getSentMessages()
      const listMsg = msgs.find(m => m.event === 'session:list')
      expect(listMsg).toBeDefined()
      expect(listMsg!.data).toEqual(sessions)
      expect(sessionStore.listSessions).toHaveBeenCalled()
    })

    it('session:load → 加载历史消息', async () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]
      ;(sessionStore.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(messages)

      ws._emit('message', JSON.stringify({
        event: 'session:load',
        data: { sessionId: 's1' },
      }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:loaded'))

      const msgs = ws._getSentMessages()
      const loadMsg = msgs.find(m => m.event === 'session:loaded')
      expect(loadMsg).toBeDefined()
      expect(loadMsg!.data).toEqual({ messages })
      expect(sessionStore.loadSession).toHaveBeenCalledWith('s1')
    })

    it('session:create → 创建新会话', async () => {
      ws._emit('message', JSON.stringify({ event: 'session:create' }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:created'))

      const msgs = ws._getSentMessages()
      const createMsg = msgs.find(m => m.event === 'session:created')
      expect(createMsg).toBeDefined()
      expect(createMsg!.data).toHaveProperty('sessionId')
      // sessionId 应该是 UUID 格式
      expect(typeof (createMsg!.data as { sessionId: string }).sessionId).toBe('string')
    })

    it('session:delete → 删除会话', async () => {
      ws._emit('message', JSON.stringify({
        event: 'session:delete',
        data: { sessionId: 's1' },
      }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:deleted'))

      const msgs = ws._getSentMessages()
      const deleteMsg = msgs.find(m => m.event === 'session:deleted')
      expect(deleteMsg).toBeDefined()
      expect(deleteMsg!.data).toEqual({ sessionId: 's1' })
      expect(sessionStore.deleteSession).toHaveBeenCalledWith('s1')
    })
  })

  describe('AgentLoop 生命周期', () => {
    it('WebSocket 关闭时取消正在运行的 AgentLoop', async () => {
      // 创建一个长运行的 generator — yield 后挂起直到被取消
      let resolveBlock: () => void = () => {}
      const blockPromise = new Promise<void>(r => { resolveBlock = r })
      const mockLoop = {
        run: vi.fn(async function* (): AsyncGenerator<AgentEvent, void, unknown> {
          yield { type: 'agent:text', content: 'thinking...' }
          // 挂起 — 模拟长运行的 AgentLoop
          await blockPromise
          yield { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 }
        }),
        cancel: vi.fn(),
        getMessages: vi.fn(() => []),
        replaceMessages: vi.fn(),
      }
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)

      // 触发 chat:send
      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'hi' },
      }))

      // 等待处理开始（第一个 yield 已发送）
      await pollUntil(() => ws._sent.length > 0)

      // 关闭 WebSocket
      ws._emit('close')

      // cancel 应该被调用
      expect(mockLoop.cancel).toHaveBeenCalled()

      // 解除挂起，让 Promise 完成
      resolveBlock()
    })

    it('同一客户端新 chat:send 取消旧的 AgentLoop', async () => {
      // 第一个 loop — 长运行，在 yield 后挂起
      let resolveFirst: () => void = () => {}
      const firstBlock = new Promise<void>(r => { resolveFirst = r })
      const cancelFn = vi.fn()
      const firstLoop = {
        run: vi.fn(async function* (): AsyncGenerator<AgentEvent, void, unknown> {
          yield { type: 'agent:text', content: 'first' }
          await firstBlock
          yield { type: 'agent:done', usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 }
        }),
        cancel: cancelFn,
        getMessages: vi.fn(() => []),
        replaceMessages: vi.fn(),
      }

      let callCount = 0
      handler.setLoopFactory(() => {
        callCount++
        if (callCount === 1) return firstLoop as unknown as ReturnType<typeof createMockAgentLoop>
        const secondLoop = createMockAgentLoop([
          { type: 'agent:text', content: 'second' },
          { type: 'agent:done', usage: { inputTokens: 5, outputTokens: 3 }, turnCount: 1 },
        ])
        return secondLoop as unknown as ReturnType<typeof createMockAgentLoop>
      })

      ws = createMockWs()
      handler.handleConnection(ws)

      // 第一次 chat:send — 触发长运行的 loop
      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'first' },
      }))

      // 等待第一个 loop 的第一个 yield
      await pollUntil(() => ws._sent.length > 0)

      // 第二次 chat:send — 应该取消第一个
      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'second' },
      }))

      await pollUntil(() => ws._sent.length >= 3)

      expect(cancelFn).toHaveBeenCalled()

      // 解除挂起
      resolveFirst()
    })
  })

  describe('消息格式', () => {
    it('无效 JSON 消息不崩溃', () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      // 发送无效 JSON
      expect(() => ws._emit('message', 'not-json')).not.toThrow()
    })

    it('未知 event 被忽略', () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      expect(() => ws._emit('message', JSON.stringify({
        event: 'unknown:event',
        data: {},
      }))).not.toThrow()
    })
  })
})
