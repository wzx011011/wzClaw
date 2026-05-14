// ============================================================
// NAS Docker Hand 工具集合 — barrel exports
// 导出四个 NAS 工具类 + createNasTools() 工厂函数
// ============================================================

import { FileReadTool } from './file-read.js'
import { FileWriteTool } from './file-write.js'
import { FileListTool } from './file-list.js'
import { ShellExecuteTool } from './shell-execute.js'
import type { HandTool } from '../src/tool-executor.js'

export { FileReadTool } from './file-read.js'
export { FileWriteTool } from './file-write.js'
export { FileListTool } from './file-list.js'
export { ShellExecuteTool } from './shell-execute.js'

/**
 * createNasTools — 创建 NAS Docker Hand 的全部工具实例
 *
 * 返回四个工具实例:
 * - FileRead: 读取文件内容
 * - FileWrite: 写入文件
 * - FileList: 列出目录内容
 * - ShellExecute: 执行 shell 命令
 *
 * @returns HandTool 实例数组
 */
export function createNasTools(): HandTool[] {
  return [
    new FileReadTool(),
    new FileWriteTool(),
    new FileListTool(),
    new ShellExecuteTool(),
  ]
}
