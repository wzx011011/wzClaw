// ============================================================
// IpcDataSource 单元测试
//
// 模拟 window.wzxclaw preload API，测试：
// 1. sendMessage 调用 window.wzxclaw.sendMessage 并传参正确
// 2. onStreamEvent('text', cb) 订阅 window.wzxclaw.onStreamText
// 3. listSessions 调用 window.wzxclaw.listSessions
// 4. window.wzxclaw 不存在时 connect() reject
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IpcDataSource } from '../ipc-source'

// ---- 测试辅助 ----

/** 创建 mock window.wzxclaw 对象 */
function createMockApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
    onStreamText: vi.fn().mockReturnValue(() => {}),
    onStreamThinking: vi.fn().mockReturnValue(() => {}),
    onStreamToolStart: vi.fn().mockReturnValue(() => {}),
    onStreamToolResult: vi.fn().mockReturnValue(() => {}),
    onStreamToolProgress: vi.fn().mockReturnValue(() => {}),
    onStreamEnd: vi.fn().mockReturnValue(() => {}),
    onStreamError: vi.fn().mockReturnValue(() => {}),
    onStreamTurnEnd: vi.fn().mockReturnValue(() => {}),
    listSessions: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue({ messages: [] }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }
}

describe('IpcDataSource', () => {
  let mockApi: ReturnType<typeof createMockApi>

  // 保存原始全局状态
  const _origWindow = (globalThis as Record<string, unknown>).window
  const _origWzxclaw = (globalThis as Record<string, unknown>).wzxclaw

  beforeEach(() => {
    mockApi = createMockApi()
    // vitest Node 环境没有 window 全局变量，需要手动设置
    // 让 globalThis.window 指向 globalThis 本身（模拟浏览器环境）
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as Record<string, unknown>).wzxclaw = mockApi
  })

  afterEach(() => {
    // 恢复全局状态
    ;(globalThis as Record<string, unknown>).window = _origWindow
    if (_origWzxclaw === undefined) {
      delete (globalThis as Record<string, unknown>).wzxclaw
    } else {
      ;(globalThis as Record<string, unknown>).wzxclaw = _origWzxclaw
    }
    vi.restoreAllMocks()
  })

  it('sendMessage 调用 window.wzxclaw.sendMessage 并传参正确', async () => {
    const source = new IpcDataSource()
    await source.connect()

    await source.sendMessage('session-1', '你好')

    expect(mockApi.sendMessage).toHaveBeenCalledWith({
      conversationId: 'session-1',
      content: '你好',
      images: undefined,
    })
  })

  it("onStreamEvent('text', cb) 订阅 window.wzxclaw.onStreamText", async () => {
    const source = new IpcDataSource()
    await source.connect()

    const callback = vi.fn()
    source.onStreamEvent('text', callback)

    // 验证调用了 onStreamText
    expect(mockApi.onStreamText).toHaveBeenCalled()

    // 取出注册的回调并调用
    const registeredCallback = mockApi.onStreamText.mock.calls[0]![0]
    registeredCallback({ content: '你好！', sessionId: 'session-1' })

    expect(callback).toHaveBeenCalledWith({ delta: '你好！' })
  })

  it('listSessions 调用 window.wzxclaw.listSessions', async () => {
    const mockSessions = [
      { id: 's1', title: '测试', createdAt: 1000, updatedAt: 2000, messageCount: 5 },
    ]
    mockApi.listSessions.mockResolvedValue(mockSessions)

    const source = new IpcDataSource()
    await source.connect()

    const sessions = await source.listSessions()

    expect(mockApi.listSessions).toHaveBeenCalled()
    expect(sessions).toEqual(mockSessions)
  })

  it('window.wzxclaw 不存在时 connect() reject', async () => {
    // 删除 wzxclaw
    delete (globalThis as Record<string, unknown>).wzxclaw

    const source = new IpcDataSource()
    await expect(source.connect()).rejects.toThrow('Electron preload API 不可用')
  })
})
