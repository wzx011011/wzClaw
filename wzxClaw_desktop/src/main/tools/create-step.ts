import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { StepManager } from '../steps/step-manager'

// ============================================================
// Input Schema
// ============================================================

const CreateStepInputSchema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
  blockedBy: z.array(z.string()).optional()
})

// ============================================================
// CreateStepTool — allows agent to create steps
// (per TASK-01)
// ============================================================

export class CreateStepTool implements Tool {
  readonly name = 'CreateStep'
  readonly description =
    'Create a new step with a subject, description, and optional dependencies. Returns the created step details.'
  readonly requiresApproval = false
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short step title' },
      description: { type: 'string', description: 'Detailed step description' },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of steps that must complete before this one can start'
      }
    },
    required: ['subject']
  }

  constructor(
    private stepManager: StepManager,
    private senderFn?: () => Electron.WebContents | null
  ) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = CreateStepInputSchema.safeParse(input)
    if (!parsed.success) {
      return { output: `Invalid input: ${parsed.error.message}`, isError: true }
    }

    const { subject, description, blockedBy } = parsed.data
    const step = this.stepManager.createStep(subject, description ?? '', blockedBy ?? [])

    // Forward step:created event to renderer
    const sender = this.senderFn?.()
    sender?.send('step:created', step)

    return { output: JSON.stringify(step, null, 2), isError: false }
  }
}
