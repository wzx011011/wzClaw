import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

export class GrepTool implements Tool {
  readonly name = 'Grep'
  readonly description = 'Search file contents by regex pattern. Returns matching lines with file path and line number.'
  readonly inputSchema: Record<string, unknown> = {}
  readonly requiresApproval = false

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return { output: 'not implemented', isError: true }
  }
}
