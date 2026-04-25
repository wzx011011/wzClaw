import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// FileEdit Tool (per TOOL-03, D-32)
// ============================================================

const FileEditSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string()
})

export class FileEditTool implements Tool {
  readonly name = 'FileEdit'
  readonly description = `Edit a file by replacing an exact string match.

Usage:
- You MUST read the file with FileRead first before editing. The old_string must match exactly including whitespace and indentation.
- The old_string must be unique in the file. If it matches multiple times, provide more surrounding context to make it unique.
- ALWAYS prefer editing existing files over creating new ones.
- When editing text from FileRead output, preserve the exact indentation. The line number prefix format is: number + tab. Everything after the tab is the actual content to match.
- The edit will FAIL if old_string is not found or not unique.`
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path to edit'
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find in the file (must be unique)'
      },
      new_string: {
        type: 'string',
        description: 'Replacement text'
      }
    },
    required: ['path', 'old_string', 'new_string']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = FileEditSchema.safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0] ?? 'input'
      return {
        output: `Invalid input: ${field} is required`,
        isError: true
      }
    }

    const { path: filePath, old_string, new_string } = parsed.data
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
      const content = await fs.readFile(absolutePath, 'utf-8')

      // Count occurrences to ensure uniqueness (per D-03 race condition protection)
      let matchCount = 0
      let searchIndex = 0
      while (true) {
        const index = content.indexOf(old_string, searchIndex)
        if (index === -1) break
        matchCount++
        searchIndex = index + 1
      }

      if (matchCount === 0) {
        return {
          output: `old_string not found in file: ${absolutePath}`,
          isError: true
        }
      }

      if (matchCount > 1) {
        return {
          output: `old_string matches ${matchCount} times in file. Provide more context to make it unique.`,
          isError: true
        }
      }

      // Exactly one match: perform the replacement
      const newContent = content.replace(old_string, new_string)
      await fs.writeFile(absolutePath, newContent, 'utf-8')

      return {
        output: `Edited ${absolutePath}: replaced ${old_string.length} chars with ${new_string.length} chars`,
        isError: false
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { output: message, isError: true }
    }
  }
}
