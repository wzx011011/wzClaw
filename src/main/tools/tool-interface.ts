import type { ToolDefinition } from '../../shared/types'

// ============================================================
// Tool Interface (per D-27)
// ============================================================

/**
 * 工具结果的单个内容块。
 * 支持文本、图片、错误三种类型，未来可扩展。
 */
export interface ToolResultContent {
  type: 'text' | 'image' | 'error'
  text?: string
  image?: { url: string; mimeType: string }
}

/**
 * Context passed to every tool execution.
 * Provides the working directory and optional abort signal.
 */
export interface ToolExecutionContext {
  workingDirectory: string
  /** Task ID if the agent is running within a Task. Used for task-scoped storage. */
  taskId?: string
  abortSignal?: AbortSignal
  /** 工具进度回调（可选） */
  onProgress?: (message: string) => void
}

/**
 * The result returned by every tool execution.
 *
 * 支持 `output` 为 string 或 ToolResultContent[]：
 * - string: 传统纯文本结果（向后兼容）
 * - ToolResultContent[]: 多块内容（文本 + 图片 + 错误混合）
 *
 * 工具可以按需返回任意一种格式。
 */
export interface ToolExecutionResult {
  output: string | ToolResultContent[]
  isError: boolean
}

/**
 * 将工具结果规范化为纯文本字符串。
 * string 直接返回；ToolResultContent[] 拼接所有 text/error 块。
 */
export function flattenToolOutput(output: string | ToolResultContent[]): string {
  if (typeof output === 'string') return output
  return output
    .filter(block => block.type === 'text' || block.type === 'error')
    .map(block => block.text ?? '')
    .join('\n')
}

/**
 * The interface every tool must implement.
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
 */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }
}
