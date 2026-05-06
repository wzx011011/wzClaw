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

      await matchDirectory(dir, dir, regex, results, context.onProgress)

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
 * 异步递归遍历目录，收集匹配的文件路径。
 * 使用 fs.promises 避免阻塞主进程事件循环。
 */
async function matchDirectory(
  rootDir: string,
  currentDir: string,
  regex: RegExp,
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
    // Normalize to forward slashes for cross-platform glob matching
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      // Check if the directory path itself matches (for ** patterns)
      if (regex.test(relativePath + '/')) {
        results.push(relativePath + '/')
      }
      onProgress?.(`Scanning ${fullPath.replace(/\\/g, '/')}...`)
      await matchDirectory(rootDir, fullPath, regex, results, onProgress)
    } else if (entry.isFile()) {
      if (regex.test(relativePath)) {
        results.push(relativePath)
        if (results.join('\n').length > MAX_TOOL_RESULT_CHARS) {
          return // Stop early if output too large
        }
      }
    }
  }
}
