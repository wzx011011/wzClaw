// ============================================================
// connection.ts 单元测试
// 使用 MockWebSocket 测试 HandConnection 的连接、注册、心跳、重连逻辑
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HandConnection } from './connection.js'
import { HandStatus } from './types.js'
import type { HandConfig, ExecuteCallbackData } from './types.js'

// ---- MockWebSocket ----

/** 模拟 WebSocket 的行为，支持 open/message/close/error 事件 */
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

  /** 模拟连接建立（触发 open 事件） */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    for (const h of this.openHandlers) h()
  }

  /** 模拟收到消息 */
  simulateMessage(data: unknown): void {
    for (const h of this.messageHandlers) h(data)
  }

  /** 模拟连接关闭 */
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    for (const h of this.closeHandlers) h(code, reason)
  }

  /** 模拟连接错误 */
  simulateError(err: Error): void {
    for (const h of this.errorHandlers) h(err)
  }

  // ---- WebSocket 接口实现 ----

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (event === 'open') this.openHandlers.push(handler as () => void)
    else if (event === 'message') this.messageHandlers.push(handler as (data: unknown) => void)
    else if (event === 'close') this.closeHandlers.push(handler as (code: number, reason: string) => void)
    else if (event === 'error') this.errorHandlers.push(handler as (err: Error) => void)
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
    this.sentMessages.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.closeCode = code
    this.closeReason = reason
  }
}

/** 创建测试用的 HandConfig */
function createTestConfig(overrides?: Partial<HandConfig>): HandConfig {
  return {
    serverUrl: 'ws://localhost:8082',
    authToken: 'test-token',
    handId: 'test-hand',
    heartbeatIntervalMs: 100, // 短间隔方便测试
    reconnectBaseMs: 50,      // 短间隔方便测试
    maxReconnectAttempts: 3,
    ...overrides,
  }
}

// ---- 测试 ----

