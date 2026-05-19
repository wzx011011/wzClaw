// ============================================================
// hand-aware-tool-executor.test.ts — HandAwareToolExecutor 单元测试
// 验证工具调用路由、超时、断连、isReadOnly 等行为
// ============================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { HandAwareToolExecutor } from './hand-aware-tool-executor.js'
import { HandsRouter } from './hands-router.js'
import type { HandEntry } from './hands-router.js'

// ---- 测试辅助 ----

/** 创建 mock WebSocket 对象，记录发送的消息 */
function mockWs(): any {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  }
}

/** 创建 HandEntry */
function makeHand(overrides: Partial<HandEntry> & { id: string }): HandEntry {
  return {
    ws: mockWs(),
    id: overrides.id,
    capabilities: overrides.capabilities ?? [],
    definitions: overrides.definitions ?? [],
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
    priority: overrides.priority ?? 0,
  }
}

/** 从 mock WebSocket 的 send 调用中提取最后发送的 JSON 消息 */
function getLastSentMessage(ws: any): any {
  const calls = ws.send.mock.calls
  if (calls.length === 0) return null
  return JSON.parse(calls[calls.length - 1][0])
}

// ---- 测试 ----

describe('HandAwareToolExecutor', () => {
  let router: HandsRouter
  let executor: HandAwareToolExecutor

  beforeEach(() => {
    vi.useFakeTimers()
    router = new HandsRouter()
    executor = new HandAwareToolExecutor(router)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getDefinitions', () => {
    it('返回 HandsRouter 聚合的所有工具定义', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead', 'FileWrite'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: { type: 'object' }, isReadOnly: true },
          { name: 'FileWrite', description: '写入文件', inputSchema: { type: 'object' }, isReadOnly: false },
        ],
      })
      router.register(hand)

      const defs = executor.getDefinitions()
      expect(defs).toHaveLength(2)
      expect(defs.map(d => d.name)).toContain('FileRead')
      expect(defs.map(d => d.name)).toContain('FileWrite')
    })

    it('无 Hand 时返回空数组', () => {
      expect(executor.getDefinitions()).toEqual([])
    })
  })

  describe('execute', () => {
    it('找到注册 FileRead 的 Hand，发送 hand:execute 并等待 result', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      // 启动 execute
      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      // 验证发送了 hand:execute
      const sent = getLastSentMessage(hand.ws)
      expect(sent.event).toBe('hand:execute')
      expect(sent.data.name).toBe('FileRead')
      expect(sent.data.input).toEqual({ path: '/a.ts' })
      expect(sent.data.callId).toBeDefined()

      // 模拟 Hand 返回结果
      executor.handleResult(sent.data.callId, 'file content here', false)

      const result = await promise
      expect(result.output).toBe('file content here')
      expect(result.isError).toBe(false)
    })

    it('targetHandId 通过执行上下文按会话隔离传递', async () => {
      const hand1 = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [{ name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true }],
      })
      const hand2 = makeHand({
        id: 'h2',
        capabilities: ['FileRead'],
        definitions: [{ name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true }],
      })
      router.register(hand1)
      router.register(hand2)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], targetHandId: 'h2', abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      expect(hand1.ws.send).not.toHaveBeenCalled()
      expect(hand2.ws.send).toHaveBeenCalled()

      const sent = getLastSentMessage(hand2.ws)
      executor.handleResult(sent.data.callId, 'ok', false)
      await expect(promise).resolves.toEqual({ output: 'ok', isError: false })
    })

    it('默认阻止非只读远程工具执行', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileWrite'],
        definitions: [{ name: 'FileWrite', description: '写文件', inputSchema: {}, isReadOnly: false }],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const result = await executor.execute('FileWrite', { path: '/a.ts', content: 'x' }, ctx)

      expect(result.isError).toBe(true)
      expect(result.output).toContain('blocked by policy')
      expect(hand.ws.send).not.toHaveBeenCalled()
    })

    it('工具不存在时返回错误结果', async () => {
      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const result = await executor.execute('不存在', { path: '/a.ts' }, ctx)

      expect(result.output).toBe('No hand available for tool: 不存在')
      expect(result.isError).toBe(true)
    })

    it('Hand 超时（30s）未返回结果时返回超时错误', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      // 推进 31s
      vi.advanceTimersByTime(31_000)

      const result = await promise
      expect(result.output).toBe('Tool execution timed out')
      expect(result.isError).toBe(true)
    })

    it('Hand 在执行中断开连接时返回错误', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      // 模拟 Hand 断开
      executor.handleHandDisconnect('h1')

      const result = await promise
      expect(result.output).toBe('Hand disconnected during execution')
      expect(result.isError).toBe(true)
    })

    it('execute 发送的消息包含 context 信息', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project', '/lib'], abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      const sent = getLastSentMessage(hand.ws)
      expect(sent.data.context.workingDirectory).toBe('/project')
      expect(sent.data.context.projectRoots).toEqual(['/project', '/lib'])

      // 清理 pending
      executor.handleResult(sent.data.callId, '', false)
      await promise
    })

    it('Hand 返回 isError=true 时透传错误', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const promise = executor.execute('FileRead', { path: '/a.ts' }, ctx)

      const sent = getLastSentMessage(hand.ws)
      executor.handleResult(sent.data.callId, 'Permission denied', true)

      const result = await promise
      expect(result.output).toBe('Permission denied')
      expect(result.isError).toBe(true)
    })
  })

  describe('isReadOnly', () => {
    it('从 Hand 定义中读取 isReadOnly=true', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      expect(executor.isReadOnly('FileRead')).toBe(true)
    })

    it('从 Hand 定义中读取 isReadOnly=false', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileWrite'],
        definitions: [
          { name: 'FileWrite', description: '写入文件', inputSchema: {}, isReadOnly: false },
        ],
      })
      router.register(hand)

      expect(executor.isReadOnly('FileWrite')).toBe(false)
    })

    it('未知工具 isReadOnly 返回 false（保守策略）', () => {
      expect(executor.isReadOnly('UnknownTool')).toBe(false)
    })

    it('定义中未指定 isReadOnly 时默认为 false', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['Bash'],
        definitions: [
          { name: 'Bash', description: '执行命令', inputSchema: {} },
        ],
      })
      router.register(hand)

      expect(executor.isReadOnly('Bash')).toBe(false)
    })
  })

  describe('handleResult', () => {
    it('未知的 callId 被忽略（不抛异常）', () => {
      // 不应有任何副作用
      executor.handleResult('unknown-call-id', 'result', false)
    })
  })

  describe('handleHandDisconnect', () => {
    it('清理该 Hand 所有 pending calls', async () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead', 'FileList'],
        definitions: [
          { name: 'FileRead', description: '读取', inputSchema: {}, isReadOnly: true },
          { name: 'FileList', description: '列目录', inputSchema: {}, isReadOnly: true },
        ],
      })
      router.register(hand)

      const ctx = { workingDirectory: '/project', projectRoots: ['/project'], abortSignal: new AbortController().signal }
      const promise1 = executor.execute('FileRead', { path: '/a.ts' }, ctx)
      const promise2 = executor.execute('FileList', { path: '/project' }, ctx)

      // 模拟 Hand 断开
      executor.handleHandDisconnect('h1')

      const [result1, result2] = await Promise.all([promise1, promise2])
      expect(result1.isError).toBe(true)
      expect(result1.output).toBe('Hand disconnected during execution')
      expect(result2.isError).toBe(true)
      expect(result2.output).toBe('Hand disconnected during execution')
    })

    it('断开不存在的 handId 无副作用', () => {
      executor.handleHandDisconnect('不存在') // 不抛异常
    })
  })
})
