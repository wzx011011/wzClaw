import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// FileWrite Tool (per TOOL-02, D-32)
// ============================================================

const FileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string()
})

export class FileWriteTool implements Tool {
  readonly name = 'FileWrite'
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
        description: 'Absolute or relative file path to write'
      },
      content: {
        type: 'string',
        description: 'File content to write'
      }
    },
    required: ['path', 'content']
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = FileWriteSchema.safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0] ?? 'input'
      return { output: `Invalid input: ${field} is required`, isError: true }
    }

    const { path: filePath, content } = parsed.data
    const absolutePath = path.resolve(context.workingDirectory, filePath)

    // Workspace boundary check — log warning for out-of-workspace writes
    const normalizedWorkspace = path.resolve(context.workingDirectory)
    const isWithinWorkspace = absolutePath.startsWith(normalizedWorkspace + path.sep) || absolutePath === normalizedWorkspace
    if (!isWithinWorkspace) {
      console.warn(`[WorkspaceGuard] FileWrite outside workspace: ${absolutePath}`)
    }

    try {
      const dir = path.dirname(absolutePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')

      const byteCount = Buffer.byteLength(content, 'utf-8')
      return {
        output: `File written: ${absolutePath} (${byteCount} bytes)`,
        isError: false
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { output: message, isError: true }
    }
  }
}