describe('HandConnection', () => {
  let mockWs: MockWebSocket
  let wsFactory: (url: string, protocols?: string | string[]) => MockWebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    mockWs = new MockWebSocket()
    wsFactory = (_url: string, _protocols?: string | string[]) => mockWs
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- connect ----

  it('connect 建立连接并发送 hand:register', () => {
    const onStatusChange = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onStatusChange })

    conn.connect()

    // 状态先变为 connecting
    expect(onStatusChange).toHaveBeenCalledWith(HandStatus.Connecting)

    // 模拟连接建立
    mockWs.simulateOpen()

    // 发送了 register 消息
    expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(1)
    const registerMsg = JSON.parse(mockWs.sentMessages[0])
    expect(registerMsg.event).toBe('hand:register')
    expect(registerMsg.data.id).toBe('test-hand')
  })

  it('connect 使用正确的 URL（附加 ?type=hand）', () => {
    let capturedUrl = ''
    let capturedProtocols: string | string[] | undefined
    const factoryWs = new MockWebSocket()
    const factory = (url: string, protocols?: string | string[]) => {
      capturedUrl = url
      capturedProtocols = protocols
      return factoryWs
    }

    const conn = new HandConnection(createTestConfig(), { wsFactory: factory })
    conn.connect()

    expect(capturedUrl).toContain('type=hand')
    // token 通过 Sec-WebSocket-Protocol 头传输
    expect(capturedProtocols).toContain('wzxclaw-test-token')
  })

  // ---- hand:execute 回调 ----

  it('收到 hand:execute 时触发 onExecute 回调', () => {
    const onExecute = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onExecute })
    conn.connect()
    mockWs.simulateOpen()

    // 模拟收到 hand:execute
    const executePayload = JSON.stringify({
      event: 'hand:execute',
      data: {
        callId: 'call-1',
        name: 'FileRead',
        input: { path: '/a.ts' },
        context: { workingDirectory: '/project', projectRoots: ['/project'] },
      },
    })
    mockWs.simulateMessage(executePayload)

    expect(onExecute).toHaveBeenCalledTimes(1)
    const callData = onExecute.mock.calls[0][0] as ExecuteCallbackData
    expect(callData.callId).toBe('call-1')
    expect(callData.name).toBe('FileRead')
    expect(callData.input).toEqual({ path: '/a.ts' })
  })

  // ---- sendResult ----

  it('sendResult 发送正确格式的 hand:result 消息', () => {
    const conn = new HandConnection(createTestConfig(), { wsFactory })
    conn.connect()
    mockWs.simulateOpen()

    // 清空 register 消息
    mockWs.sentMessages.length = 0

    conn.sendResult('call-1', 'file content', false)
    expect(mockWs.sentMessages.length).toBe(1)

    const resultMsg = JSON.parse(mockWs.sentMessages[0])
    expect(resultMsg.event).toBe('hand:result')
    expect(resultMsg.data.callId).toBe('call-1')
    expect(resultMsg.data.output).toBe('file content')
    expect(resultMsg.data.isError).toBe(false)
  })

  it('sendResult 在未连接状态时不发送', () => {
    const conn = new HandConnection(createTestConfig(), { wsFactory })
    // 不调用 connect，状态为 disconnected
    conn.sendResult('call-1', 'result', false)
    expect(mockWs.sentMessages.length).toBe(0)
  })

  // ---- 心跳 ----

  it('心跳定时器启动后定期发送 hand:heartbeat', () => {
    const conn = new HandConnection(createTestConfig(), { wsFactory })
    conn.connect()
    mockWs.simulateOpen()

    // 清空 register 消息
    mockWs.sentMessages.length = 0

    // 前进一个心跳间隔（100ms）
    vi.advanceTimersByTime(100)
    expect(mockWs.sentMessages.length).toBe(1)
    expect(JSON.parse(mockWs.sentMessages[0]).event).toBe('hand:heartbeat')

    // 再前进一个间隔
    vi.advanceTimersByTime(100)
    expect(mockWs.sentMessages.length).toBe(2)
  })

  it('disconnect 后心跳停止', () => {
    const conn = new HandConnection(createTestConfig(), { wsFactory })
    conn.connect()
    mockWs.simulateOpen()
    mockWs.sentMessages.length = 0

    conn.disconnect()

    // 前进时间，不应有心跳
    vi.advanceTimersByTime(300)
    expect(mockWs.sentMessages.length).toBe(0)
  })

  // ---- 断连重连 ----

  it('连接断开后自动触发重连', () => {
    const onDisconnect = vi.fn()
    const onStatusChange = vi.fn()
    let connectCount = 0
    const factory = () => {
      connectCount++
      const ws = new MockWebSocket()
      // 只在第一次连接时模拟 open
      if (connectCount === 1) {
        // 延迟触发 open 以便后续检查
        setImmediate(() => ws.simulateOpen())
      }
      return ws
    }

    const conn = new HandConnection(
      createTestConfig(),
      { wsFactory: factory, onDisconnect, onStatusChange },
    )
    conn.connect()

    // 第一次连接
    expect(connectCount).toBe(1)
  })

  it('连接断开后触发 onDisconnect 回调', () => {
    const onDisconnect = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onDisconnect })
    conn.connect()
    mockWs.simulateOpen()

    // 模拟断连
    mockWs.simulateClose(1006, 'abnormal')

    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnect 主动关闭不触发重连', () => {
    let connectCount = 0
    const factory = () => {
      connectCount++
      return new MockWebSocket()
    }

    const conn = new HandConnection(createTestConfig(), { wsFactory: factory })
    conn.connect()
    mockWs.simulateOpen()
    expect(connectCount).toBe(1)

    conn.disconnect()

    // 前进足够的重连等待时间
    vi.advanceTimersByTime(500)

    // 不应有新的连接尝试
    expect(connectCount).toBe(1)
  })

  // ---- 状态管理 ----

  it('getStatus 返回当前连接状态', () => {
    const conn = new HandConnection(createTestConfig(), { wsFactory })
    expect(conn.getStatus()).toBe(HandStatus.Disconnected)

    conn.connect()
    expect(conn.getStatus()).toBe(HandStatus.Connecting)

    mockWs.simulateOpen()
    expect(conn.getStatus()).toBe(HandStatus.Connected)

    conn.disconnect()
    expect(conn.getStatus()).toBe(HandStatus.Disconnected)
  })

  it('状态变更时触发 onStatusChange 回调', () => {
    const onStatusChange = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onStatusChange })

    conn.connect()
    expect(onStatusChange).toHaveBeenCalledWith(HandStatus.Connecting)

    mockWs.simulateOpen()
    expect(onStatusChange).toHaveBeenCalledWith(HandStatus.Connected)
  })

  it('连接断开后状态变为 reconnecting', () => {
    const onStatusChange = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onStatusChange })
    conn.connect()
    mockWs.simulateOpen()

    // 清空之前的调用
    onStatusChange.mockClear()

    // 模拟断连
    mockWs.simulateClose(1006, 'abnormal')

    // 状态应经过 disconnected → reconnecting
    const calls = onStatusChange.mock.calls.map((c: unknown[]) => c[0])
    expect(calls).toContain(HandStatus.Disconnected)
    expect(calls).toContain(HandStatus.Reconnecting)
  })

  // ---- 错误处理 ----

  it('WebSocket error 事件不导致崩溃', () => {
    const onStatusChange = vi.fn()
    const conn = new HandConnection(createTestConfig(), { wsFactory, onStatusChange })
    conn.connect()
    mockWs.simulateOpen()

    // 模拟 error 事件
    expect(() => mockWs.simulateError(new Error('test error'))).not.toThrow()
  })

  // ---- register 带默认配置 ----

  it('未提供 handId 时自动生成唯一 ID', () => {
    const config = createTestConfig()
    delete config.handId

    const conn = new HandConnection(config, { wsFactory })
    conn.connect()
    mockWs.simulateOpen()

    const registerMsg = JSON.parse(mockWs.sentMessages[0])
    // 应生成一个非空的 ID
    expect(registerMsg.data.id).toBeTruthy()
    expect(typeof registerMsg.data.id).toBe('string')
  })
})
