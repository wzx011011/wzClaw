// ============================================================
// HandBridge 单元测试
// 测试 Hand Bridge 的连接管理、工具注册和执行路由
// ============================================================

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { HandBridge } from '../hand-bridge'
import { HandStatus } from '@wzxclaw/hand'
import type { ToolRegistry } from '../tools/tool-registry'
import type { Tool } from '../tools/tool-interface'

// ---- Mock 工厂 ----

/** 创建 mock Tool */
function createMockTool(name: string): Tool {
  return {
    name,
    description: `${name} 工具`,
    inputSchema: { type: 'object', properties: {} },
    requiresApproval: false,
    isReadOnly: true,
    execute: vi.fn(async (input: Record<string, unknown>) => ({
      output: `${name} executed with ${JSON.stringify(input)}`,
      isError: false,
    })),
  }
}

/** 创建 mock ToolRegistry */
function createMockRegistry(toolNames: string[]): ToolRegistry {
  const tools = toolNames.map(createMockTool)
  return {
    getAll: vi.fn(() => tools),
    get: vi.fn((name: string) => tools.find(t => t.name === name)),
    getDefinitions: vi.fn(() => tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
    register: vi.fn(),
    unregister: vi.fn(),
    getApprovalRequired: vi.fn(() => []),
    isReadOnly: vi.fn(() => true),
  } as unknown as ToolRegistry
}

/** 创建 mock SettingsManager */
function createMockSettingsManager(agentUrl?: string, token?: string) {
  return {
    getRelayToken: vi.fn(() => token ?? 'test-relay-token'),
    getSettings: vi.fn(() => ({
      relayToken: token ?? 'test-relay-token',
    })),
    // Hand Bridge 需要读取的 NAS Agent Server 配置
    _agentUrl: agentUrl ?? 'ws://localhost:8082',
  }
}

/** 记录 WebSocket 调用的 mock 工厂 */
function createMockWsFactory() {
  const sentMessages: string[] = []
  const eventHandlers: Map<string, (...args: unknown[]) => void> = new Map()
  let readyState = 0 // WebSocket.CONNECTING = 0, OPEN = 1

  const ws = {
    readyState,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler)
    }),
    send: vi.fn((data: string) => {
      sentMessages.push(data)
    }),
    close: vi.fn(),
    // 测试辅助方法
    _simulateOpen: () => {
      readyState = 1
      const handler = eventHandlers.get('open')
      handler?.()
    },
    _simulateMessage: (data: string) => {
      const handler = eventHandlers.get('message')
      handler?.(data)
    },
    _simulateClose: (code = 1000, reason = '') => {
      readyState = 3
      const handler = eventHandlers.get('close')
      handler?.(code, reason)
    },
    _simulateError: (err: Error) => {
      const handler = eventHandlers.get('error')
      handler?.(err)
    },
    _sentMessages: sentMessages,
    _eventHandlers: eventHandlers,
  }

  const factory = vi.fn(() => ws)

  return { factory, ws }
}

// ---- 测试 ----

