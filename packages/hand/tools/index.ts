// ============================================================
// NAS Docker Hand 工具集合 — barrel exports
// 导出八个 NAS 工具类 + createNasTools() 工厂函数
// ============================================================

import { FileReadTool } from './file-read.js'
import { FileWriteTool } from './file-write.js'
import { FileListTool } from './file-list.js'
import { ShellExecuteTool } from './shell-execute.js'
import { GrepTool } from './grep.js'
import { GlobTool } from './glob.js'
import { FileEditTool } from './file-edit.js'
import { MultiEditTool } from './multi-edit.js'
import { createTerminalTools } from './terminal-tools.js'
import type { TerminalManager } from '../src/terminal-manager.js'
import type { HandTool } from '../src/tool-executor.js'

export { FileReadTool } from './file-read.js'
export { FileWriteTool } from './file-write.js'
export { FileListTool } from './file-list.js'
export { ShellExecuteTool } from './shell-execute.js'
export { GrepTool } from './grep.js'
export { GlobTool } from './glob.js'
export { FileEditTool } from './file-edit.js'
export { MultiEditTool } from './multi-edit.js'
export {
  TerminalSpawnTool,
  TerminalWriteTool,
  TerminalResizeTool,
  TerminalKillTool,
  createTerminalTools,
} from './terminal-tools.js'

/**
 * createNasTools — 创建 NAS Docker Hand 的全部工具实例
 *
 * @param terminalManager 可选的 TerminalManager 实例，提供时会附加 4 个 Terminal* 工具
 */
export function createNasTools(terminalManager?: TerminalManager): HandTool[] {
  const tools: HandTool[] = [
    new FileReadTool(),
    new FileWriteTool(),
    new FileListTool(),
    new ShellExecuteTool(),
    new GrepTool(),
    new GlobTool(),
    new FileEditTool(),
    new MultiEditTool(),
  ]
  if (terminalManager) {
    tools.push(...createTerminalTools(terminalManager))
  }
  return tools
}
