// ============================================================
// TaskOutput Tool — 获取后台 Bash 任务的状态和输出
// ============================================================

import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { BackgroundTaskManager } from '../tasks/background-task-manager'

const TaskOutputSchema = z.object({
  task_id: z.string().describe('The background task ID returned by Bash with run_in_background=true'),
})

export class TaskOutputTool implements Tool {
  readonly name = 'TaskOutput'
  readonly description = 'Get the output and status of a background task started with Bash run_in_background=true. Returns current output (may be partial if still running), status, and exit code.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task ID' },
    },
    required: ['task_id'],
  }

  constructor(private backgroundTaskManager: BackgroundTaskManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = TaskOutputSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: task_id is required`, isError: true }
    }
    const result = this.backgroundTaskManager.getTaskOutput(parsed.data.task_id)
    if (!result) {
      return { output: `Task ${parsed.data.task_id} not found. It may have been cleaned up or the ID is incorrect.`, isError: true }
    }
    const statusLine = `Status: ${result.status}${result.exitCode !== null ? ` (exit code: ${result.exitCode})` : ''}`
    return {
      output: result.output ? `${statusLine}\n\n${result.output}` : `${statusLine}\n(no output yet)`,
      isError: result.status === 'error',
    }
  }
}
