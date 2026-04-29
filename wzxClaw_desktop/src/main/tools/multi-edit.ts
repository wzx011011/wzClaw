import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// Input Schema
// ============================================================

const SingleEditSchema = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false)
})

const MultiEditInputSchema = z.object({
  file_path: z.string().min(1),
  edits: z.array(SingleEditSchema).min(1).max(20)
})

// ============================================================
// Helper
// ============================================================

/** 统计 old_string 在 content 中出现的次数 */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let idx = 0
  while (true) {
    idx = content.indexOf(search, idx)
    if (idx === -1) break
    count++
    idx += search.length
  }
  return count
}

// ============================================================
// MultiEditTool — 同一文件多处原子编辑
// ============================================================

export class MultiEditTool implements Tool {
  readonly name = 'MultiEdit'
  readonly description = [
    'Perform multiple find-and-replace operations on a single file atomically.',
    'All edits are applied sequentially to the same content buffer.',
    'If ANY edit fails (not found, or not unique), NO changes are written.',
    'You MUST read the file with FileRead first before editing.',
    'Use `replace_all: true` to replace every occurrence (skips uniqueness check).',
    'Prefer this tool over FileEdit when making 2+ edits to the same file.'
  ].join(' ')
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit'
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations (max 20). Applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Text to find (must be unique unless replace_all)' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' }
          },
          required: ['old_string', 'new_string']
        }
      }
    },
    required: ['file_path', 'edits']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = MultiEditInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        isError: true
      }
    }

    const { file_path, edits } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, file_path)

    // 工作区边界检查
    const normalizedPath = path.normalize(absolutePath).toLowerCase()
    const allowedRoots = (context.projectRoots ?? [context.workingDirectory]).map(
      (r) => path.normalize(r).toLowerCase()
    )
    if (!allowedRoots.some((root) => normalizedPath.startsWith(root))) {
      return {
        output: `Access denied: path outside workspace (${file_path})`,
        isError: true
      }
    }

    // 读取文件
    let content: string
    try {
      content = await fs.readFile(absolutePath, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Failed to read file: ${msg}`, isError: true }
    }

    // 在内存缓冲区上顺序应用编辑
    const originalContent = content
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]

      if (edit.replace_all) {
        const count = countOccurrences(content, edit.old_string)
        if (count === 0) {
          return {
            output: `Edit #${i + 1} failed: old_string not found in file. No changes were made.`,
            isError: true
          }
        }
        content = content.replaceAll(edit.old_string, edit.new_string)
      } else {
        const count = countOccurrences(content, edit.old_string)
        if (count === 0) {
          return {
            output: `Edit #${i + 1} failed: old_string not found in file. No changes were made.`,
            isError: true
          }
        }
        if (count > 1) {
          return {
            output: `Edit #${i + 1} failed: old_string matches ${count} times (not unique). Provide more surrounding context or use replace_all. No changes were made.`,
            isError: true
          }
        }
        content = content.replace(edit.old_string, edit.new_string)
      }
    }

    // 写回
    try {
      await fs.writeFile(absolutePath, content, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Failed to write file: ${msg}`, isError: true }
    }

    const editCount = edits.length
    const bytesChanged = Math.abs(Buffer.byteLength(content, 'utf-8') - Buffer.byteLength(originalContent, 'utf-8'))
    return {
      output: `Applied ${editCount} edit(s) to ${file_path} (${bytesChanged} bytes changed)`,
      isError: false
    }
  }
}
