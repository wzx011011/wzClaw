// ============================================================
// client-handler.ts 测试 — 客户端连接处理 + AgentLoop 桥接
// mock AgentLoop、SessionStore、WebSocket，验证协议映射
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent, AgentConfig } from '@wzxclaw/brain'
import type { ISessionStore, IEventSender, IToolExecutor } from '@wzxclaw/brain'
import type { WebSocket } from 'ws'
import { ClientHandler } from './client-handler.js'
import type { WorkspaceService } from './workspace-service.js'
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
    renameSession: vi.fn(() => Promise.resolve()),
    createSession: vi.fn((config) => Promise.resolve({
      id: config.id,
      title: config.title ?? 'Untitled',
      createdAt: 1000,
      updatedAt: 1000,
      owner: config.owner ?? 'nas-remote',
      targetHandId: config.targetHandId,
      model: config.model,
      provider: config.provider,
    })),
    getSessionConfig: vi.fn(() => Promise.resolve(null)),
    updateSessionConfig: vi.fn((sessionId, patch) => Promise.resolve({
      id: sessionId,
      title: patch.title ?? 'Untitled',
      createdAt: 1000,
      updatedAt: 2000,
      owner: patch.owner ?? 'nas-remote',
      targetHandId: patch.targetHandId,
      model: patch.model,
      provider: patch.provider,
    })),
  }
}

