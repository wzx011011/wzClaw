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
  countOccurrences,
} from './file-utils'

// ============================================================
// FileEdit Tool — 多层匹配 + replace_all
// 移植自 Claude Code 的 FileEditTool 匹配策略：
//   1. CRLF→LF 归一化（LLM 始终看到 LF）
//   2. findActualString 多层回退（精确 → 引号归一化 → 反消毒）
//   3. preserveQuoteStyle 保留文件原始引号风格
//   4. 写入时还原原始行尾
// ============================================================

const FileEditSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false),
})

export class FileEditTool implements Tool {
  readonly name = 'FileEdit'
  readonly requiresSnapshot = true
  readonly description = `Edit a file by replacing an exact string match.

Usage:
- You MUST read the file with FileRead first before editing. The old_string must match exactly including whitespace and indentation.
- The old_string must be unique in the file. If it matches multiple times, provide more surrounding context to make it unique, or set replace_all to true.
- Set replace_all to true to replace every occurrence (skips uniqueness check).
- ALWAYS prefer editing existing files over creating new ones.
- When editing text from FileRead output, preserve the exact indentation. The line number prefix format is: number + tab. Everything after the tab is the actual content to match.
- The edit will FAIL if old_string is not found or not unique.`
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path to edit',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find in the file (must be unique unless replace_all)',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const parsed = FileEditSchema.safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0] ?? 'input'
      return {
        output: `Invalid input: ${field} is required`,
        isError: true,
      }
    }

    const { path: filePath, old_string, new_string, replace_all } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, filePath)

    // Workspace boundary check — allow edits within any projectRoot (multi-folder Task support)
    const allowedRoots = context.projectRoots?.length
      ? context.projectRoots
      : [context.workingDirectory]
    const normalizedPath = absolutePath.toLowerCase()
    const isWithinWorkspace = allowedRoots.some((root) => {
      const normalized = path.resolve(root).toLowerCase()
      return normalizedPath.startsWith(normalized + path.sep) || normalizedPath === normalized
    })
    if (!isWithinWorkspace) {
      return { output: `Blocked: FileEdit target is outside workspace boundary: ${absolutePath}`, isError: true }
    }

    try {
      const rawContent = await fs.readFile(absolutePath, 'utf-8')

      // 检测原始行尾风格（写入时还原）
      const originalLineEndings: LineEndingType = detectLineEndings(rawContent)

      // CRLF → LF 归一化：LLM 从 FileRead 看到的始终是 LF，
      // old_string/new_string 也使用 LF，因此匹配在 LF 空间进行。
      const content = rawContent.replace(/\r\n/g, '\n')
      const normalizedOld = old_string.replace(/\r\n/g, '\n')
      const normalizedNew = new_string.replace(/\r\n/g, '\n')

      // 多层匹配回退：精确 → 引号归一化 → 反消毒
      const match = findActualString(content, normalizedOld)
      if (!match) {
        return {
          output: `old_string not found in file: ${absolutePath}`,
          isError: true,
        }
      }
      const { actualString: actualOldString, desanitizations } = match

      // 保留文件中的引号风格（弯引号 ↔ 直引号）+ 反消毒同步
      let actualNewString = preserveQuoteStyle(normalizedOld, actualOldString, normalizedNew)
      actualNewString = applyDesanitizationToNewString(actualNewString, desanitizations)

      // 唯一性检查
      const matchCount = countOccurrences(content, actualOldString)

      if (matchCount === 0) {
        return {
          output: `old_string not found in file: ${absolutePath}`,
          isError: true,
        }
      }

      if (matchCount > 1 && !replace_all) {
        return {
          output: `old_string matches ${matchCount} times in file. Provide more context to make it unique, or set replace_all to true.`,
          isError: true,
        }
      }

      // 执行替换（在 LF 归一化内容上操作）
      const newContentLF = replace_all
        ? content.replaceAll(actualOldString, actualNewString)
        : content.replace(actualOldString, actualNewString)

      // 写入时还原原始行尾风格
      await writeWithLineEndings(absolutePath, newContentLF, originalLineEndings)

      const replacedCount = replace_all ? matchCount : 1
      return {
        output: replace_all
          ? `Edited ${absolutePath}: replaced ${replacedCount} occurrences`
          : `Edited ${absolutePath}: replaced ${actualOldString.length} chars with ${actualNewString.length} chars`,
        isError: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { output: message, isError: true }
    }
  }
}
