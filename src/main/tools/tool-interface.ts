import type { ToolDefinition } from '../../shared/types'

// ============================================================
// Tool Interface (per D-27)
// ============================================================

/**
 * Context passed to every tool execution.
 * Provides the working directory and optional abort signal.
 */
export interface ToolExecutionContext {
  workingDirectory: string
  abortSignal?: AbortSignal
}

/**
 * The result returned by every tool execution.
 * output contains the text result (or error message).
 * isError indicates whether the tool encountered an error.
 */
export interface ToolExecutionResult {
  output: string
  isError: boolean
}

/**
 * The interface every tool must implement.
 * Read-only tools have requiresApproval = false.
 * Destructive tools have requiresApproval = true.
 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly requiresApproval: boolean
  readonly isReadOnly?: boolean
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>
}

/**
 * Helper to extract ToolDefinition from a Tool instance.
 * Used to build the tools array for LLM Gateway StreamOptions.
 */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }
}