function createMockWorkspaceService(): Pick<WorkspaceService, 'listWorkspaces' | 'getWorkspace' | 'createWorkspace' | 'updateWorkspace' | 'deleteWorkspace' | 'addProject' | 'removeProject' | 'getSessionDefaults'> {
  const workspace = {
    id: 'w1',
    title: '工作区',
    projects: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  }
  return {
    listWorkspaces: vi.fn(() => Promise.resolve([workspace])),
    getWorkspace: vi.fn(() => Promise.resolve(workspace)),
    createWorkspace: vi.fn(() => Promise.resolve(workspace)),
    updateWorkspace: vi.fn(() => Promise.resolve({ ...workspace, title: '新标题', updatedAt: 2 })),
    deleteWorkspace: vi.fn(() => Promise.resolve()),
    addProject: vi.fn(() => Promise.resolve({
      ...workspace,
      projects: [{ id: 'p1', path: '/repo/app', name: 'app', addedAt: 2 }],
      updatedAt: 2,
    })),
    removeProject: vi.fn(() => Promise.resolve(workspace)),
    getSessionDefaults: vi.fn(() => Promise.resolve({ workingDirectory: '/repo/app', projectRoots: ['/repo/app'] })),
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
  let workspaceService: ReturnType<typeof createMockWorkspaceService>
  let ws: ReturnType<typeof createMockWs>
  let tmpConfigDir: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    tmpConfigDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-test-'))
    origConfigDir = process.env.WZXCLAW_CONFIG_DIR
    process.env.WZXCLAW_CONFIG_DIR = tmpConfigDir
    sessionStore = createMockSessionStore()
    workspaceService = createMockWorkspaceService()
    handler = new ClientHandler(sessionStore, {
      execute: vi.fn(() => Promise.resolve({ output: '', isError: false })),
      getDefinitions: vi.fn(() => [
        { name: 'FileRead', description: 'Read file', inputSchema: {} },
        { name: 'FileList', description: 'List dir', inputSchema: {} },
        { name: 'ShellExecute', description: 'Run shell', inputSchema: {} },
        { name: 'Grep', description: 'Search files', inputSchema: {} },
        { name: 'Glob', description: 'Find files', inputSchema: {} },
      ]),
      isReadOnly: vi.fn(() => false),
    } as unknown as IToolExecutor, workspaceService as WorkspaceService)
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) {
      process.env.WZXCLAW_CONFIG_DIR = origConfigDir
    } else {
      delete process.env.WZXCLAW_CONFIG_DIR
    }
    await fsp.rm(tmpConfigDir, { recursive: true, force: true })
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

      // 等待异步 handleChatSend 完成（现在还会发送 session:running + usage:updated）
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

      const msgs = ws._getSentMessages()
      const textMsg = msgs.find(m => m.event === 'stream:text')
      expect(textMsg).toBeDefined()
      expect(textMsg!.data).toEqual({ delta: 'Hello' })

      const doneMsg = msgs.find(m => m.event === 'stream:done')
      expect(doneMsg).toBeDefined()
      expect(doneMsg!.data).toEqual({ usage: { inputTokens: 10, outputTokens: 5 }, turnCount: 1 })

      // 验证 usage:updated 事件
      const usageMsg = msgs.find(m => m.event === 'usage:updated')
      expect(usageMsg).toBeDefined()
      expect((usageMsg!.data as { inputTokens: number }).inputTokens).toBe(10)
      expect((usageMsg!.data as { outputTokens: number }).outputTokens).toBe(5)
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

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

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

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

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

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

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

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

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

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done'))

      const msgs = ws._getSentMessages()
      const compactMsg = msgs.find(m => m.event === 'stream:compacted')
      expect(compactMsg).toBeDefined()
      expect(compactMsg!.data).toEqual({ beforeTokens: 10000, afterTokens: 3000, auto: true })
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
      expect(listMsg!.data).toEqual({ sessions: sessions.map(session => ({ ...session, isRunning: false })) })
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
      expect(sessionStore.createSession).toHaveBeenCalled()
    })

    it('workspace:create/list/add-project → 通过 workspace service 返回结果', async () => {
      ws._emit('message', JSON.stringify({ event: 'workspace:create', data: { title: '工作区' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'workspace:created'))
      expect(workspaceService.createWorkspace).toHaveBeenCalledWith({ title: '工作区' })

      ws._emit('message', JSON.stringify({ event: 'workspace:list', data: { includeArchived: true } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'workspace:list'))
      expect(workspaceService.listWorkspaces).toHaveBeenCalledWith(true)

      ws._emit('message', JSON.stringify({ event: 'workspace:add-project', data: { workspaceId: 'w1', folderPath: '/repo/app' } }))
      await pollUntil(() => ws._getSentMessages().filter(m => m.event === 'workspace:updated').length >= 1)
      expect(workspaceService.addProject).toHaveBeenCalledWith('w1', '/repo/app')
    })

    it('capabilities:get → 返回当前服务端能力', async () => {
      ws._emit('message', JSON.stringify({ event: 'capabilities:get' }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'capabilities'))

      const msg = ws._getSentMessages().find(m => m.event === 'capabilities')!
      expect(msg.data).toMatchObject({
        workspace: true,
        fs: true,
        terminal: true,
        tools: true,
        hosts: true,
        plugins: true,
        indexing: true,
        insights: true,
      })
    })

    it('session:config:update/get → 持久化并读取会话配置', async () => {
      ws._emit('message', JSON.stringify({
        event: 'session:config:update',
        data: { sessionId: 's1', patch: { targetHandId: 'desktop-hand-1', model: 'glm-5.1' } },
      }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:config:updated'))

      expect(sessionStore.updateSessionConfig).toHaveBeenCalledWith('s1', { targetHandId: 'desktop-hand-1', model: 'glm-5.1' })
      const updated = ws._getSentMessages().find(m => m.event === 'session:config:updated')!
      expect((updated.data as { config: { targetHandId?: string } }).config.targetHandId).toBe('desktop-hand-1')
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

    it('session:rename → 持久化会话标题', async () => {
      ws._emit('message', JSON.stringify({
        event: 'session:rename',
        data: { sessionId: 's1', title: '新标题' },
      }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:renamed'))

      expect(sessionStore.renameSession).toHaveBeenCalledWith('s1', '新标题')
      const msgs = ws._getSentMessages()
      expect(msgs.find(m => m.event === 'session:renamed')!.data).toEqual({ sessionId: 's1', title: '新标题' })
    })

    it('permission:get → 返回默认 always-ask 模式', async () => {
      ws._emit('message', JSON.stringify({ event: 'permission:get' }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'permission:mode'))
      const msg = ws._getSentMessages().find(m => m.event === 'permission:mode')!
      expect(msg.data).toEqual({ mode: 'always-ask' })
    })

    it('permission:set → 更新权限模式', async () => {
      ws._emit('message', JSON.stringify({ event: 'permission:set', data: { mode: 'plan' } }))
      await pollUntil(() => ws._getSentMessages().filter(m => m.event === 'permission:mode').length >= 1)
      const msg = ws._getSentMessages().find(m => m.event === 'permission:mode')!
      expect(msg.data).toEqual({ mode: 'plan' })
    })

    it('permission:set → 拒绝无效模式', async () => {
      ws._emit('message', JSON.stringify({ event: 'permission:set', data: { mode: 'invalid' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'error'))
      const msg = ws._getSentMessages().find(m => m.event === 'error')!
      expect((msg.data as { message: string }).message).toContain('Invalid')
    })

    it('session:export → 返回会话消息和配置', async () => {
      ws._emit('message', JSON.stringify({ event: 'session:export', data: { sessionId: 's1' } }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'session:exported'))
      const msg = ws._getSentMessages().find(m => m.event === 'session:exported')!
      expect(msg.data).toMatchObject({ sessionId: 's1' })
    })
  })

  describe('AgentLoop 生命周期', () => {
    it('chat:send 使用 session config 中的 targetHandId', async () => {
      ;(sessionStore.getSessionConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        title: '会话',
        createdAt: 1000,
        updatedAt: 1000,
        owner: 'nas-remote',
        targetHandId: 'desktop-hand-1',
        model: 'glm-5.1',
      })
      const mockLoop = createMockAgentLoop([
        { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 },
      ])
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({
        event: 'chat:send',
        data: { sessionId: 's1', message: 'hi' },
      }))

      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done') && ws._getSentMessages().some(m => m.event === 'usage:updated'))

      const runCall = mockLoop.run.mock.calls[0]
      expect(runCall![1].targetHandId).toBe('desktop-hand-1')
      expect(runCall![1].model).toBe('glm-5.1')
    })

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

      // 等待第二个 loop 完成（stream:done 出现即可）
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:text' && (m.data as { delta: string }).delta === 'second'))

      expect(cancelFn).toHaveBeenCalled()

      // 解除挂起
      resolveFirst()
    })

    it('不同客户端的 chat:stop 不会取消其他客户端的 AgentLoop', async () => {
      let resolveFirst: () => void = () => {}
      const firstBlock = new Promise<void>(r => { resolveFirst = r })
      const firstLoop = {
        run: vi.fn(async function* (): AsyncGenerator<AgentEvent, void, unknown> {
          yield { type: 'agent:text', content: 'client-a' }
          await firstBlock
          yield { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 }
        }),
        cancel: vi.fn(),
        getMessages: vi.fn(() => []),
        replaceMessages: vi.fn(),
      }
      const secondLoop = createMockAgentLoop([
        { type: 'agent:text', content: 'client-b' },
        { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 },
      ])

      let callCount = 0
      handler.setLoopFactory(() => {
        callCount++
        return (callCount === 1 ? firstLoop : secondLoop) as unknown as ReturnType<typeof createMockAgentLoop>
      })

      const wsA = createMockWs()
      const wsB = createMockWs()
      handler.handleConnection(wsA)
      handler.handleConnection(wsB)

      wsA._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 'a', message: 'first' } }))
      await pollUntil(() => wsA._sent.length > 0)

      wsB._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 'b', message: 'second' } }))
      await pollUntil(() => wsB._sent.length >= 2)

      wsB._emit('message', JSON.stringify({ event: 'chat:stop', data: { sessionId: 'b' } }))

      expect(firstLoop.cancel).not.toHaveBeenCalled()
      resolveFirst()
    })

    it('持久化时只追加本轮新增消息，不重复历史消息', async () => {
      const history = [{ role: 'user', content: 'old' }]
      ;(sessionStore.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(history)
      const mockLoop = createMockAgentLoop([
        { type: 'agent:done', usage: { inputTokens: 1, outputTokens: 1 }, turnCount: 1 },
      ])
      mockLoop.getMessages.mockReturnValue([
        ...history,
        { role: 'user', content: 'new' },
        { role: 'assistant', content: 'reply' },
      ])
      handler.setLoopFactory(() => mockLoop as unknown as ReturnType<typeof createMockAgentLoop>)

      ws = createMockWs()
      handler.handleConnection(ws)
      ws._emit('message', JSON.stringify({ event: 'chat:send', data: { sessionId: 's1', message: 'new' } }))

      // 等待 stream:done + usage:updated（确保完整生命周期结束）
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'stream:done') && ws._getSentMessages().some(m => m.event === 'usage:updated'))

      expect(sessionStore.appendMessage).toHaveBeenCalledTimes(2)
      expect(sessionStore.appendMessage).toHaveBeenNthCalledWith(1, 's1', { role: 'user', content: 'new' })
      expect(sessionStore.appendMessage).toHaveBeenNthCalledWith(2, 's1', { role: 'assistant', content: 'reply' })
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

  describe('Host CRUD', () => {
    it('host:list → 返回空列表', async () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({ event: 'host:list', data: {} }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:list'))

      const msg = ws._getSentMessages().find(m => m.event === 'host:list')!
      expect((msg.data as { hosts: unknown[] }).hosts).toEqual([])
    })

    it('host:create + host:list → 创建后可列出', async () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({
        event: 'host:create',
        data: { name: 'nas', address: '192.168.1.100', port: 22, username: 'root', authType: 'key' },
      }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'host:created'))

      const created = ws._getSentMessages().find(m => m.event === 'host:created')!
      const host = (created.data as { host: { id: string; name: string } }).host
      expect(host.name).toBe('nas')
      expect(host.id).toBeTruthy()
    })
  })

  describe('Plugin / Indexing / Insights', () => {
    it('plugin:list → 返回空列表', async () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({ event: 'plugin:list', data: {} }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'plugin:list'))

      const msg = ws._getSentMessages().find(m => m.event === 'plugin:list')!
      expect((msg.data as { plugins: unknown[] }).plugins).toEqual([])
    })

    it('indexing:status → 返回可用状态', async () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({ event: 'indexing:status', data: {} }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'indexing:status'))

      const msg = ws._getSentMessages().find(m => m.event === 'indexing:status')!
      expect((msg.data as { available: boolean }).available).toBe(true)
      expect((msg.data as { backend: string }).backend).toBe('hand-tools')
    })

    it('insights:status → 返回状态', async () => {
      ws = createMockWs()
      handler.handleConnection(ws)

      ws._emit('message', JSON.stringify({ event: 'insights:status', data: {} }))
      await pollUntil(() => ws._getSentMessages().some(m => m.event === 'insights:status'))

      const msg = ws._getSentMessages().find(m => m.event === 'insights:status')!
      expect((msg.data as { available: boolean }).available).toBe(true)
    })
  })
})
