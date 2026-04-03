import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

export class FileReadTool implements Tool {
  readonly name = 'FileRead'
  readonly description = 'Read the contents of a file. Returns file content with line numbers.'
  readonly inputSchema: Record<string, unknown> = {}
  readonly requiresApproval = false

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return { output: 'not implemented', isError: true }
  }
}
