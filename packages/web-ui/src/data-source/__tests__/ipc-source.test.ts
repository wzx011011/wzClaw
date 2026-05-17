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
    // FS
    fsReadFile: vi.fn().mockResolvedValue({ content: 'file content' }),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsTree: vi.fn().mockResolvedValue({ nodes: [] }),
    onFsWatch: vi.fn().mockReturnValue(() => {}),
    fsWatchStart: vi.fn().mockResolvedValue(undefined),
    fsWatchStop: vi.fn().mockResolvedValue(undefined),
    // Terminal
    terminalSpawn: vi.fn().mockResolvedValue({ terminalId: 'term-1' }),
    terminalWrite: vi.fn().mockResolvedValue(undefined),
    terminalResize: vi.fn().mockResolvedValue(undefined),
    terminalKill: vi.fn().mockResolvedValue(undefined),
    onTerminalData: vi.fn().mockReturnValue(() => {}),
    onTerminalExit: vi.fn().mockReturnValue(() => {}),
    // Preview
    previewOpen: vi.fn().mockResolvedValue(undefined),
    previewReload: vi.fn().mockResolvedValue(undefined),
    onPreviewUrlChange: vi.fn().mockReturnValue(() => {}),
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

  it('loadSession 支持主进程直接返回消息数组', async () => {
    const mockMessages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    mockApi.loadSession.mockResolvedValue(mockMessages)

    const source = new IpcDataSource()
    await source.connect()

    const messages = await source.loadSession('session-1')

    expect(mockApi.loadSession).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(messages).toEqual(mockMessages)
  })

  it('window.wzxclaw 不存在时 connect() reject', async () => {
    // 删除 wzxclaw
    delete (globalThis as Record<string, unknown>).wzxclaw

    const source = new IpcDataSource()
    await expect(source.connect()).rejects.toThrow('Electron preload API 不可用')
  })

  // ---- IDE 通道测试 ----

  describe('FsChannel', () => {
    it('readFile 代理到 window.wzxclaw.fsReadFile', async () => {
      const source = new IpcDataSource()
      await source.connect()

      const result = await source.fs!.readFile('/path/to/file.ts')
      expect(mockApi.fsReadFile).toHaveBeenCalledWith({ path: '/path/to/file.ts' })
      expect(result.content).toBe('file content')
    })

    it('writeFile 代理到 window.wzxclaw.fsWriteFile', async () => {
      const source = new IpcDataSource()
      await source.connect()

      await source.fs!.writeFile('/path/to/file.ts', 'new content')
      expect(mockApi.fsWriteFile).toHaveBeenCalledWith({ path: '/path/to/file.ts', content: 'new content' })
    })

    it('tree 代理到 window.wzxclaw.fsTree', async () => {
      const nodes = [{ name: 'src', path: '/src', type: 'directory' as const }]
      mockApi.fsTree.mockResolvedValue({ nodes })

      const source = new IpcDataSource()
      await source.connect()

      const result = await source.fs!.tree('/project', 2)
      expect(mockApi.fsTree).toHaveBeenCalledWith({ dirPath: '/project', depth: 2 })
      expect(result).toEqual(nodes)
    })
  })

  describe('TerminalChannel', () => {
    it('spawn 代理到 window.wzxclaw.terminalSpawn', async () => {
      const source = new IpcDataSource()
      await source.connect()

      const terminalId = await source.terminal!.spawn({ shell: '/bin/bash', cwd: '/home' })
      expect(mockApi.terminalSpawn).toHaveBeenCalledWith({ shell: '/bin/bash', cwd: '/home' })
      expect(terminalId).toBe('term-1')
    })

    it('write 代理到 window.wzxclaw.terminalWrite', async () => {
      const source = new IpcDataSource()
      await source.connect()

      await source.terminal!.write('term-1', 'ls -la\n')
      expect(mockApi.terminalWrite).toHaveBeenCalledWith({ terminalId: 'term-1', data: 'ls -la\n' })
    })

    it('kill 代理到 window.wzxclaw.terminalKill', async () => {
      const source = new IpcDataSource()
      await source.connect()

      await source.terminal!.kill('term-1')
      expect(mockApi.terminalKill).toHaveBeenCalledWith({ terminalId: 'term-1' })
    })
  })

  describe('PreviewChannel', () => {
    it('open 代理到 window.wzxclaw.previewOpen', async () => {
      const source = new IpcDataSource()
      await source.connect()

      await source.preview!.open('http://localhost:3000')
      expect(mockApi.previewOpen).toHaveBeenCalledWith({ url: 'http://localhost:3000' })
    })

    it('getUrl 返回最近 open 的 URL', async () => {
      const source = new IpcDataSource()
      await source.connect()

      expect(source.preview!.getUrl()).toBeNull()
      await source.preview!.open('http://localhost:3000')
      expect(source.preview!.getUrl()).toBe('http://localhost:3000')
    })
  })
})
