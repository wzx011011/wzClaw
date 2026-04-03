import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { MAX_FILE_READ_LINES, MAX_TOOL_RESULT_CHARS } from '../../shared/constants'

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
  readonly description = 'Read the contents of a file. Returns file content with line numbers.'
  readonly requiresApproval = false
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

    // Check file exists
    if (!fs.existsSync(absolutePath)) {
      return {
        output: `File not found: ${filePath}`,
        isError: true
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

      // Truncate at MAX_TOOL_RESULT_CHARS
      if (output.length > MAX_TOOL_RESULT_CHARS) {
        output = output.substring(0, MAX_TOOL_RESULT_CHARS)
      }

      return { output, isError: false }
    } catch (err: any) {
      return {
        output: err.message || String(err),
        isError: true
      }
    }
  }
}
