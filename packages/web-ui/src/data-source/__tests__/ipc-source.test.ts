// ============================================================
// IpcDataSource 单元测试
//
// IpcDataSource 现在是纯 native capability bridge。
// 只测试 fs/terminal/preview channel 和基础生命周期。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IpcDataSource } from '../ipc-source'

function createMockApi() {
  return {
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
  const _origWindow = (globalThis as Record<string, unknown>).window
  const _origWzxclaw = (globalThis as Record<string, unknown>).wzxclaw

  beforeEach(() => {
    mockApi = createMockApi()
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as Record<string, unknown>).wzxclaw = mockApi
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = _origWindow
    if (_origWzxclaw === undefined) {
      delete (globalThis as Record<string, unknown>).wzxclaw
    } else {
      ;(globalThis as Record<string, unknown>).wzxclaw = _origWzxclaw
    }
    vi.restoreAllMocks()
  })

  it('window.wzxclaw 不存在时 connect() reject', async () => {
    delete (globalThis as Record<string, unknown>).wzxclaw
    const source = new IpcDataSource()
    await expect(source.connect()).rejects.toThrow('Electron preload API 不可用')
  })

  it('capabilities 只报告 native 能力', async () => {
    const source = new IpcDataSource()
    expect(source.capabilities.fs).toBe(true)
    expect(source.capabilities.terminal).toBe(true)
    expect(source.capabilities.preview).toBe(true)
    expect(source.capabilities.workspace).toBe(false)
    expect(source.capabilities.tools).toBe(false)
  })

  it('session 方法返回空/抛错（不再走 IPC）', async () => {
    const source = new IpcDataSource()
    await source.connect()
    expect(await source.listSessions()).toEqual([])
    expect(await source.loadSession('x')).toEqual([])
    expect(await source.getSessionConfig('x')).toBeNull()
    expect(await source.listWorkspaces()).toEqual([])
    expect(await source.getWorkspace('x')).toBeNull()
    await expect(source.createSession()).rejects.toThrow('WebSocketDataSource')
  })

  // ---- FsChannel ----

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

  // ---- TerminalChannel ----

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

  // ---- PreviewChannel ----

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
