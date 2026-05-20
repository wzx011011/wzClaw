// ============================================================
// chat-store 单元测试 — 验证 createChatStore 工厂函数与 DataSource 的交互
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DataSource } from '../../data-source/types'
import { createChatStore } from '../chat-store'
import { useHandStore } from '../hand-store'

// ---- rAF polyfill for test environment ----
const _rafCallbacks: Array<() => void> = []
let _rafId = 0
const _rafMap = new Map<number, () => void>()

const _origRAF = globalThis.requestAnimationFrame
const _origCAF = globalThis.cancelAnimationFrame

function mockRAF(cb: () => void): number {
  _rafId++
  _rafMap.set(_rafId, cb)
  return _rafId
}

function mockCAF(id: number): void {
  _rafMap.delete(id)
}

/** 手动刷新所有待执行的 rAF 回调 */
function flushRAF(): void {
  const callbacks = [..._rafMap.values()]
  _rafMap.clear()
  for (const cb of callbacks) cb()
}

beforeEach(() => {
  globalThis.requestAnimationFrame = mockRAF as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = mockCAF as unknown as typeof cancelAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = _origRAF
  globalThis.cancelAnimationFrame = _origCAF
  useHandStore.getState().clearSelection()
  _rafMap.clear()
})

/** 创建 mock DataSource，记录所有调用 */
function createMockDataSource(): {
  dataSource: DataSource
  /** 触发指定类型的 stream 事件（模拟服务器推送） */
  emitStream: (type: string, payload: unknown) => void
  sendMessageSpy: ReturnType<typeof vi.fn>
  stopGenerationSpy: ReturnType<typeof vi.fn>
  createSessionSpy: ReturnType<typeof vi.fn>
} {
  const streamListeners = new Map<string, Set<(payload: unknown) => void>>()
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined)
  const stopGenerationSpy = vi.fn().mockResolvedValue(undefined)
  const createSessionSpy = vi.fn().mockResolvedValue('new-session-id')

  const dataSource: DataSource = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    sendMessage: sendMessageSpy,
    stopGeneration: stopGenerationSpy,
    onStreamEvent(eventType: string, callback: (payload: unknown) => void) {
      let listeners = streamListeners.get(eventType)
      if (!listeners) {
        listeners = new Set()
        streamListeners.set(eventType, listeners)
      }
      listeners.add(callback)
      return () => {
        listeners!.delete(callback)
      }
    },
    listSessions: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue([]),
    createSession: createSessionSpy,
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    getSessionConfig: vi.fn().mockResolvedValue(null),
    updateSessionConfig: vi.fn().mockResolvedValue({
      id: 'session-id',
      title: 'Untitled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      owner: 'nas-remote',
    }),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    getWorkspace: vi.fn().mockResolvedValue(null),
    createWorkspace: vi.fn().mockResolvedValue({ id: 'w1', title: 'Workspace', projects: [], createdAt: 1, updatedAt: 1, archived: false }),
    updateWorkspace: vi.fn().mockResolvedValue({ id: 'w1', title: 'Workspace', projects: [], createdAt: 1, updatedAt: 2, archived: false }),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    addWorkspaceProject: vi.fn().mockResolvedValue({ id: 'w1', title: 'Workspace', projects: [], createdAt: 1, updatedAt: 2, archived: false }),
    removeWorkspaceProject: vi.fn().mockResolvedValue({ id: 'w1', title: 'Workspace', projects: [], createdAt: 1, updatedAt: 3, archived: false }),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }

  return {
    dataSource,
    emitStream(type: string, payload: unknown) {
      const listeners = streamListeners.get(type)
      if (listeners) {
        for (const cb of listeners) {
          cb(payload)
        }
      }
    },
    sendMessageSpy,
    stopGenerationSpy,
    createSessionSpy,
  }
}

