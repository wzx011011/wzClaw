import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  include: z.string().optional()
})

// ============================================================
// GrepTool Implementation
// ============================================================

export class GrepTool implements Tool {
  readonly name = 'Grep'
  readonly description = `Search file contents by regex pattern. Returns matching lines with file path and line number.

Usage:
- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").
- Use the include parameter to filter by file type (e.g. "*.ts", "*.py").
- Skips hidden files/directories and node_modules automatically.
- Use this instead of Bash with grep/rg — this tool is optimized for the workspace.`
  readonly requiresApproval = false
  // 匹配结果行数可能极多，比全局默认 30K 更严格
  readonly maxResultSizeChars = 20_000
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for'
      },
      path: {
        type: 'string',
        description: 'Directory to search in (defaults to workingDirectory)'
      },
      include: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. "*.ts")'
      }
    },
    required: ['pattern']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    // Validate input
    const parsed = GrepInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { pattern, path: searchPath, include } = parsed.data
    const dir = searchPath || context.workingDirectory

    // Prevent ReDoS: limit pattern length
    if (pattern.length > 500) {
      return { output: 'Pattern too long (max 500 chars)', isError: true }
    }

    // Validate regex pattern
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
    } catch (err: unknown) {
      return {
        output: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      }
    }

    try {
      const includeRegex = include ? globToRegex(include) : null
      const results: string[] = []

      await searchDirectory(dir, dir, regex, includeRegex, results, context.onProgress)

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
 * Convert a simple glob pattern to a RegExp.
 * Handles: * -> [^/]*, ** -> .*, ? -> [^/]
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{DOUBLESTAR}}/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * 异步递归搜索目录中匹配正则的文件内容。
 * 使用 fs.promises 避免阻塞主进程事件循环。
 */
async function searchDirectory(
  rootDir: string,
  currentDir: string,
  regex: RegExp,
  includeRegex: RegExp | null,
  results: string[],
  onProgress?: (msg: string) => void
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
  } catch {
    return // Skip directories we can't read
  }

  for (const entry of entries) {
    // Skip hidden files/directories and common ignored directories
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue
    }

    const fullPath = path.join(currentDir, entry.name)

    if (entry.isDirectory()) {
      onProgress?.(`Scanning ${fullPath.replace(/\\/g, '/')}...`)
      await searchDirectory(rootDir, fullPath, regex, includeRegex, results, onProgress)
    } else if (entry.isFile()) {
      // Check include filter
      if (includeRegex && !includeRegex.test(entry.name)) {
        continue
      }

      try {
        const content = await fs.promises.readFile(fullPath, 'utf-8')
        const lines = content.split('\n')
        // Normalize to forward slashes for cross-platform output
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${relativePath}:${i + 1}:${lines[i]}`)
            if (results.join('\n').length > MAX_TOOL_RESULT_CHARS) {
              return // Stop early if output too large
            }
          }
        }
      } catch {
        // Skip files we can't read (binary, permission errors, etc.)
        continue
      }
    }
  }
}
