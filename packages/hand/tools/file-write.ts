// ============================================================
// FileWrite 工具 — 写入文件到 NAS 卷
// 支持：创建目录、追加模式、覆盖写入
// ============================================================

import { writeFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HandTool } from '../src/tool-executor.js'
import { assertPathInWorkspace } from '../src/path-guard.js'

/**
 * FileWriteTool — 写入/创建文件到 NAS 卷
 *
 * 功能:
 * - 写入内容到指定路径，返回写入字节数
 * - createDirs=true 时自动创建父目录
 * - append=true 使用追加模式，否则覆盖
 * - 容器内无严格路径限制
 */
export class FileWriteTool implements HandTool {
  readonly name = 'FileWrite'
  readonly description = '写入/创建文件到 NAS 卷，支持创建目录和追加模式'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '写入内容' },
      createDirs: { type: 'boolean', description: '是否自动创建父目录' },
      append: { type: 'boolean', description: '追加模式（默认覆盖）' },
    },
    required: ['path', 'content'],
  }
  readonly isReadOnly = false

  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    // 校验必需参数
    const filePath = input.path
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }

    const content = input.content
    if (typeof content !== 'string') {
      return { output: '缺少 content 参数', isError: true }
    }

    // 路径白名单校验
    const violation = assertPathInWorkspace(filePath, context)
    if (violation) return violation

    try {
      const shouldAppend = input.append === true
      const shouldCreateDirs = input.createDirs === true

      // 创建父目录（如果需要）
      if (shouldCreateDirs) {
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })
      }

      // 写入文件
      if (shouldAppend) {
        await appendFile(filePath, content, 'utf-8')
      } else {
        await writeFile(filePath, content, 'utf-8')
      }

      // 计算字节数（UTF-8 编码下的字节长度）
      const byteLength = Buffer.byteLength(content, 'utf-8')
      return {
        output: `Successfully wrote ${byteLength} bytes to ${filePath}`,
        isError: false,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: message, isError: true }
    }
  }
}
