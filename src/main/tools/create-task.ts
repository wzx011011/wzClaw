import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { TaskManager } from '../tasks/task-manager'

// ============================================================
// Input Schema
// ============================================================

const CreateTaskInputSchema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
  blockedBy: z.array(z.string()).optional()
})

// ============================================================
// CreateTaskTool — allows agent to create tasks
// (per TASK-01)
// ============================================================

export class CreateTaskTool implements Tool {
  readonly name = 'CreateTask'
  readonly description =
    'Create a new task with a subject, description, and optional dependencies. Returns the created task details.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short task title' },
      description: { type: 'string', description: 'Detailed task description' },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of tasks that must complete before this one can start'
      }
    },
    required: ['subject']
  }

  constructor(
    private taskManager: TaskManager,
    private senderFn?: () => Electron.WebContents | null
  ) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = CreateTaskInputSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const { subject, description, blockedBy } = parsed.data
    const task = this.taskManager.createTask(subject, description ?? '', blockedBy ?? [])

    // Forward task:created event to renderer
    const sender = this.senderFn?.()
    sender?.send('task:created', task)

    return { output: JSON.stringify(task, null, 2), isError: false }
  }
}
