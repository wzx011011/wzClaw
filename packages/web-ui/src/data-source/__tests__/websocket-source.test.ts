// ============================================================
// WebSocketDataSource 单元测试
//
// 使用 FakeWebSocket 模拟 WebSocket 行为，测试：
// 1. 连接建立 + onConnectionChange 回调
// 2. chat:send 发送 + stream:text 事件接收
// 3. 断线后指数退避重连
// 4. session:list 发送请求并解析响应
// 5. DataSource 接口类型检查（TypeScript 编译期验证）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketDataSource } from '../websocket-source'

// ---- FakeWebSocket 模拟 ----

/** 模拟 WebSocket 实例，用于测试 */
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

  /** 记录所有发送的消息 */
  sentMessages: string[] = []

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
  }

  /** 模拟连接建立 */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** 模拟收到消息 */
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }

  /** 模拟连接关闭 */
  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  /** 模拟连接错误 */
  simulateError(): void {
    this.onerror?.(new Event('error'))
  }

  /** 发送消息（记录到 sentMessages） */
  send(data: string): void {
    this.sentMessages.push(data)
  }

  /** 关闭连接 */
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}

// ---- 测试辅助 ----

let fakeWs: FakeWebSocket

// 拦截 new WebSocket()
const OriginalWebSocket = globalThis.WebSocket

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

// ---- 测试 ----

