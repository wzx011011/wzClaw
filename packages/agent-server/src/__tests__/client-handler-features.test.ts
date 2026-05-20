// ============================================================
// client-handler 新功能测试
// - session:compact 真实压缩
// - 费用追踪
// - 运行状态广播
// - Host 操作（通过 Hand tool executor）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent, AgentConfig, ISessionStore, IToolExecutor, IEventSender } from '@wzxclaw/brain'
import type { WebSocket } from 'ws'
import { ClientHandler } from '../client-handler.js'
import type { WorkspaceService } from '../workspace-service.js'
import os from 'os'
import path from 'path'
import fsp from 'fs/promises'

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
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners[event] || []
      for (const h of handlers) h(...args)
    },
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
    renameSession: vi.fn(() => Promise.resolve()),
    createSession: vi.fn((config) => Promise.resolve({
      id: config.id,
      title: config.title ?? 'Untitled',
      createdAt: 1000,
      updatedAt: 1000,
      owner: config.owner ?? 'nas-remote',
    })),
    getSessionConfig: vi.fn(() => Promise.resolve(null)),
    updateSessionConfig: vi.fn((sessionId, patch) => Promise.resolve({
      id: sessionId,
      title: patch.title ?? 'Untitled',
      createdAt: 1000,
      updatedAt: 2000,
      owner: patch.owner ?? 'nas-remote',
    })),
    replaceMessages: vi.fn(() => Promise.resolve()),
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

