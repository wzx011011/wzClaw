import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import {
  type LineEndingType,
  detectLineEndings,
  normalizeLineEndings,
  detectLineEndingsForNewFile,
} from './file-utils'

// ============================================================
// FileWrite Tool (per TOOL-02, D-32)
// 行尾检测 + 归一化已迁移到 file-utils.ts 共享模块
// ============================================================

const FileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export class FileWriteTool implements Tool {
  readonly name = 'FileWrite'
  readonly requiresSnapshot = true
  readonly description = `Create or overwrite a file with the given content. Creates parent directories if they do not exist.

Usage:
- This tool overwrites the entire file. Prefer FileEdit for modifying existing files — it only changes the diff.
- Use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested.
- Do not write files that contain secrets (.env, credentials, API keys).`
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path to write',
      },
      content: {
        type: 'string',
        description: 'File content to write',
      },
    },
    required: ['path', 'content'],
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const parsed = FileWriteSchema.safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0] ?? 'input'
      return { output: `Invalid input: ${field} is required`, isError: true }
    }

    const { path: filePath, content } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, filePath)

    // Workspace boundary check — allow writes within any projectRoot (multi-folder Task support)
    const allowedRoots = context.projectRoots?.length
      ? context.projectRoots
      : [context.workingDirectory]
    const normalizedPath = absolutePath.toLowerCase()
    const isWithinWorkspace = allowedRoots.some((root) => {
      const normalized = path.resolve(root).toLowerCase()
      return normalizedPath.startsWith(normalized + path.sep) || normalizedPath === normalized
    })
    if (!isWithinWorkspace) {
      return { output: `Blocked: FileWrite target is outside workspace boundary: ${absolutePath}`, isError: true }
    }

    try {
      const dir = path.dirname(absolutePath)
      await fs.mkdir(dir, { recursive: true })

      // 检测目标行尾：已有文件 → 检测；新文件 → .gitattributes；兜底 → LF
      let targetEol: LineEndingType = 'LF'
      try {
        const existing = await fs.readFile(absolutePath, 'utf-8')
        targetEol = detectLineEndings(existing)
      } catch {
        // 文件不存在 — 检查 .gitattributes
        targetEol = detectLineEndingsForNewFile(dir)
      }

      const adaptedContent = normalizeLineEndings(content, targetEol)
      await fs.writeFile(absolutePath, adaptedContent, 'utf-8')

      const byteCount = Buffer.byteLength(adaptedContent, 'utf-8')
      return {
        output: `File written: ${absolutePath} (${byteCount} bytes)`,
        isError: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { output: message, isError: true }
    }
  }
}
