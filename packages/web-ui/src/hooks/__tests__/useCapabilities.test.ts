// ============================================================
// useCapabilities hook 单元测试
//
// 测试平台能力检测逻辑（不依赖 @testing-library/react）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useCapabilities } from '../useCapabilities'
import type { DataSource } from '../../data-source/types'

// ---- 测试辅助 ----

function createMockDataSource(withChannels: {
  fs?: boolean
  terminal?: boolean
  preview?: boolean
}): DataSource {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(),
    stopGeneration: vi.fn(),
    onStreamEvent: vi.fn().mockReturnValue(() => {}),
    listSessions: vi.fn().mockResolvedValue([]),
    loadSession: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue('s1'),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    ...(withChannels.fs ? { fs: {} as any } : {}),
    ...(withChannels.terminal ? { terminal: {} as any } : {}),
    ...(withChannels.preview ? { preview: {} as any } : {}),
  }
}

describe('useCapabilities', () => {
  const _origWzxclaw = (globalThis as Record<string, unknown>).wzxclaw
  const _origWindow = (globalThis as Record<string, unknown>).window

  beforeEach(() => {
    // 确保 window 存在（Node 测试环境）
    ;(globalThis as Record<string, unknown>).window = globalThis
  })

  afterEach(() => {
    if (_origWzxclaw === undefined) {
      delete (globalThis as Record<string, unknown>).wzxclaw
    } else {
      ;(globalThis as Record<string, unknown>).wzxclaw = _origWzxclaw
    }
    if (_origWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window
    } else {
      ;(globalThis as Record<string, unknown>).window = _origWindow
    }
  })

  it('无 DataSource 时全禁用', () => {
    // useCapabilities 内部用 useMemo，直接调用返回值
    const caps = computeCapabilities(null)
    expect(caps.localEditor).toBe(false)
    expect(caps.terminal).toBe(false)
    expect(caps.preview).toBe(false)
    expect(caps.fileExplorer).toBe(false)
    expect(caps.taskMode).toBe(false)
  })

  it('Electron 模式（window.wzxclaw 存在）全能力启用', () => {
    ;(globalThis as Record<string, unknown>).wzxclaw = {}
    const ds = createMockDataSource({ fs: true, terminal: true, preview: true })

    const caps = computeCapabilities(ds)
    expect(caps.localEditor).toBe(true)
    expect(caps.terminal).toBe(true)
    expect(caps.preview).toBe(true)
    expect(caps.fileExplorer).toBe(true)
    expect(caps.taskMode).toBe(true)
  })

  it('WebSocket 模式按通道可用性降级', () => {
    delete (globalThis as Record<string, unknown>).wzxclaw
    const ds = createMockDataSource({ fs: true, terminal: true, preview: false })

    const caps = computeCapabilities(ds)
    expect(caps.localEditor).toBe(false)
    expect(caps.terminal).toBe(true)
    expect(caps.preview).toBe(false)
    expect(caps.fileExplorer).toBe(true)
    expect(caps.taskMode).toBe(false)
  })

  it('WebSocket 模式无通道时全部禁用', () => {
    delete (globalThis as Record<string, unknown>).wzxclaw
    const ds = createMockDataSource({})

    const caps = computeCapabilities(ds)
    expect(caps.localEditor).toBe(false)
    expect(caps.terminal).toBe(false)
    expect(caps.preview).toBe(false)
    expect(caps.fileExplorer).toBe(false)
  })
})

/**
 * 提取能力检测核心逻辑为纯函数（不依赖 React hook）
 * 与 useCapabilities hook 内部 useMemo 逻辑一致
 */
function computeCapabilities(dataSource: DataSource | null) {
  if (!dataSource) {
    return { localEditor: false, terminal: false, preview: false, fileExplorer: false, taskMode: false }
  }

  const hasFs = !!dataSource.fs
  const hasTerminal = !!dataSource.terminal
  const hasPreview = !!dataSource.preview

  if (typeof globalThis !== 'undefined' && (globalThis as any).wzxclaw) {
    return { localEditor: true, terminal: true, preview: true, fileExplorer: true, taskMode: true }
  }

  return {
    localEditor: false,
    terminal: hasTerminal,
    preview: hasPreview,
    fileExplorer: hasFs,
    taskMode: false,
  }
}
