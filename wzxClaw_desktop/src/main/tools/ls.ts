import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const LsInputSchema = z.object({
  path: z.string().min(1),
  ignore: z.array(z.string()).optional()
})

// ============================================================
// Helper: 简单模式匹配
// ============================================================

/** 检查文件名是否匹配 ignore 模式（支持精确名和 *.ext 后缀） */
function matchesIgnore(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      // *.log → 匹配后缀
      if (name.endsWith(pattern.slice(1))) return true
    } else {
      // 精确匹配
      if (name === pattern) return true
    }
  }
  return false
}

// ============================================================
// LsTool — 目录列表
// ============================================================

export class LsTool implements Tool {
  readonly name = 'LS'
  readonly description = [
    'List files and directories in a given path.',
    'The path parameter must be an absolute path.',
    'Returns grouped output with Directories and Files sections.',
    'Prefer Glob and Grep for searching — use LS to explore directory structure.'
  ].join(' ')
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the directory to list'
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to ignore (e.g. ["node_modules", "*.log"])'
      }
    },
    required: ['path']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = LsInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { path: dirPath, ignore = [] } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, dirPath)

    // 检查路径是否存在
    let stat: fs.Stats
    try {
      stat = fs.statSync(absolutePath)
    } catch {
      return { output: `Directory not found: ${absolutePath}`, isError: true }
    }

    if (!stat.isDirectory()) {
      return { output: `Not a directory: ${absolutePath}`, isError: true }
    }

    // 列出内容
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Failed to read directory: ${msg}`, isError: true }
    }

    // 过滤 + 排序
    const filtered = entries.filter((e) => !matchesIgnore(e.name, ignore))
    const dirs = filtered.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    const files = filtered.filter((e) => e.isFile()).map((e) => e.name).sort()

    // 格式化输出
    const lines: string[] = [`Directory: ${absolutePath}`, '']

    if (dirs.length > 0) {
      lines.push('Directories:')
      for (const d of dirs) {
        lines.push(`  ${d}/`)
      }
      lines.push('')
    }

    if (files.length > 0) {
      lines.push('Files:')
      for (const f of files) {
        lines.push(`  ${f}`)
      }
    }

    if (dirs.length === 0 && files.length === 0) {
      lines.push('(empty directory)')
    }

    let output = lines.join('\n')
    if (output.length > MAX_TOOL_RESULT_CHARS) {
      output = output.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... [truncated]'
    }

    return { output, isError: false }
  }
}