describe('createChatStore', () => {
  let mock: ReturnType<typeof createMockDataSource>

  beforeEach(() => {
    mock = createMockDataSource()
  })

  it('Test 1: 初始状态 messages 为空数组', () => {
    const store = createChatStore(mock.dataSource)
    const state = store.getState()
    expect(state.messages).toEqual([])
    expect(state.isStreaming).toBe(false)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.error).toBeNull()
    expect(state.conversationId).toBeTruthy() // 应该有初始 sessionId
  })

  it('Test 2: sendMessage 调用 dataSource.sendMessage 并创建 user+assistant 消息', async () => {
    const store = createChatStore(mock.dataSource)

    await store.getState().sendMessage('hello')

    // 应该调用了 dataSource.sendMessage（第三个参数 options 可选，可能未传）
    expect(mock.sendMessageSpy).toHaveBeenCalledTimes(1)
    const callArgs = mock.sendMessageSpy.mock.calls[0]
    expect(callArgs![0]).toBeTypeOf('string') // conversationId
    expect(callArgs![1]).toBe('hello')       // content

    // 消息列表应该有 2 条消息（user + assistant 占位）
    const state = store.getState()
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]!.role).toBe('user')
    expect(state.messages[0]!.content).toBe('hello')
    expect(state.messages[1]!.role).toBe('assistant')
    expect(state.messages[1]!.content).toBe('')
    expect(state.messages[1]!.isStreaming).toBe(true)

    // 流式状态应该激活
    expect(state.isStreaming).toBe(true)
    expect(state.isWaitingForResponse).toBe(true)
  })

  it('Test 2b: sendMessage 透传已选 Hand', async () => {
    useHandStore.getState().selectHand('desktop-hand-1')
    const store = createChatStore(mock.dataSource, {
      getTargetHandId: () => useHandStore.getState().selectedHandId ?? undefined,
    })

    await store.getState().sendMessage('hello')

    expect(mock.sendMessageSpy).toHaveBeenCalledTimes(1)
    expect(mock.sendMessageSpy.mock.calls[0]![2]).toEqual({ targetHandId: 'desktop-hand-1' })
  })

  it('Test 3: stream:text 事件后 assistant 消息 content 更新', async () => {
    const store = createChatStore(mock.dataSource)

    // 订阅 stream 事件
    const unsub = store.getState().init()

    // 发送消息，创建 assistant 占位
    await store.getState().sendMessage('hello')
    const assistantId = store.getState().streamingMessageId

    // 模拟服务器推送 text 事件
    mock.emitStream('text', { delta: '你好' })

    // 手动刷新 rAF 回调
    flushRAF()

    const state = store.getState()
    const assistantMsg = state.messages.find((m) => m.id === assistantId)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content).toContain('你好')

    unsub()
  })

  it('Test 4: stream:done 事件后 isStreaming 变为 false', async () => {
    const store = createChatStore(mock.dataSource)
    const unsub = store.getState().init()

    await store.getState().sendMessage('hello')

    // 模拟流式完成
    mock.emitStream('done', {
      usage: { inputTokens: 100, outputTokens: 50 },
      turnCount: 1,
    })

    const state = store.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.streamingMessageId).toBeNull()

    unsub()
  })

  it('Test 5: createSession 重置 messages 和 conversationId', async () => {
    const store = createChatStore(mock.dataSource)

    // 先添加一些消息
    await store.getState().sendMessage('hello')
    expect(store.getState().messages.length).toBeGreaterThan(0)

    // 创建新会话
    await store.getState().createSession()

    const state = store.getState()
    expect(state.messages).toEqual([])
    expect(state.isStreaming).toBe(false)
    expect(state.isWaitingForResponse).toBe(false)
    expect(state.streamingMessageId).toBeNull()
    expect(state.error).toBeNull()
  })

  it('Test 6: stopGeneration 调用 dataSource.stopGeneration', async () => {
    const store = createChatStore(mock.dataSource)

    await store.getState().sendMessage('hello')
    expect(store.getState().isStreaming).toBe(true)

    await store.getState().stopGeneration()

    expect(mock.stopGenerationSpy).toHaveBeenCalledTimes(1)
    expect(store.getState().isStreaming).toBe(false)
  })

  // ---- 新增：usage_updated 事件累积 sessionCost ----

  it('Test 7: usage_updated 事件累积 sessionCost', async () => {
    const store = createChatStore(mock.dataSource)
    const unsub = store.getState().init()

    // 初始状态：sessionCost 为 null
    expect(store.getState().sessionCost).toBeNull()

    // 模拟第一次 usage_updated
    mock.emitStream('usage_updated', { inputTokens: 100, outputTokens: 50, totalCostUSD: 0.002 })
    expect(store.getState().sessionCost).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalCostUSD: 0.002,
    })

    // 模拟第二次 usage_updated（累积）
    mock.emitStream('usage_updated', { inputTokens: 200, outputTokens: 100, totalCostUSD: 0.005 })
    expect(store.getState().sessionCost).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalCostUSD: 0.007,
    })

    unsub()
  })

  // ---- 新增：session_running 事件更新 runningSessionIds ----

  it('Test 8: session_running 事件更新 runningSessionIds 集合', async () => {
    const store = createChatStore(mock.dataSource)
    const unsub = store.getState().init()

    // 初始状态：空集合
    expect(store.getState().runningSessionIds.size).toBe(0)

    // 模拟 running
    mock.emitStream('session_running', { sessionId: 's-1', status: 'running' })
    expect(store.getState().runningSessionIds.has('s-1')).toBe(true)

    // 模拟另一个会话 running
    mock.emitStream('session_running', { sessionId: 's-2', status: 'running' })
    expect(store.getState().runningSessionIds.has('s-1')).toBe(true)
    expect(store.getState().runningSessionIds.has('s-2')).toBe(true)

    // 模拟 s-1 idle
    mock.emitStream('session_running', { sessionId: 's-1', status: 'idle' })
    expect(store.getState().runningSessionIds.has('s-1')).toBe(false)
    expect(store.getState().runningSessionIds.has('s-2')).toBe(true)

    unsub()
  })

  // ---- 新增：sub-stream 事件更新 subAgentData ----

  it('Test 9: sub_tool_use_start/end 和 sub_text 事件更新 subAgentData', async () => {
    const store = createChatStore(mock.dataSource)
    const unsub = store.getState().init()

    // 初始状态：空 Map
    expect(store.getState().subAgentData.size).toBe(0)

    // 模拟 sub_tool_use_start
    mock.emitStream('sub_tool_use_start', {
      toolCallId: 'tc-1',
      name: 'FileRead',
      input: { path: '/a.ts' },
      parentToolCallId: 'parent-1',
    })

    const data1 = store.getState().subAgentData.get('parent-1')
    expect(data1).toBeDefined()
    expect(data1!.toolCalls).toHaveLength(1)
    expect(data1!.toolCalls[0]!.name).toBe('FileRead')
    expect(data1!.toolCalls[0]!.status).toBe('running')

    // 模拟 sub_text
    mock.emitStream('sub_text', { delta: 'reading...', parentToolCallId: 'parent-1' })
    const data2 = store.getState().subAgentData.get('parent-1')
    expect(data2!.text).toBe('reading...')

    // 模拟 sub_tool_use_end
    mock.emitStream('sub_tool_use_end', {
      toolCallId: 'tc-1',
      output: 'file content',
      isError: false,
    })
    const data3 = store.getState().subAgentData.get('parent-1')
    expect(data3!.toolCalls[0]!.status).toBe('completed')
    expect(data3!.toolCalls[0]!.output).toBe('file content')

    unsub()
  })

  // ---- 新增：clearConversation 重置 sessionCost 和 subAgentData ----

  it('Test 10: clearConversation 重置 sessionCost 和 subAgentData', async () => {
    const store = createChatStore(mock.dataSource)
    const unsub = store.getState().init()

    // 累积一些数据
    mock.emitStream('usage_updated', { inputTokens: 100, outputTokens: 50, totalCostUSD: 0.002 })
    mock.emitStream('sub_tool_use_start', { toolCallId: 'tc-1', name: 'Echo', input: {} })
    expect(store.getState().sessionCost).not.toBeNull()
    expect(store.getState().subAgentData.size).toBeGreaterThan(0)

    // clearConversation
    store.getState().clearConversation()

    expect(store.getState().sessionCost).toBeNull()
    expect(store.getState().subAgentData.size).toBe(0)

    unsub()
  })
})
