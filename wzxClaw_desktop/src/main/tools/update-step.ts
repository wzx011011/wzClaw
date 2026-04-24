import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { StepManager } from '../steps/step-manager'

// ============================================================
// Input Schema
// ============================================================

const UpdateStepInputSchema = z.object({
  stepId: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  subject: z.string().optional(),
  description: z.string().optional()
})

// ============================================================
// UpdateStepTool — allows agent to update step status
// (per TASK-02)
// ============================================================

export class UpdateStepTool implements Tool {
  readonly name = 'UpdateStep'
  readonly description =
    'Update a step status, subject, or description. Set status to "in_progress" when starting work, "completed" when done.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      stepId: { type: 'string', description: 'ID of the step to update' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'New status'
      },
      subject: { type: 'string', description: 'Updated subject' },
      description: { type: 'string', description: 'Updated description' }
    },
    required: ['stepId']
  }

  constructor(
    private stepManager: StepManager,
    private senderFn?: () => Electron.WebContents | null
  ) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = UpdateStepInputSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const { stepId, status, subject, description } = parsed.data
    const updates: Record<string, unknown> = {}
    if (status !== undefined) updates.status = status
    if (subject !== undefined) updates.subject = subject
    if (description !== undefined) updates.description = description

    const result = this.stepManager.updateStep(
      stepId,
      updates as Parameters<typeof this.stepManager.updateStep>[1]
    )

    if (!result) {
      return { output: 'Step not found', isError: true }
    }

    // Forward step:updated event to renderer
    const sender = this.senderFn?.()
    sender?.send('step:updated', result)

    return { output: JSON.stringify(result, null, 2), isError: false }
  }
}
