// ============================================================
// MultiEdit 工具 — 在一个文件中执行多次替换
// 按顺序应用多组 oldString→newString 替换
// ============================================================

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HandTool } from '../src/tool-executor.js'

interface EditOp {
  oldString: string
  newString: string
}

export class MultiEditTool implements HandTool {
  readonly name = 'MultiEdit'
  readonly description = '在一个文件中执行多组字符串替换编辑'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      edits: {
        type: 'array',
        description: '替换操作数组 [{oldString, newString}]',
        items: {
          type: 'object',
          properties: {
            oldString: { type: 'string' },
            newString: { type: 'string' },
          },
          required: ['oldString', 'newString'],
        },
      },
    },
    required: ['path', 'edits'],
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
    // 校验路径是否在允许范围内
    const resolved = path.resolve(filePath)
    const allowedRoots = context.projectRoots.length > 0 ? context.projectRoots : [context.workingDirectory]
    if (!allowedRoots.some(root => resolved.startsWith(root + '/') || resolved === root)) {
      return { output: `路径不在允许范围内: ${filePath}`, isError: true }
    }
    const edits = input.edits
    if (!Array.isArray(edits) || edits.length === 0) {
      return { output: '缺少 edits 参数或为空', isError: true }
    }

    // 校验每个 edit
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i] as Record<string, unknown>
      if (typeof edit.oldString !== 'string' || typeof edit.newString !== 'string') {
        return { output: `edits[${i}] 缺少 oldString 或 newString`, isError: true }
      }
    }

    try {
      let content = await readFile(filePath, 'utf-8')
      let totalCount = 0

      for (const edit of edits as EditOp[]) {
        if (!content.includes(edit.oldString)) {
          return {
            output: `未找到匹配文本 (edit ${totalCount + 1}): ${edit.oldString.slice(0, 100)}`,
            isError: true,
          }
        }
        const idx = content.indexOf(edit.oldString)
        if (idx !== content.lastIndexOf(edit.oldString)) {
          return {
            output: `edit ${totalCount + 1} 有多处匹配，请使用更精确的 oldString`,
            isError: true,
          }
        }
        content = content.substring(0, idx) + edit.newString + content.substring(idx + edit.oldString.length)
        totalCount++
      }

      await writeFile(filePath, content, 'utf-8')
      return { output: `多组替换成功: ${totalCount} 处`, isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