describe('HandBridge', () => {
  let registry: ToolRegistry
  let settings: ReturnType<typeof createMockSettingsManager>
  let wsHelper: ReturnType<typeof createMockWsFactory>

  beforeEach(() => {
    registry = createMockRegistry(['FileRead', 'FileWrite', 'Bash'])
    settings = createMockSettingsManager('ws://localhost:8082', 'test-token')
    wsHelper = createMockWsFactory()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Test 1: connect() 创建连接并发送 hand:register 消息', () => {
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: settings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.connect()

    // 验证 WebSocket 工厂被调用（URL 带 ?type=hand，token 作为 protocol）
    expect(wsHelper.factory).toHaveBeenCalledOnce()
    const [url, protocol] = wsHelper.factory.mock.calls[0]
    expect(url).toContain('ws://localhost:8082')
    expect(url).toContain('type=hand')
    expect(protocol).toBe('wzxclaw-test-token')

    // 模拟连接建立
    wsHelper.ws._simulateOpen()

    // 验证注册消息被发送（包含工具定义）
    const registerMsg = wsHelper.ws._sentMessages.find(m => m.includes('hand:register'))
    expect(registerMsg).toBeDefined()

    const parsed = JSON.parse(registerMsg!)
    expect(parsed.event).toBe('hand:register')
    expect(parsed.data.id).toBeDefined()
    expect(parsed.data.capabilities).toEqual(['FileRead', 'FileWrite', 'Bash'])
    expect(parsed.data.definitions).toHaveLength(3)
    expect(parsed.data.definitions[0].name).toBe('FileRead')
  })

  it('Test 2: connect() 将所有工具注册到执行器', () => {
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: settings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.connect()
    wsHelper.ws._simulateOpen()

    // 验证注册消息中的 capabilities 包含所有工具名
    const registerMsg = JSON.parse(
      wsHelper.ws._sentMessages.find(m => m.includes('hand:register'))!,
    )
    expect(registerMsg.data.capabilities).toHaveLength(3)
    expect(registerMsg.data.capabilities).toContain('FileRead')
    expect(registerMsg.data.capabilities).toContain('FileWrite')
    expect(registerMsg.data.capabilities).toContain('Bash')
  })

  it('Test 3: onExecute 回调通过执行器执行工具并 sendResult', async () => {
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: settings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.connect()
    wsHelper.ws._simulateOpen()

    // 清除已发送的注册消息，方便后续断言
    wsHelper.ws._sentMessages.length = 0

    // 模拟收到 hand:execute 消息
    const executeMsg = JSON.stringify({
      event: 'hand:execute',
      data: {
        callId: 'call-001',
        name: 'FileRead',
        input: { path: '/test/file.ts' },
        context: {
          workingDirectory: '/test/project',
          projectRoots: ['/test/project'],
        },
      },
    })

    wsHelper.ws._simulateMessage(executeMsg)

    // 等待微任务完成（异步 execute Promise）
    await vi.advanceTimersByTimeAsync(0)

    // 验证工具被执行
    const fileReadTool = registry.getAll().find(t => t.name === 'FileRead')!
    expect(fileReadTool.execute).toHaveBeenCalledOnce()

    // 验证 hand:result 被发送
    const resultMsg = wsHelper.ws._sentMessages.find(m => m.includes('hand:result'))
    expect(resultMsg).toBeDefined()

    const parsed = JSON.parse(resultMsg!)
    expect(parsed.event).toBe('hand:result')
    expect(parsed.data.callId).toBe('call-001')
    expect(parsed.data.isError).toBe(false)
    expect(parsed.data.output).toContain('FileRead executed')
  })

  it('Test 4: disconnect() 关闭连接', () => {
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: settings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.connect()
    wsHelper.ws._simulateOpen()

    expect(bridge.getStatus()).toBe(HandStatus.Connected)

    bridge.disconnect()

    expect(wsHelper.ws.close).toHaveBeenCalled()
    expect(bridge.getStatus()).toBe(HandStatus.Disconnected)
  })

  it('Test 5: onStatusChange 回调触发外部 listener', () => {
    const statusChanges: HandStatus[] = []
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: settings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.onStatusChange((status) => {
      statusChanges.push(status)
    })

    bridge.connect()

    // 连接中状态
    expect(statusChanges).toContain(HandStatus.Connecting)

    // 连接建立
    wsHelper.ws._simulateOpen()
    expect(statusChanges).toContain(HandStatus.Connected)
  })

  it('Test 6: 配置从 settingsManager 读取 (serverUrl, token)', () => {
    const customSettings = createMockSettingsManager('wss://nas.example.com/agent/', 'my-secret-token')
    const bridge = new HandBridge({
      toolRegistry: registry,
      settingsManager: customSettings,
      workingDirectory: '/test/workspace',
      wsFactory: wsHelper.factory,
    })

    bridge.connect()

    // 验证 URL 来自 settingsManager（尾部斜杠会被去除，然后加 ?type=hand）
    const [url, protocol] = wsHelper.factory.mock.calls[0]
    expect(url).toContain('wss://nas.example.com/agent')
    expect(url).toContain('type=hand')
    expect(protocol).toBe('wzxclaw-my-secret-token')
  })
})
