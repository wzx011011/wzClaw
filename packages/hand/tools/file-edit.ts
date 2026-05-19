// ============================================================
// FileEdit 工具 — 精确字符串替换编辑文件
// 支持单次替换和全局替换
// ============================================================

import { readFile, writeFile } from 'node:fs/promises'
import type { HandTool } from '../src/tool-executor.js'
import { assertPathInWorkspace } from '../src/path-guard.js'

export class FileEditTool implements HandTool {
  readonly name = 'FileEdit'
  readonly description = '精确字符串替换编辑文件，支持全局替换'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      oldString: { type: 'string', description: '要替换的原始文本' },
      newString: { type: 'string', description: '替换后的文本' },
      replaceAll: { type: 'boolean', description: '替换所有匹配（默认只替换第一个）' },
    },
    required: ['path', 'oldString', 'newString'],
  }
  readonly isReadOnly = false

  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    const filePath = input.path
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }
    // 路径白名单校验
    const violation = assertPathInWorkspace(filePath, context)
    if (violation) return violation
    const oldString = input.oldString
    if (typeof oldString !== 'string') {
      return { output: '缺少 oldString 参数', isError: true }
    }
    const newString = input.newString
    if (typeof newString !== 'string') {
      return { output: '缺少 newString 参数', isError: true }
    }
    if (oldString === newString) {
      return { output: 'oldString 和 newString 相同，无需替换', isError: true }
    }

    try {
      const content = await readFile(filePath, 'utf-8')

      if (!content.includes(oldString)) {
        return { output: `未找到匹配文本: ${oldString.slice(0, 100)}`, isError: true }
      }

      const replaceAll = input.replaceAll === true
      let newContent: string
      let count: number

      if (replaceAll) {
        const parts = content.split(oldString)
        count = parts.length - 1
        newContent = parts.join(newString)
      } else {
        const idx = content.indexOf(oldString)
        if (idx !== content.lastIndexOf(oldString)) {
          return {
            output: `找到多处匹配 (${content.split(oldString).length - 1} 处)，请使用更精确的 oldString 或设置 replaceAll=true`,
            isError: true,
          }
        }
        count = 1
        newContent = content.substring(0, idx) + newString + content.substring(idx + oldString.length)
      }

      await writeFile(filePath, newContent, 'utf-8')
      return { output: `替换成功: ${count} 处`, isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
