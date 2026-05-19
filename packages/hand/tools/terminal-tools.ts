// ============================================================
// Terminal tools — TerminalSpawn / TerminalWrite / TerminalResize / TerminalKill
// 通过 hand:execute 调用，操作共享的 TerminalManager 实例
// 数据流（terminal:data / terminal:exit）由 TerminalManager 通过 connection.sendFrame 推送
//
// 安全：TerminalSpawn 的 cwd 走 assertPathInWorkspace（S7 path allowlist）
// ============================================================

import type { HandTool } from '../src/tool-executor.js'
import type { TerminalManager } from '../src/terminal-manager.js'
import { assertPathInWorkspace } from '../src/path-guard.js'

type ExecuteResult = { output: string; isError: boolean }

/** TerminalSpawn — 在 Hand 端启动 PTY 进程 */
export class TerminalSpawnTool implements HandTool {
  readonly name = 'TerminalSpawn'
  readonly description = '在 Hand 端创建新的 PTY 进程，返回 terminalId'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: '工作目录（必须在 workspace 内）' },
      cols: { type: 'number', description: '列数（默认 80）' },
      rows: { type: 'number', description: '行数（默认 24）' },
      shell: { type: 'string', description: '可选 shell 路径（默认平台 shell）' },
    },
    required: ['cwd'],
  }
  readonly isReadOnly = false

  constructor(private readonly manager: TerminalManager) {}

  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<ExecuteResult> {
    const cwd = typeof input.cwd === 'string' ? input.cwd : context.workingDirectory
    if (!cwd) {
      return { output: '缺少 cwd 参数', isError: true }
    }

    // S7 path allowlist
    const guardErr = assertPathInWorkspace(cwd, context)
    if (guardErr) return guardErr

    const cols = typeof input.cols === 'number' && input.cols > 0 ? Math.floor(input.cols) : undefined
    const rows = typeof input.rows === 'number' && input.rows > 0 ? Math.floor(input.rows) : undefined
    const shell = typeof input.shell === 'string' && input.shell.length > 0 ? input.shell : undefined

    try {
      const terminalId = this.manager.spawn(cwd, cols, rows, shell)
      return { output: JSON.stringify({ terminalId }), isError: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `TerminalSpawn 失败: ${msg}`, isError: true }
    }
  }
}

/** TerminalWrite — 向 PTY stdin 写入数据 */
export class TerminalWriteTool implements HandTool {
  readonly name = 'TerminalWrite'
  readonly description = '向指定 terminalId 的 PTY 写入数据'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      terminalId: { type: 'string' },
      data: { type: 'string' },
    },
    required: ['terminalId', 'data'],
  }
  readonly isReadOnly = false

  constructor(private readonly manager: TerminalManager) {}

  async execute(input: Record<string, unknown>): Promise<ExecuteResult> {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    const data = typeof input.data === 'string' ? input.data : ''
    if (!terminalId) return { output: '缺少 terminalId', isError: true }
    const ok = this.manager.write(terminalId, data)
    if (!ok) return { output: `terminal ${terminalId} 不存在`, isError: true }
    return { output: 'ok', isError: false }
  }
}

/** TerminalResize — 调整 PTY 大小 */
export class TerminalResizeTool implements HandTool {
  readonly name = 'TerminalResize'
  readonly description = '调整指定 terminalId 的 PTY 大小'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      terminalId: { type: 'string' },
      cols: { type: 'number' },
      rows: { type: 'number' },
    },
    required: ['terminalId', 'cols', 'rows'],
  }
  readonly isReadOnly = false

  constructor(private readonly manager: TerminalManager) {}

  async execute(input: Record<string, unknown>): Promise<ExecuteResult> {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    const cols = typeof input.cols === 'number' ? Math.floor(input.cols) : 0
    const rows = typeof input.rows === 'number' ? Math.floor(input.rows) : 0
    if (!terminalId) return { output: '缺少 terminalId', isError: true }
    if (cols <= 0 || rows <= 0) return { output: 'cols/rows 必须 > 0', isError: true }
    const ok = this.manager.resize(terminalId, cols, rows)
    if (!ok) return { output: `terminal ${terminalId} 不存在`, isError: true }
    return { output: 'ok', isError: false }
  }
}

/** TerminalKill — 终止 PTY 进程 */
export class TerminalKillTool implements HandTool {
  readonly name = 'TerminalKill'
  readonly description = '终止指定 terminalId 的 PTY 进程'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      terminalId: { type: 'string' },
    },
    required: ['terminalId'],
  }
  readonly isReadOnly = false

  constructor(private readonly manager: TerminalManager) {}

  async execute(input: Record<string, unknown>): Promise<ExecuteResult> {
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
    if (!terminalId) return { output: '缺少 terminalId', isError: true }
    const ok = this.manager.kill(terminalId)
    if (!ok) return { output: `terminal ${terminalId} 不存在`, isError: true }
    return { output: 'ok', isError: false }
  }
}

/** 创建 4 个 terminal 工具实例，共享同一个 TerminalManager */
export function createTerminalTools(manager: TerminalManager): HandTool[] {
  return [
    new TerminalSpawnTool(manager),
    new TerminalWriteTool(manager),
    new TerminalResizeTool(manager),
    new TerminalKillTool(manager),
  ]
}
