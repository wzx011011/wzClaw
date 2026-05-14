// ============================================================
// FileRead 工具 — 读取 NAS 卷上的文件内容
// 支持：行号输出、行范围截取、编码选择
// ============================================================

import { readFile } from 'node:fs/promises'
import type { HandTool } from '../src/tool-executor.js'

/**
 * FileReadTool — 读取 NAS 卷上的文件内容
 *
 * 功能:
 * - 读取指定路径的文件内容，输出带行号格式
 * - 支持 startLine/endLine 行范围截取
 * - 支持 encoding 参数（默认 utf-8）
 * - 文件不存在或无权限返回错误
 */
export class FileReadTool implements HandTool {
  readonly name = 'FileRead'
  readonly description = '读取 NAS 卷上的文件内容，支持行号范围和编码选择'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径（NAS 卷内）' },
      encoding: { type: 'string', description: '编码，默认 utf-8' },
      startLine: { type: 'number', description: '起始行号（可选）' },
      endLine: { type: 'number', description: '结束行号（可选）' },
    },
    required: ['path'],
  }
  readonly isReadOnly = true

  async execute(
    input: Record<string, unknown>,
    _context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    // 校验必需参数
    const filePath = input.path
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }

    try {
      // 读取文件
      const encoding = (typeof input.encoding === 'string' ? input.encoding : 'utf-8') as BufferEncoding
      const content = await readFile(filePath, encoding)

      // 空文件直接返回
      if (!content) {
        return { output: '', isError: false }
      }

      // 按行分割
      const lines = content.split('\n')

      // 处理行范围
      const startLine = typeof input.startLine === 'number' ? input.startLine : 1
      const endLine = typeof input.endLine === 'number' ? input.endLine : lines.length

      // 截取指定范围（行号从 1 开始）
      const sliced = lines.slice(startLine - 1, endLine)

      // 添加行号前缀
      const numbered = sliced
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n')

      return { output: numbered, isError: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: message, isError: true }
    }
  }
}
