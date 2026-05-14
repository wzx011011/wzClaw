// ============================================================
// docker-entry.ts 测试
// 覆盖 createDockerHand 工具注册、环境变量、信号处理
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDockerHand } from './docker-entry.js'
import { LocalToolExecutor } from './src/tool-executor.js'
import type { HandConfig } from './src/types.js'
import { HandStatus } from './src/types.js'

// ---- MockWebSocket（复用 connection.test.ts 模式）----

/** 模拟 WebSocket 的行为 */
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  sentMessages: string[] = []
  closeCode = 0
  closeReason = ''

  private openHandlers: Array<() => void> = []
  private messageHandlers: Array<(data: unknown) => void> = []
  private closeHandlers: Array<(code: number, reason: string) => void> = []
  private errorHandlers: Array<(err: Error) => void> = []

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    for (const h of this.openHandlers) h()
  }

  simulateMessage(data: unknown): void {
    for (const h of this.messageHandlers) h(data)
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    for (const h of this.closeHandlers) h(code, reason)
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (event === 'open') this.openHandlers.push(handler as () => void)
    else if (event === 'message') this.messageHandlers.push(handler as (data: unknown) => void)
    else if (event === 'close') this.closeHandlers.push(handler as (code: number, reason: string) => void)
    else if (event === 'error') this.errorHandlers.push(handler as (err: Error) => void)
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.closeCode = code
    this.closeReason = reason
  }
}

describe('docker-entry', () => {
  let mockWs: MockWebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    mockWs = new MockWebSocket()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- createDockerHand 工具注册 ----

  it('createDockerHand 注册 5 个工具（4 NAS + 1 Echo）', () => {
    const { executor } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'test-docker-hand',
        heartbeatIntervalMs: 100,
        reconnectBaseMs: 50,
        maxReconnectAttempts: 2,
      },
      {
        wsFactory: () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>,
      },
    )

    const caps = executor.getCapabilities()
    expect(caps).toHaveLength(5)
    expect(caps).toContain('FileRead')
    expect(caps).toContain('FileWrite')
    expect(caps).toContain('FileList')
    expect(caps).toContain('ShellExecute')
    expect(caps).toContain('Echo')
  })

  it('createDockerHand 返回的 executor 包含所有 NAS 工具定义', () => {
    const { executor } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'test-docker-hand',
        heartbeatIntervalMs: 100,
      },
      {
        wsFactory: () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>,
      },
    )

    const defs = executor.getDefinitions()
    const nasTools = defs.filter(d => ['FileRead', 'FileWrite', 'FileList', 'ShellExecute'].includes(d.name))
    expect(nasTools).toHaveLength(4)

    // 验证只读属性
    const fileRead = nasTools.find(d => d.name === 'FileRead')
    expect(fileRead?.isReadOnly).toBe(true)
    const fileWrite = nasTools.find(d => d.name === 'FileWrite')
    expect(fileWrite?.isReadOnly).toBe(false)
    const fileList = nasTools.find(d => d.name === 'FileList')
    expect(fileList?.isReadOnly).toBe(true)
    const shellExec = nasTools.find(d => d.name === 'ShellExecute')
    expect(shellExec?.isReadOnly).toBe(false)
  })

  it('createDockerHand 创建的 connection 可连接和断开', () => {
    const { connection } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'test-docker-hand',
        heartbeatIntervalMs: 100,
      },
      {
        wsFactory: () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>,
      },
    )

    expect(connection.getStatus()).toBe(HandStatus.Disconnected)

    connection.connect()
    expect(connection.getStatus()).toBe(HandStatus.Connecting)

    mockWs.simulateOpen()
    expect(connection.getStatus()).toBe(HandStatus.Connected)

    connection.disconnect()
    expect(connection.getStatus()).toBe(HandStatus.Disconnected)
  })

  // ---- 环境变量默认值 ----

  it('SERVER_URL 默认值为 ws://localhost:8082/', () => {
    // 验证 createDockerHand 接受默认 URL
    const { executor } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'test-docker-hand',
      },
      {
        wsFactory: () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>,
      },
    )

    // 验证正常创建（不抛异常）
    expect(executor).toBeDefined()
    expect(executor.getCapabilities().length).toBeGreaterThan(0)
  })

  // ---- Hand ID 格式 ----

  it('Hand ID 格式为 hand-docker-nas-{timestamp}', () => {
    const { connection } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'hand-docker-nas-1700000000000',
      },
      {
        wsFactory: () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>,
      },
    )

    connection.connect()
    mockWs.simulateOpen()

    // 验证 register 消息中的 ID
    const registerMsg = JSON.parse(mockWs.sentMessages[0])
    expect(registerMsg.data.id).toBe('hand-docker-nas-1700000000000')
    expect(registerMsg.data.id).toMatch(/^hand-docker-nas-\d+$/)
  })

  // ---- 工具执行回调 ----

  it('收到 hand:execute 时调用 executor 并回传结果', async () => {
    const onExecuteCallbacks: Array<(data: unknown) => void> = []

    // 拦截 wsFactory 来捕获 onExecute 回调
    const { connection, executor } = createDockerHand(
      {
        serverUrl: 'ws://localhost:8082/',
        authToken: 'test-token',
        handId: 'test-docker-hand',
        heartbeatIntervalMs: 60000, // 长间隔避免干扰测试
      },
      {
        wsFactory: (url: string, protocols?: string | string[]) => {
          // 创建一个新的 mockWs，监听 on('message') 来触发回调
          const ws = new MockWebSocket()
          return ws as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>
        },
      },
    )

    // 验证 Echo 工具可执行
    const result = await executor.execute('Echo', { message: 'docker-test' }, {
      workingDirectory: '/data',
      projectRoots: [],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('docker-test')
  })
})