describe('WebSocketDataSource', () => {
  beforeEach(() => {
    mockWebSocket()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    restoreWebSocket()
  })

  it('连接 ws server 后调用 onConnectionChange(true)', async () => {
    const source = new WebSocketDataSource('ws://localhost:8082')
    const onConnectionChange = vi.fn()
    source.onConnectionChange(onConnectionChange)

    // 发起连接
    const connectPromise = source.connect()

    // 模拟 WebSocket open
    fakeWs.simulateOpen()
    await connectPromise

    expect(source.isConnected()).toBe(true)
    expect(onConnectionChange).toHaveBeenCalledWith(true)
  })

  it('发送 chat:send 并收到 stream:text 事件', async () => {
    const source = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = source.connect()
    fakeWs.simulateOpen()
    await connectPromise

    // 订阅 stream:text 事件
    const onText = vi.fn()
    source.onStreamEvent('text', onText)

    // 发送消息
    await source.sendMessage('session-1', '你好')

    // 验证发送的消息格式
    expect(fakeWs.sentMessages).toHaveLength(1)
    const sent = JSON.parse(fakeWs.sentMessages[0]!)
    expect(sent).toEqual({
      event: 'chat:send',
      data: { sessionId: 'session-1', message: '你好' },
    })

    // 模拟收到 stream:text 事件
    fakeWs.simulateMessage({
      event: 'stream:text',
      data: { delta: '你好！' },
    })

    expect(onText).toHaveBeenCalledWith({ delta: '你好！' })
  })

  it('断线后指数退避重连', async () => {
    const source = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = source.connect()
    fakeWs.simulateOpen()
    await connectPromise

    const onConnectionChange = vi.fn()
    source.onConnectionChange(onConnectionChange)

    // 模拟断线
    fakeWs.simulateClose()
    expect(source.isConnected()).toBe(false)
    expect(onConnectionChange).toHaveBeenCalledWith(false)

    // 第一次重连：1s 后
    vi.advanceTimersByTime(1000)
    // 新的 FakeWebSocket 已创建，模拟 open
    fakeWs.simulateOpen()

    expect(source.isConnected()).toBe(true)
    expect(onConnectionChange).toHaveBeenCalledWith(true)
  })

  it('session:list 发送请求并解析响应', async () => {
    const source = new WebSocketDataSource('ws://localhost:8082')
    const connectPromise = source.connect()
    fakeWs.simulateOpen()
    await connectPromise

    // 发起 session:list 请求
    const listPromise = source.listSessions()

    // 验证发送了正确格式的消息
    expect(fakeWs.sentMessages).toHaveLength(1)
    const sent = JSON.parse(fakeWs.sentMessages[0]!)
    expect(sent.event).toBe('session:list')

    // 模拟服务器响应
    fakeWs.simulateMessage({
      event: 'session:list',
      data: {
        sessions: [
          { id: 's1', title: '测试会话', createdAt: 1000, updatedAt: 2000, messageCount: 5 },
        ],
      },
    })

    const sessions = await listPromise
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('s1')
    expect(sessions[0]!.title).toBe('测试会话')
  })

  it('DataSource 接口类型检查 — WebSocketDataSource implements DataSource', () => {
    // 编译期类型检查：WebSocketDataSource 必须实现 DataSource 所有方法
    const source: import('../types').DataSource = new WebSocketDataSource('ws://localhost:8082')

    // 验证所有必需方法存在
    expect(typeof source.connect).toBe('function')
    expect(typeof source.disconnect).toBe('function')
    expect(typeof source.isConnected).toBe('function')
    expect(typeof source.onConnectionChange).toBe('function')
    expect(typeof source.sendMessage).toBe('function')
    expect(typeof source.stopGeneration).toBe('function')
    expect(typeof source.onStreamEvent).toBe('function')
    expect(typeof source.listSessions).toBe('function')
    expect(typeof source.loadSession).toBe('function')
    expect(typeof source.createSession).toBe('function')
    expect(typeof source.deleteSession).toBe('function')
    expect(typeof source.renameSession).toBe('function')
    expect(typeof source.getSettings).toBe('function')
    expect(typeof source.updateSettings).toBe('function')
  })

  // ---- IDE 通道测试 ----

  describe('FsChannel', () => {
    it('readFile 发送 fs:readFile 请求并解析响应', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const readPromise = source.fs!.readFile('/path/to/file.ts')

      // 验证发送了请求
      const sent = JSON.parse(fakeWs.sentMessages[fakeWs.sentMessages.length - 1]!)
      expect(sent.event).toBe('fs:readFile')
      expect(sent.data).toEqual({ path: '/path/to/file.ts' })

      // 模拟响应
      fakeWs.simulateMessage({
        event: 'fs:readFile:result',
        data: { content: 'file content here' },
      })

      const result = await readPromise
      expect(result.content).toBe('file content here')
    })

    it('tree 发送 fs:tree 请求并解析响应', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const nodes = [{ name: 'src', path: '/src', type: 'directory' as const }]
      const treePromise = source.fs!.tree('/project', 2)

      // 模拟响应
      fakeWs.simulateMessage({
        event: 'fs:tree:result',
        data: { nodes },
      })

      const result = await treePromise
      expect(result).toEqual(nodes)
    })
  })

  describe('TerminalChannel', () => {
    it('spawn 发送 terminal:spawn 请求', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const spawnPromise = source.terminal!.spawn({ shell: '/bin/bash', cwd: '/home' })

      // 模拟响应
      fakeWs.simulateMessage({
        event: 'terminal:spawned',
        data: { terminalId: 'term-1' },
      })

      const terminalId = await spawnPromise
      expect(terminalId).toBe('term-1')
    })

    it('onData 接收 terminal:data 事件', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const onData = vi.fn()
      source.terminal!.onData('term-1', onData)

      // 模拟收到 terminal 数据
      fakeWs.simulateMessage({
        event: 'terminal:data',
        data: { terminalId: 'term-1', data: 'output line\n' },
      })

      expect(onData).toHaveBeenCalledWith('output line\n')
    })

    it('onExit 接收 terminal:exit 事件', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const onExit = vi.fn()
      source.terminal!.onExit('term-1', onExit)

      // 模拟终端退出
      fakeWs.simulateMessage({
        event: 'terminal:exit',
        data: { terminalId: 'term-1', exitCode: 0 },
      })

      expect(onExit).toHaveBeenCalledWith(0)
    })

    it('write 发送 terminal:write 消息', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      await source.terminal!.write('term-1', 'ls -la\n')

      const sent = JSON.parse(fakeWs.sentMessages[fakeWs.sentMessages.length - 1]!)
      expect(sent.event).toBe('terminal:write')
      expect(sent.data).toEqual({ terminalId: 'term-1', data: 'ls -la\n' })
    })
  })

  describe('PreviewChannel', () => {
    it('open 设置 URL 并通知监听器', async () => {
      const source = new WebSocketDataSource('ws://localhost:8082')
      const connectPromise = source.connect()
      fakeWs.simulateOpen()
      await connectPromise

      const onUrlChange = vi.fn()
      source.preview!.onUrlChange(onUrlChange)

      await source.preview!.open('http://localhost:3000')

      expect(source.preview!.getUrl()).toBe('http://localhost:3000')
      expect(onUrlChange).toHaveBeenCalledWith('http://localhost:3000')
    })
  })
})
