import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import {
  type LineEndingType,
  detectLineEndings,
  writeWithLineEndings,
  findActualString,
  preserveQuoteStyle,
  applyDesanitizationToNewString,
  normalizeLineEndings,
  countOccurrences,
} from './file-utils'

// ============================================================
// Input Schema
// ============================================================

const SingleEditSchema = z.object({
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false),
})

const MultiEditInputSchema = z.object({
  file_path: z.string().min(1),
  edits: z.array(SingleEditSchema).min(1).max(20),
})

// ============================================================
// MultiEditTool — 同一文件多处原子编辑
// 修复：CRLF 归一化 + 多层匹配回退（与 FileEdit 一致）
// ============================================================

export class MultiEditTool implements Tool {
  readonly name = 'MultiEdit'
  readonly requiresSnapshot = true
  readonly description = [
    'Perform multiple find-and-replace operations on a single file atomically.',
    'All edits are applied sequentially to the same content buffer.',
    'If ANY edit fails (not found, or not unique), NO changes are written.',
    'You MUST read the file with FileRead first before editing.',
    'Use `replace_all: true` to replace every occurrence (skips uniqueness check).',
    'Prefer this tool over FileEdit when making 2+ edits to the same file.',
  ].join(' ')
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations (max 20). Applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Text to find (must be unique unless replace_all)' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const parsed = MultiEditInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        isError: true,
      }
    }

    const { file_path, edits } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, file_path)

    // 工作区边界检查 — allow edits within any projectRoot (multi-folder Task support)
    const allowedRoots = context.projectRoots?.length
      ? context.projectRoots
      : [context.workingDirectory]
    const normalizedPath = absolutePath.toLowerCase()
    const isWithinWorkspace = allowedRoots.some((root) => {
      const normalized = path.resolve(root).toLowerCase()
      return normalizedPath.startsWith(normalized + path.sep) || normalizedPath === normalized
    })
    if (!isWithinWorkspace) {
      return {
        output: `Access denied: path outside workspace (${file_path})`,
        isError: true,
      }
    }

    // 读取文件
    let rawContent: string
    try {
      rawContent = await fs.readFile(absolutePath, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Failed to read file: ${msg}`, isError: true }
    }

    // 检测原始行尾风格（写入时还原）
    const originalLineEndings: LineEndingType = detectLineEndings(rawContent)

    // CRLF → LF 归一化：与 FileEdit 一致，匹配在 LF 空间进行
    let content = rawContent.replace(/\r\n/g, '\n')

    // 在内存缓冲区上顺序应用编辑
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]
      const normalizedOld = edit.old_string.replace(/\r\n/g, '\n')
      const normalizedNew = edit.new_string.replace(/\r\n/g, '\n')

      // 多层匹配回退：精确 → 引号归一化 → 反消毒
      const match = findActualString(content, normalizedOld)
      if (!match) {
        return {
          output: `Edit #${i + 1} failed: old_string not found in file. No changes were made.`,
          isError: true,
        }
      }
      const { actualString: actualOldString, desanitizations } = match

      // 保留引号风格 + 反消毒同步
      let actualNewString = preserveQuoteStyle(normalizedOld, actualOldString, normalizedNew)
      actualNewString = applyDesanitizationToNewString(actualNewString, desanitizations)

      const matchCount = countOccurrences(content, actualOldString)

      if (matchCount === 0) {
        return {
          output: `Edit #${i + 1} failed: old_string not found in file. No changes were made.`,
          isError: true,
        }
      }

      if (!edit.replace_all && matchCount > 1) {
        return {
          output: `Edit #${i + 1} failed: old_string matches ${matchCount} times (not unique). Provide more surrounding context or use replace_all. No changes were made.`,
          isError: true,
        }
      }

      // 执行替换
      if (edit.replace_all) {
        content = content.replaceAll(actualOldString, actualNewString)
      } else {
        content = content.replace(actualOldString, actualNewString)
      }
    }

    // 写回，还原原始行尾风格
    try {
      await writeWithLineEndings(absolutePath, content, originalLineEndings)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Failed to write file: ${msg}`, isError: true }
    }

    const originalBytes = Buffer.byteLength(rawContent, 'utf-8')
    const newBytes = Buffer.byteLength(normalizeLineEndings(content, originalLineEndings), 'utf-8')
    const bytesChanged = Math.abs(newBytes - originalBytes)
    return {
      output: `Applied ${edits.length} edit(s) to ${file_path} (${bytesChanged} bytes changed)`,
      isError: false,
    }
  }
}
