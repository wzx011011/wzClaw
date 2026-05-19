// ============================================================
// useCapabilities — 平台能力检测 hook
//
// 根据 DataSource 类型和可用通道决定 IDE 功能开关。
// Electron: 全能力; WebSocket: 降级; 未知: 全禁用。
// ============================================================

import { useMemo } from 'react'
import type { DataSource } from '../data-source/types'

/** 平台能力集合 */
export interface PlatformCapabilities {
  /** Monaco 编辑器 */
  localEditor: boolean
  /** xterm.js 终端 */
  terminal: boolean
  /** iframe 预览 */
  preview: boolean
  /** 文件树浏览 */
  fileExplorer: boolean
  /** Task/Workspace 多任务页 */
  taskMode: boolean
  /** 移动端 Shell 布局（<=768px + 非 Electron） */
  mobileShell: boolean
}

/** Electron 桌面端：全部启用 */
const CAPS_ELECTRON: PlatformCapabilities = {
  localEditor: true,
  terminal: true,
  preview: true,
  fileExplorer: true,
  taskMode: true,
  mobileShell: false,
}

/** 无能力 */
const CAPS_NONE: PlatformCapabilities = {
  localEditor: false,
  terminal: false,
  preview: false,
  fileExplorer: false,
  taskMode: false,
  mobileShell: false,
}

/**
 * useCapabilities — 根据当前 DataSource 检测平台能力
 *
 * 判断逻辑：
 * 1. 无 DataSource → 全禁用
 * 2. IpcDataSource（window.wzxclaw 存在）→ Electron 全能力
 * 3. WebSocketDataSource → 远程降级能力
 */
export function useCapabilities(dataSource: DataSource | null): PlatformCapabilities {
  return useMemo(() => {
    if (!dataSource) return CAPS_NONE

    // 检测 fs/terminal/preview 通道是否可用
    const hasFs = !!dataSource.fs
    const hasTerminal = !!dataSource.terminal
    const hasPreview = !!dataSource.preview
    const runtimeCapabilities = dataSource.capabilities

    // Electron IPC 模式（window.wzxclaw 存在）
    if (typeof window !== 'undefined' && window.wzxclaw) {
      return CAPS_ELECTRON
    }

    // WebSocket 远程模式 — 按实际通道可用性决定
    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
    return {
      localEditor: false,
      terminal: hasTerminal,
      preview: hasPreview,
      fileExplorer: hasFs,
      taskMode: runtimeCapabilities?.workspace ?? true,
      mobileShell: isMobile,
    }
  }, [dataSource, dataSource?.fs, dataSource?.terminal, dataSource?.preview])
}
