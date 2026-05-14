// ============================================================
// chat-store session 操作单元测试 — 验证 CRUD 与 DataSource 的交互
// TDD RED 阶段：4 个 session 测试
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataSource, SessionMeta } from '../../data-source/types'
import { createChatStore } from '../chat-store'

/** 创建 mock DataSource，记录所有调用 */
function createMockDataSource(sessionMocks?: {
  listSessions?: SessionMeta[]
}): {
  dataSource: DataSource
  listSessionsSpy: ReturnType<typeof vi.fn>
  loadSessionSpy: ReturnType<typeof vi.fn>
  deleteSessionSpy: ReturnType<typeof vi.fn>
  renameSessionSpy: ReturnType<typeof vi.fn>
} {
  const listSessionsSpy = vi.fn().mockResolvedValue(sessionMocks?.listSessions ?? [])
  const loadSessionSpy = vi.fn().mockResolvedValue([])
  const deleteSessionSpy = vi.fn().mockResolvedValue(undefined)
  const renameSessionSpy = vi.fn().mockResolvedValue(undefined)

  const dataSource: DataSource = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
    onStreamEvent: vi.fn().mockReturnValue(() => {}),
    listSessions: listSessionsSpy,
    loadSession: loadSessionSpy,
    createSession: vi.fn().mockResolvedValue('new-session-id'),
    deleteSession: deleteSessionSpy,
    renameSession: renameSessionSpy,
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }

  return {
    dataSource,
    listSessionsSpy,
    loadSessionSpy,
    deleteSessionSpy,
    renameSessionSpy,
  }
}

// ---- 示例 SessionMeta 数据 ----
const MOCK_SESSIONS: SessionMeta[] = [
  {
    id: 'session-1',
    title: '第一个会话',
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 1800000,
    messageCount: 5,
    preview: '你好世界',
  },
  {
    id: 'session-2',
    title: '第二个会话',
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 3600000,
    messageCount: 3,
    preview: '测试消息',
  },
]

describe('chat-store session 操作', () => {
  let mock: ReturnType<typeof createMockDataSource>

  beforeEach(() => {
    mock = createMockDataSource({ listSessions: MOCK_SESSIONS })
  })

  it('Test 1: loadSessionList() 调用 dataSource.listSessions() 并更新 sessions 状态', async () => {
    const store = createChatStore(mock.dataSource)

    // 初始 sessions 应为空数组
    expect(store.getState().sessions).toEqual([])

    // 调用 loadSessionList
    await store.getState().loadSessionList()

    // 应该调用了 dataSource.listSessions
    expect(mock.listSessionsSpy).toHaveBeenCalledTimes(1)

    // sessions 状态应更新为返回的数据
    const sessions = store.getState().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.id).toBe('session-1')
    expect(sessions[1]!.id).toBe('session-2')
  })

  it('Test 2: switchSession(sid) 调用 dataSource.loadSession(sid) 并更新 messages', async () => {
    // 让 loadSession 返回一些消息
    mock.loadSessionSpy.mockResolvedValue([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
    ])

    const store = createChatStore(mock.dataSource)

    // 加载会话列表（初始化 sessions）
    await store.getState().loadSessionList()

    // 切换到 session-1
    await store.getState().switchSession('session-1')

    // 应该调用了 dataSource.loadSession
    expect(mock.loadSessionSpy).toHaveBeenCalledWith('session-1')

    // conversationId 应更新为目标会话 ID
    expect(store.getState().conversationId).toBe('session-1')

    // messages 应更新为加载的消息（转换后）
    const messages = store.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toBe('你好')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.content).toBe('你好！有什么可以帮你？')

    // activeSessionId 应更新
    expect(store.getState().activeSessionId).toBe('session-1')
  })

  it('Test 3: deleteSession(sid) 调用 dataSource.deleteSession(sid) 并从 sessions 移除', async () => {
    const store = createChatStore(mock.dataSource)

    // 加载会话列表
    await store.getState().loadSessionList()
    expect(store.getState().sessions).toHaveLength(2)

    // 删除 session-2
    await store.getState().deleteSession('session-2')

    // 应该调用了 dataSource.deleteSession
    expect(mock.deleteSessionSpy).toHaveBeenCalledWith('session-2')

    // sessions 列表中应移除被删除的会话
    const sessions = store.getState().sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('session-1')
  })

  it('Test 4: renameSession(sid, title) 调用 dataSource.renameSession(sid, title)', async () => {
    const store = createChatStore(mock.dataSource)

    // 加载会话列表
    await store.getState().loadSessionList()

    // 重命名 session-1
    await store.getState().renameSession('session-1', '新标题')

    // 应该调用了 dataSource.renameSession
    expect(mock.renameSessionSpy).toHaveBeenCalledWith('session-1', '新标题')

    // sessions 数组中对应会话的 title 应更新
    const session = store.getState().sessions.find(s => s.id === 'session-1')
    expect(session).toBeDefined()
    expect(session!.title).toBe('新标题')
  })
})
