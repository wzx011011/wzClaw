import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

export class GlobTool implements Tool {
  readonly name = 'Glob'
  readonly description = 'Find files matching a glob pattern. Returns matching file paths.'
  readonly inputSchema: Record<string, unknown> = {}
  readonly requiresApproval = false

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return { output: 'not implemented', isError: true }
  }
}