describe('ClientHandler 新功能', () => {
  let handler: ClientHandler
  let sessionStore: ISessionStore
  let tmpConfigDir: string
  let origConfigDir: string | undefined
  let toolExecutor: IToolExecutor

  beforeEach(async () => {
    tmpConfigDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-feat-'))
    origConfigDir = process.env.WZXCLAW_CONFIG_DIR
    process.env.WZXCLAW_CONFIG_DIR = tmpConfigDir
    sessionStore = createMockSessionStore()
    toolExecutor = {
      execute: vi.fn(() => Promise.resolve({ output: '', isError: false })),
      getDefinitions: vi.fn(() => [
        { name: 'FileRead', description: 'Read file', inputSchema: {} },
        { name: 'FileList', description: 'List dir', inputSchema: {} },
        { name: 'FileWrite', description: 'Write file', inputSchema: {} },
        { name: 'ShellExecute', description: 'Run shell', inputSchema: {} },
        { name: 'Grep', description: 'Search files', inputSchema: {} },
        { name: 'Glob', description: 'Find files', inputSchema: {} },
      ]),
      isReadOnly: vi.fn(() => false),
    } as unknown as IToolExecutor
    handler = new ClientHandler(sessionStore, toolExecutor)
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) {
      process.env.WZXCLAW_CONFIG_DIR = origConfigDir
    } else {
      delete process.env.WZXCLAW_CONFIG_DIR
    }
    await fsp.rm(tmpConfigDir, { recursive: true, force: true })
  })

  // ---- 1. session:compact ----

  describe('session:compact 真实压缩', () => {
    it('消息少于 2 条时跳过压缩', async () => {
      ;(sessionStore.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue([
        { role: 'user', content: 'only one message', timestamp: Date.now() },
      ])

      const ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'session:compact', data: { sessionId: 's1' } }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:compacted'))

      const msg = ws._getSentMessages().find(m => m.event === 'session:compacted')!
      expect((msg.data as { skipped: boolean }).skipped).toBe(true)
      expect((msg.data as { beforeCount: number }).beforeCount).toBe(1)
      expect(sessionStore.replaceMessages).not.toHaveBeenCalled()
    })

    it('使用 maybeTimeBasedMicrocompact 压缩消息并保存', async () => {
      // 构造一条有多个旧工具结果的对话（时间戳在 2 小时前，满足 60 分钟阈值）
      // keepRecent 默认为 5，所以需要超过 5 个 compactable 工具调用才能触发清理
      const oldTimestamp = Date.now() - 120 * 60 * 1000
      const toolResults: Array<{ role: string; toolCallId: string; content: string; isError: boolean; timestamp: number }> = []
      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      for (let i = 0; i < 8; i++) {
        const tcId = `tc-${i}`
        toolCalls.push({ id: tcId, name: 'FileRead', input: { path: `/file-${i}` } })
        toolResults.push({ role: 'tool_result', toolCallId: tcId, content: `very long file content ${i} that should be cleared by microcompact to save tokens`, isError: false, timestamp: oldTimestamp + i * 100 })
      }
      const messages = [
        { role: 'user', content: 'read files', timestamp: oldTimestamp },
        { role: 'assistant', content: 'here they are', toolCalls, timestamp: oldTimestamp + 100 },
        ...toolResults,
        { role: 'assistant', content: 'result', toolCalls: [], timestamp: oldTimestamp + 1000 },
        { role: 'user', content: 'new message', timestamp: Date.now() },
      ]
      ;(sessionStore.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(messages)

      const ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'session:compact', data: { sessionId: 's1' } }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:compacted'))

      const msg = ws._getSentMessages().find(m => m.event === 'session:compacted')!
      const data = msg.data as { beforeCount: number; afterCount: number; clearedCount: number; charsSaved: number; trigger: string }

      // 应该执行了压缩
      // 总消息数: 1 user + 1 assistant(with tools) + 8 tool_results + 1 assistant + 1 user = 12
      expect(data.beforeCount).toBe(12)
      expect(data.afterCount).toBe(12) // 消息数量不变，只是 tool_result 内容被替换
      expect(data.clearedCount).toBeGreaterThanOrEqual(1) // 至少清理了 1 个工具结果
      expect(data.charsSaved).toBeGreaterThan(0)
      expect(data.trigger).toBe('time')

      // replaceMessages 应该被调用
      expect(sessionStore.replaceMessages).toHaveBeenCalledWith('s1', expect.any(Array))
    })

    it('没有 replaceMessages 方法时跳过压缩', async () => {
      // 创建没有 replaceMessages 的 store
      const storeWithoutReplace = {
        appendMessage: vi.fn(() => Promise.resolve()),
        loadSession: vi.fn(),
        listSessions: vi.fn(() => Promise.resolve([])),
        deleteSession: vi.fn(() => Promise.resolve()),
        renameSession: vi.fn(() => Promise.resolve()),
        getSessionConfig: vi.fn(() => Promise.resolve(null)),
        updateSessionConfig: vi.fn((id, patch) => Promise.resolve({ id, title: patch.title ?? 'Untitled', createdAt: 1000, updatedAt: 2000 })),
        // 注意：没有 replaceMessages
      } as unknown as ISessionStore
      const localHandler = new ClientHandler(storeWithoutReplace, toolExecutor)

      // 构造超过 keepRecent=5 的工具结果来触发压缩
      const oldTimestamp = Date.now() - 120 * 60 * 1000
      const toolResults: Array<{ role: string; toolCallId: string; content: string; isError: boolean; timestamp: number }> = []
      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      for (let i = 0; i < 8; i++) {
        const tcId = `tc-${i}`
        toolCalls.push({ id: tcId, name: 'FileRead', input: { path: `/file-${i}` } })
        toolResults.push({ role: 'tool_result', toolCallId: tcId, content: `file content ${i}`, isError: false, timestamp: oldTimestamp + i * 100 })
      }
      const messages = [
        { role: 'user', content: 'read files', timestamp: oldTimestamp },
        { role: 'assistant', content: 'here', toolCalls, timestamp: oldTimestamp + 100 },
        ...toolResults,
        { role: 'assistant', content: 'done', toolCalls: [], timestamp: oldTimestamp + 1000 },
        { role: 'user', content: 'next', timestamp: Date.now() },
      ]
      ;(storeWithoutReplace.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(messages)

      const ws = createMockWs()
      localHandler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'session:compact', data: { sessionId: 's1' } }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:compacted'))

      const msg = ws._getSentMessages().find(m => m.event === 'session:compacted')!
      expect((msg.data as { reason: string }).reason).toBe('no replaceMessages')
    })
  })

  // ---- 2. 费用追踪 ----

  describe('费用追踪 (usage:updated)', () => {
    it('agent:done 后发送 usage:updated 事件', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:done', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 }, turnCount: 1, model: 'deepseek-chat' },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      const ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's1', message: 'hi' } }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'usage:updated'))

      const msg = ws._getSentMessages().find(m => m.event === 'usage:updated')!
      const data = msg.data as { inputTokens: number; outputTokens: number; totalCostUSD: number; model: string }
      expect(data.inputTokens).toBe(100)
      expect(data.outputTokens).toBe(50)
      expect(data.totalCostUSD).toBeGreaterThan(0)
      expect(data.model).toBe('deepseek-chat')
    })

    it('切换会话时重置 CostTracker', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:done', usage: { inputTokens: 100, outputTokens: 50 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      const ws = createMockWs()
      handler.handleConnection(ws)

      // 第一次 chat:send 到 s1
      ws._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's1', message: 'hi' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'usage:updated'))

      const firstUsage = ws._getSentMessages().find(m => m.event === 'usage:updated')!
      expect((firstUsage.data as { inputTokens: number }).inputTokens).toBe(100)

      // 第二次 chat:send 到 s2（不同会话，应重置）
      ws._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's2', message: 'hello' } }))
      await pollUntil(() => {
        const msgs = ws._getSentMessages().filter(m => m.event === 'usage:updated')
        return msgs.length >= 2
      })

      const allUsageMsgs = ws._getSentMessages().filter(m => m.event === 'usage:updated')
      const secondUsage = allUsageMsgs[1]
      // 重置后应该从 0 重新累计
      expect((secondUsage.data as { inputTokens: number }).inputTokens).toBe(100)
    })
  })

  // ---- 3. 运行状态广播 ----

  describe('运行状态广播 (session:running)', () => {
    it('chat:send 广播 session:running 给所有已连接客户端', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      // 创建两个客户端连接
      const wsA = createMockWs()
      const wsB = createMockWs()
      handler.handleConnection(wsA)
      handler.handleConnection(wsB)

      // wsA 发送 chat:send
      wsA._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's1', message: 'hi' } }))

      // 等待两个客户端都收到 session:running
      await pollUntil(() => wsA._getSentMessages().some(m => m.event === 'session:running'))
      await pollUntil(() => wsB._getSentMessages().some(m => m.event === 'session:running'))

      // wsB 也应该收到 session:running 广播（虽然不是发起者）
      const wsBRunningMsgs = wsB._getSentMessages().filter(m => m.event === 'session:running')
      expect(wsBRunningMsgs.length).toBeGreaterThanOrEqual(1)

      // 验证广播内容
      const runningMsg = wsBRunningMsgs[0]
      expect((runningMsg.data as { sessionId: string; status: string })).toEqual({
        sessionId: 's1',
        status: 'running',
      })
    })

    it('完成后广播 idle 状态', async () => {
      const events: AgentEvent[] = [
        { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 },
      ]
      const mockLoop = createMockAgentLoop(events)
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      const ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's1', message: 'hi' } }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'usage:updated'))

      const runningMsgs = ws._getSentMessages().filter(m => m.event === 'session:running')
      const statuses = runningMsgs.map(m => (m.data as { status: string }).status)

      expect(statuses).toContain('running')
      expect(statuses).toContain('idle')
    })
  })

  // ---- 4. Host 操作 ----

  describe('Host 操作（通过 Hand tool executor）', () => {
    let ws: ReturnType<typeof createMockWs>

    beforeEach(() => {
      ws = createMockWs()
      handler.handleConnection(ws)
    })

    it('host:test-connection → 调用 ShellExecute echo', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'ok', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:test-connection', data: { hostId: 'h1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:test-connection'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'echo ok' }, expect.objectContaining({ targetHandId: 'h1' }))
      const msg = ws._getSentMessages().find(m => m.event === 'host:test-connection')!
      expect((msg.data as { success: boolean }).success).toBe(true)
    })

    it('host:exec → 调用 ShellExecute', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'result', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:exec', data: { hostId: 'h1', command: 'ls -la' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:exec'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'ls -la' }, expect.objectContaining({ targetHandId: 'h1' }))
      const msg = ws._getSentMessages().find(m => m.event === 'host:exec')!
      expect((msg.data as { output: string }).output).toBe('result')
    })

    it('host:monitor → 返回 stub 数据', async () => {
      ws._emit('message', JSON.stringify({ event: 'host:monitor', data: { hostId: 'h1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:monitor'))

      const msg = ws._getSentMessages().find(m => m.event === 'host:monitor')!
      const data = msg.data as { cpu: number; memory: number; disk: number; note: string }
      expect(data.cpu).toBe(0)
      expect(data.memory).toBe(0)
      expect(data.disk).toBe(0)
      expect(data.note).toContain('stub')
    })

    it('host:sftp:list → 调用 FileList', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: '[{"name":"a.txt"}]', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:sftp:list', data: { hostId: 'h1', path: '/data' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:sftp:list'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('FileList', { path: '/data' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:sftp:read → 调用 FileRead', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'file content', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:sftp:read', data: { hostId: 'h1', path: '/data/a.txt' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:sftp:read'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('FileRead', { path: '/data/a.txt' }, expect.objectContaining({ targetHandId: 'h1' }))
      const msg = ws._getSentMessages().find(m => m.event === 'host:sftp:read')!
      expect((msg.data as { content: string }).content).toBe('file content')
    })

    it('host:docker:list → 调用 ShellExecute docker ps', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: '{"ID":"abc"}', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:docker:list', data: { hostId: 'h1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:list'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'docker ps --format json' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:docker:logs → 调用 ShellExecute docker logs', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'log line 1', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:docker:logs', data: { hostId: 'h1', containerId: 'c123', tail: 50 } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:logs'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'docker logs --tail 50 "c123"' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:docker:action → 执行 docker 操作', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'ok', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:docker:action', data: { hostId: 'h1', containerId: 'c123', action: 'restart' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:action'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'docker restart "c123"' }, expect.objectContaining({ targetHandId: 'h1' }))
      const msg = ws._getSentMessages().find(m => m.event === 'host:docker:action')!
      expect((msg.data as { success: boolean }).success).toBe(true)
    })

    it('host:docker:action → 拒绝无效操作', async () => {
      ws._emit('message', JSON.stringify({ event: 'host:docker:action', data: { hostId: 'h1', containerId: 'c123', action: 'explode' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:action'))

      const msg = ws._getSentMessages().find(m => m.event === 'host:docker:action')!
      expect((msg.data as { error: string }).error).toContain('Invalid action')
    })

    it('host:docker:stats → 调用 ShellExecute docker stats', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: 'stats output', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:docker:stats', data: { hostId: 'h1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:stats'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'docker stats --no-stream' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:docker:images → 调用 ShellExecute docker images', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: '{}', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:docker:images', data: { hostId: 'h1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:docker:images'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'docker images --format json' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:sftp:mkdir → 调用 ShellExecute mkdir -p', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: '', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:sftp:mkdir', data: { hostId: 'h1', path: '/data/newdir' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:sftp:mkdir'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'mkdir -p "/data/newdir"' }, expect.objectContaining({ targetHandId: 'h1' }))
    })

    it('host:sftp:delete → 调用 ShellExecute rm -rf', async () => {
      ;(toolExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ output: '', isError: false })

      ws._emit('message', JSON.stringify({ event: 'host:sftp:delete', data: { hostId: 'h1', path: '/data/old' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:sftp:delete'))

      expect(toolExecutor.execute).toHaveBeenCalledWith('ShellExecute', { command: 'rm -rf "/data/old"' }, expect.objectContaining({ targetHandId: 'h1' }))
    })
  })

  // ---- 5. Indexing Status Enhancement ----

  describe('Indexing Status 增强', () => {
    it('indexedFiles 返回 -1 表示文件数未知', async () => {
      const ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({ event: 'indexing:status' }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'indexing:status'))

      const msg = ws._getSentMessages().find(m => m.event === 'indexing:status')!
      expect((msg.data as { indexedFiles: number }).indexedFiles).toBe(-1)
    })
  })
})
