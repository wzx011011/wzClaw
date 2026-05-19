// ============================================================
// TerminalManager — Hand 端 PTY 进程生命周期管理
// 模仿 wzxClaw_desktop/src/main/terminal/terminal-manager.ts 的实现
//
// 职责：
// - spawn / write / resize / kill PTY 进程
// - 通过 onData / onExit 回调将增量数据推送给 connection 层
// - node-pty 加载失败时优雅降级（spawn 抛错，其他方法 no-op）
// ============================================================

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 默认列数 */
export const TERMINAL_DEFAULT_COLS = 80
/** 默认行数 */
export const TERMINAL_DEFAULT_ROWS = 24
/** 单个终端最大缓冲区字节数（防止内存爆炸） */
const TERMINAL_BUFFER_SIZE = 1_000_000

interface TerminalEntry {
  pty: import('node-pty').IPty
  buffer: string
  cols: number
  rows: number
  /** 用于在 kill 时断开 onData / onExit 监听 */
  disposers: Array<() => void>
}

/** PTY 输出推送回调（data 是新增的增量字符串） */
export type TerminalDataCallback = (terminalId: string, data: string) => void
/** PTY 退出推送回调 */
export type TerminalExitCallback = (terminalId: string, exitCode: number, signal: number | null) => void

/** 懒加载 node-pty 模块（native module，可能加载失败） */
let ptyModule: typeof import('node-pty') | null = null
let ptyLoadAttempted = false

function getPtyModule(): typeof import('node-pty') | null {
  if (ptyLoadAttempted) return ptyModule
  ptyLoadAttempted = true
  try {
    ptyModule = require('node-pty') as typeof import('node-pty')
  } catch (err) {
    console.warn('[terminal-manager] node-pty 加载失败，终端功能不可用：', err)
  }
  return ptyModule
}

/** 仅供测试使用：重置 node-pty 加载状态 */
export function _resetPtyModuleForTests(mock?: typeof import('node-pty') | null): void {
  ptyModule = mock ?? null
  ptyLoadAttempted = mock !== undefined
}

/**
 * TerminalManager — Hand 端 PTY 管理器
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalEntry>()
  private nextId = 1

  /** 数据推送回调（构造时设置） */
  private readonly onData: TerminalDataCallback
  /** 退出推送回调（构造时设置） */
  private readonly onExit: TerminalExitCallback

  constructor(callbacks: { onData: TerminalDataCallback; onExit: TerminalExitCallback }) {
    this.onData = callbacks.onData
    this.onExit = callbacks.onExit
  }

  /**
   * 检查 node-pty 是否可用（用于工具能力上报）
   */
  static isAvailable(): boolean {
    return getPtyModule() !== null
  }

  /**
   * Spawn 新的 PTY 进程
   *
   * @param cwd 工作目录（必须由调用方完成 path-guard）
   * @param cols 终端列数
   * @param rows 终端行数
   * @param shell 可选 shell（默认 win32: COMSPEC / 其他: SHELL）
   * @returns 新分配的 terminalId
   * @throws 如果 node-pty 不可用
   */
  spawn(cwd: string, cols = TERMINAL_DEFAULT_COLS, rows = TERMINAL_DEFAULT_ROWS, shell?: string): string {
    const pty = getPtyModule()
    if (!pty) {
      throw new Error('node-pty 模块不可用，无法创建终端')
    }

    const id = `hand-term-${this.nextId++}`
    const isWindows = process.platform === 'win32'
    const resolvedShell = shell
      ?? (isWindows
        ? (process.env.COMSPEC || 'cmd.exe')
        : (process.env.SHELL || '/bin/bash'))

    const ptyProcess = pty.spawn(resolvedShell, [], {
      cwd,
      cols,
      rows,
      name: 'xterm-256color',
      ...(isWindows ? { useConpty: true, conptyInheritCursor: true } : {}),
    })

    const entry: TerminalEntry = {
      pty: ptyProcess,
      buffer: '',
      cols,
      rows,
      disposers: [],
    }
    this.terminals.set(id, entry)

    const dataSub = ptyProcess.onData((data: string) => {
      // 追加到 buffer 并裁剪
      entry.buffer += data
      const trimThreshold = TERMINAL_BUFFER_SIZE * 1.5
      if (entry.buffer.length > trimThreshold) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - TERMINAL_BUFFER_SIZE)
      }
      // 推送给上层
      this.onData(id, data)
    })

    const exitSub = ptyProcess.onExit(({ exitCode, signal }) => {
      this.onExit(id, exitCode, signal ?? null)
      // 自动清理
      this.terminals.delete(id)
    })

    // node-pty 的 dispose 接口
    entry.disposers.push(() => { try { dataSub.dispose() } catch { /* ignore */ } })
    entry.disposers.push(() => { try { exitSub.dispose() } catch { /* ignore */ } })

    return id
  }

  /**
   * 向 PTY 写入数据
   * 未知 terminalId 静默忽略（兼容已退出的终端）
   */
  write(terminalId: string, data: string): boolean {
    const entry = this.terminals.get(terminalId)
    if (!entry) return false
    entry.pty.write(data)
    return true
  }

  /**
   * 调整 PTY 大小
   */
  resize(terminalId: string, cols: number, rows: number): boolean {
    const entry = this.terminals.get(terminalId)
    if (!entry) return false
    entry.pty.resize(cols, rows)
    entry.cols = cols
    entry.rows = rows
    return true
  }

  /**
   * 终止 PTY 进程
   */
  kill(terminalId: string): boolean {
    const entry = this.terminals.get(terminalId)
    if (!entry) return false
    for (const dispose of entry.disposers) dispose()
    try { entry.pty.kill() } catch { /* 已退出 */ }
    this.terminals.delete(terminalId)
    return true
  }

  /**
   * 获取当前活跃的 terminal ID 列表
   */
  listTerminals(): string[] {
    return Array.from(this.terminals.keys())
  }

  /**
   * 关闭并清理所有终端（连接断开时调用）
   */
  disposeAll(): void {
    for (const [id, entry] of this.terminals) {
      for (const dispose of entry.disposers) dispose()
      try { entry.pty.kill() } catch { /* ignore */ }
      this.terminals.delete(id)
    }
  }
}
