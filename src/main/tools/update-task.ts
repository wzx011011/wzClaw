import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { TaskManager } from '../tasks/task-manager'

// ============================================================
// Input Schema
// ============================================================

const UpdateTaskInputSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  subject: z.string().optional(),
  description: z.string().optional()
})

// ============================================================
// UpdateTaskTool — allows agent to update task status
// (per TASK-02)
// ============================================================

export class UpdateTaskTool implements Tool {
  readonly name = 'UpdateTask'
  readonly description =
    'Update a task status, subject, or description. Set status to "in_progress" when starting work, "completed" when done.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'ID of the task to update' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'New status'
      },
      subject: { type: 'string', description: 'Updated subject' },
      description: { type: 'string', description: 'Updated description' }
    },
    required: ['taskId']
  }

  constructor(
    private taskManager: TaskManager,
    private senderFn?: () => Electron.WebContents | null
  ) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = UpdateTaskInputSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const { taskId, status, subject, description } = parsed.data
    const updates: Record<string, unknown> = {}
    if (status !== undefined) updates.status = status
    if (subject !== undefined) updates.subject = subject
    if (description !== undefined) updates.description = description

    const result = this.taskManager.updateTask(
      taskId,
      updates as Parameters<typeof this.taskManager.updateTask>[1]
    )

    if (!result) {
      return { output: 'Task not found', isError: true }
    }

    // Forward task:updated event to renderer
    const sender = this.senderFn?.()
    sender?.send('task:updated', result)

    return { output: JSON.stringify(result, null, 2), isError: false }
  }
}
