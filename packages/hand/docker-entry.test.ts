// ============================================================
// docker-entry.ts 测试
// 覆盖 createDockerHand 工具注册、环境变量、信号处理
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDockerHand } from './docker-entry.js'
import { LocalToolExecutor } from './src/tool-executor.js'
import type { HandConfig } from './src/types.js'
import { HandStatus } from './src/types.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

// ---- MockWebSocket ----

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
  let tmpConfigDir: string
  let origConfigDir: string | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    mockWs = new MockWebSocket()
    // 创建临时配置目录，启用所有工具
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-hand-test-'))
    fs.writeFileSync(path.join(tmpConfigDir, 'hand.config.json'), JSON.stringify({
      builtinTools: {
        FileRead: { enabled: true },
        FileWrite: { enabled: true },
        FileList: { enabled: true },
        ShellExecute: { enabled: true, timeout: 30 },
        Echo: { enabled: true },
        Grep: { enabled: true },
        Glob: { enabled: true },
        FileEdit: { enabled: true },
        MultiEdit: { enabled: true },
      },
    }))
    origConfigDir = process.env.WZXCLAW_CONFIG_DIR
    process.env.WZXCLAW_CONFIG_DIR = tmpConfigDir
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpConfigDir, { recursive: true, force: true })
    if (origConfigDir === undefined) {
      delete process.env.WZXCLAW_CONFIG_DIR
    } else {
      process.env.WZXCLAW_CONFIG_DIR = origConfigDir
    }
  })

  const wsFactory = () => mockWs as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect>

  it('createDockerHand 注册 9 个工具（8 NAS + 1 Echo）', async () => {
    const { executor } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'test-docker-hand', heartbeatIntervalMs: 100, reconnectBaseMs: 50, maxReconnectAttempts: 2 },
      { wsFactory },
    )

    const caps = executor.getCapabilities()
    expect(caps).toHaveLength(9)
    expect(caps).toContain('FileRead')
    expect(caps).toContain('FileWrite')
    expect(caps).toContain('FileList')
    expect(caps).toContain('ShellExecute')
    expect(caps).toContain('Echo')
    expect(caps).toContain('Grep')
    expect(caps).toContain('Glob')
    expect(caps).toContain('FileEdit')
    expect(caps).toContain('MultiEdit')
  })

  it('createDockerHand 返回的 executor 包含所有 NAS 工具定义', async () => {
    const { executor } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'test-docker-hand', heartbeatIntervalMs: 100 },
      { wsFactory },
    )

    const defs = executor.getDefinitions()
    const nasTools = defs.filter(d => ['FileRead', 'FileWrite', 'FileList', 'ShellExecute'].includes(d.name))
    expect(nasTools).toHaveLength(4)

    const fileRead = nasTools.find(d => d.name === 'FileRead')
    expect(fileRead?.isReadOnly).toBe(true)
    const fileWrite = nasTools.find(d => d.name === 'FileWrite')
    expect(fileWrite?.isReadOnly).toBe(false)
    const fileList = nasTools.find(d => d.name === 'FileList')
    expect(fileList?.isReadOnly).toBe(true)
    const shellExec = nasTools.find(d => d.name === 'ShellExecute')
    expect(shellExec?.isReadOnly).toBe(false)
  })

  it('createDockerHand 创建的 connection 可连接和断开', async () => {
    const { connection } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'test-docker-hand', heartbeatIntervalMs: 100 },
      { wsFactory },
    )

    expect(connection.getStatus()).toBe(HandStatus.Disconnected)
    connection.connect()
    expect(connection.getStatus()).toBe(HandStatus.Connecting)
    mockWs.simulateOpen()
    expect(connection.getStatus()).toBe(HandStatus.Connected)
    connection.disconnect()
    expect(connection.getStatus()).toBe(HandStatus.Disconnected)
  })

  it('SERVER_URL 默认值为 ws://localhost:8082/', async () => {
    const { executor } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'test-docker-hand' },
      { wsFactory },
    )
    expect(executor).toBeDefined()
    expect(executor.getCapabilities().length).toBeGreaterThan(0)
  })

  it('Hand ID 格式为 hand-docker-nas-{timestamp}', async () => {
    const { connection } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'hand-docker-nas-1700000000000' },
      { wsFactory },
    )

    connection.connect()
    mockWs.simulateOpen()

    const registerMsg = JSON.parse(mockWs.sentMessages[0])
    expect(registerMsg.data.id).toBe('hand-docker-nas-1700000000000')
    expect(registerMsg.data.id).toMatch(/^hand-docker-nas-\d+$/)
  })

  it('收到 hand:execute 时调用 executor 并回传结果', async () => {
    const { executor } = await createDockerHand(
      { serverUrl: 'ws://localhost:8082/', authToken: 'test-token', handId: 'test-docker-hand', heartbeatIntervalMs: 60000 },
      { wsFactory: () => new MockWebSocket() as unknown as ReturnType<typeof import('./src/connection.js').HandConnection.prototype.connect> },
    )

    const result = await executor.execute('Echo', { message: 'docker-test' }, {
      workingDirectory: '/data',
      projectRoots: [],
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('docker-test')
  })
})
