import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { MAX_FILE_READ_LINES, MAX_FILE_READ_BYTES } from '../../shared/constants'

// ============================================================
// Input Schema
// ============================================================

const FileReadInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional()
})

// ============================================================
// FileReadTool Implementation
// ============================================================

export class FileReadTool implements Tool {
  readonly name = 'FileRead'
  readonly description = `Read the contents of a file. Returns file content with line numbers.

Usage:
- The path can be absolute or relative to the working directory.
- By default reads up to 2000 lines from the beginning of the file.
- Use offset and limit for large files to read specific sections.
- Results include line numbers starting at 1.
- Always read a file before editing it with FileEdit. FileEdit requires exact string matches — reading first ensures accuracy.
- You can call multiple FileRead tools in parallel to read several files at once.`
  readonly requiresApproval = false
  // FileRead 自己通过行数/字符限制管理输出大小，豁免通用截断
  readonly maxResultSizeChars = Infinity
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file to read' },
      offset: {
        type: 'number',
        description: '0-based line offset to start reading from'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read'
      }
    },
    required: ['path']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    // Validate input
    const parsed = FileReadInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { path: filePath, offset = 0, limit } = parsed.data

    // Resolve to absolute path if relative
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(context.workingDirectory, filePath)

    // Workspace boundary check — block out-of-workspace reads (case-insensitive on Windows)
    const normalizedWorkspace = path.resolve(context.workingDirectory).toLowerCase()
    const normalizedPath = absolutePath.toLowerCase()
    const isWithinWorkspace = normalizedPath.startsWith(normalizedWorkspace + path.sep) || normalizedPath === normalizedWorkspace
    if (!isWithinWorkspace) {
      return { output: `Blocked: FileRead target is outside workspace boundary: ${absolutePath}`, isError: true }
    }

    // Check file exists
    if (!fs.existsSync(absolutePath)) {
      return {
        output: `File not found: ${filePath}`,
        isError: true
      }
    }

    // 预读大小检查：超过 1MB 的文件直接提示使用 offset/limit 分段读取。
    // 仅在未指定 offset/limit 时执行：指定了分段参数就认为用户已知文件较大并主动进行分段。
    if (offset === 0 && limit === undefined) {
      const stat = await fs.promises.stat(absolutePath)
      if (stat.size > MAX_FILE_READ_BYTES) {
        const kb = Math.round(stat.size / 1024)
        return {
          output: `File too large to read in full (${kb}KB > ${MAX_FILE_READ_BYTES / 1024}KB limit). Use offset and limit parameters to read specific sections, e.g. offset=0 limit=200 for the first 200 lines.`,
          isError: false
        }
      }
    }

    try {
      // Read file content
      const content = await fs.promises.readFile(absolutePath, 'utf-8')
      const lines = content.split('\n')

      // Apply offset and limit, cap at MAX_FILE_READ_LINES
      const startLine = Math.max(0, offset)
      const maxLines = Math.min(
        limit ?? MAX_FILE_READ_LINES,
        MAX_FILE_READ_LINES
      )
      const endLine = Math.min(startLine + maxLines, lines.length)

      // Build numbered output
      const numberedLines: string[] = []
      for (let i = startLine; i < endLine; i++) {
        const lineNum = i + 1
        numberedLines.push(`${lineNum}\t${lines[i]}`)
      }

      let output = numberedLines.join('\n')

      return { output, isError: false }
    } catch (err: any) {
      return {
        output: err.message || String(err),
        isError: true
      }
    }
  }
}
