import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
})

// ============================================================
// GlobTool Implementation
// ============================================================

export class GlobTool implements Tool {
  readonly name = 'Glob'
  readonly description = `Find files matching a glob pattern. Returns matching file paths sorted by directory traversal order.

Usage:
- Supports patterns like "**/*.ts", "src/**/*.tsx", "*.json".
- Skips hidden files/directories and node_modules automatically.
- Use this instead of Bash with find/ls — this tool is optimized for the workspace.
- You can call multiple Glob tools in parallel to search for different patterns.`
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "**/*.ts", "*.json")'
      },
      path: {
        type: 'string',
        description: 'Directory to search in (defaults to workingDirectory)'
      }
    },
    required: ['pattern']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    // Validate input
    const parsed = GlobInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { pattern, path: searchPath } = parsed.data
    const dir = searchPath || context.workingDirectory

    try {
      const regex = globToRegex(pattern)
      const results: string[] = []

      // 传入中止信号和深度限制，防止超大型目录树导致极端延迟
      const opts: GlobTraversalOptions = {
        maxDepth: 15,
        abortSignal: context.abortSignal,
      }
      await matchDirectory(dir, dir, regex, results, context.onProgress, opts)

      let output = results.join('\n')

      // Truncate at MAX_TOOL_RESULT_CHARS
      if (output.length > MAX_TOOL_RESULT_CHARS) {
        output = output.substring(0, MAX_TOOL_RESULT_CHARS)
      }

      return { output, isError: false }
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true
      }
    }
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Convert a glob pattern to a RegExp.
 * Handles: ** -> .*, * -> [^/]*, ? -> [^/]
 * The pattern is matched against the relative path from rootDir.
 */
function globToRegex(glob: string): RegExp {
  // Escape regex special chars except *, ?, and /
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Handle **/ and /** sequences: ** matches zero or more path segments
    .replace(/\*\*\/?/g, '{{DOUBLESTAR_SLASH}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    // **/ should match zero or more directories (including zero)
    .replace(/\{\{DOUBLESTAR_SLASH\}\}/g, '(.*\\/)?')
  return new RegExp(`^${escaped}$`)
}

/**
 * 遍历选项：深度限制 + 中止信号。
 */
interface GlobTraversalOptions {
  maxDepth: number
  abortSignal?: AbortSignal
}

/**
 * 异步递归遍历目录，收集匹配的文件路径。
 * 使用 fs.promises 避免阻塞主进程事件循环。
 * 返回 totalLength 用于增量长度追踪，避免 O(n) 重复计算。
 */
async function matchDirectory(
  rootDir: string,
  currentDir: string,
  regex: RegExp,
  results: string[],
  onProgress?: (msg: string) => void,
  opts?: GlobTraversalOptions,
  currentDepth: number = 0,
  totalLength: number = 0,
): Promise<number> {
  // 在 readdir 前检查中止信号和深度限制
  if (opts?.abortSignal?.aborted) return totalLength
  if (opts && currentDepth >= opts.maxDepth) return totalLength

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
  } catch {
    return totalLength // 跳过无法读取的目录
  }

  for (const entry of entries) {
    // 每次循环开头检查中止信号和深度限制
    if (opts?.abortSignal?.aborted) return totalLength
    if (opts && currentDepth >= opts.maxDepth) return totalLength

    // 跳过隐藏文件/目录和常见忽略目录
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue
    }

    const fullPath = path.join(currentDir, entry.name)
    // 统一使用正斜杠，保证跨平台 glob 匹配
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      // 检查目录路径本身是否匹配（用于 ** 模式）
      if (regex.test(relativePath + '/')) {
        const dirEntry = relativePath + '/'
        results.push(dirEntry)
        totalLength += dirEntry.length + 1 // +1 换行符
        if (totalLength > MAX_TOOL_RESULT_CHARS) return totalLength
      }
      onProgress?.(`Scanning ${fullPath.replace(/\\/g, '/')}...`)
      totalLength = await matchDirectory(rootDir, fullPath, regex, results, onProgress, opts, currentDepth + 1, totalLength)
      if (totalLength > MAX_TOOL_RESULT_CHARS) return totalLength
    } else if (entry.isFile()) {
      if (regex.test(relativePath)) {
        results.push(relativePath)
        totalLength += relativePath.length + 1 // +1 换行符
        if (totalLength > MAX_TOOL_RESULT_CHARS) {
          return totalLength // 结果过大时提前终止
        }
      }
    }
  }

  return totalLength
}
