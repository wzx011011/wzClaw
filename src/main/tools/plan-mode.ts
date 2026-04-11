import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { PermissionManager } from '../permission/permission-manager'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

// ============================================================
// PlanModeController — Manages the blocking decision for ExitPlanMode
// ============================================================

/**
 * Singleton-style controller that holds a pending Promise<boolean>
 * while ExitPlanMode waits for the user to approve or reject the plan.
 * The IPC handler for 'agent:plan-decision' calls resolveDecision().
 */
export class PlanModeController {
  private pendingResolve: ((approved: boolean) => void) | null = null

  waitForDecision(): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve
    })
  }

  resolveDecision(approved: boolean): void {
    if (this.pendingResolve) {
      this.pendingResolve(approved)
      this.pendingResolve = null
    }
  }

  hasPendingDecision(): boolean {
    return this.pendingResolve !== null
  }
}

// ============================================================
// EnterPlanMode Tool
// ============================================================

export class EnterPlanModeTool implements Tool {
  readonly name = 'EnterPlanMode'
  readonly description =
    'Request to enter planning mode — read-only analysis before making changes. ' +
    'Write operations (FileWrite, FileEdit, Bash) will be blocked until you call ExitPlanMode ' +
    'and the user approves your plan.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {}
  }

  constructor(
    private permissionManager: PermissionManager,
    private getSender: () => Electron.WebContents | null
  ) {}

  async execute(
    _input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    this.permissionManager.setPlanMode(true)

    const sender = this.getSender()
    if (sender && !sender.isDestroyed()) {
      sender.send(IPC_CHANNELS['agent:plan-mode-entered'])
    }

    return {
      output:
        'Entered plan mode. You may now read files and analyse the codebase. ' +
        'Call ExitPlanMode with your markdown plan when ready for user review.',
      isError: false
    }
  }
}

// ============================================================
// ExitPlanMode Tool
// ============================================================

const ExitPlanModeSchema = z.object({
  plan: z.string().min(1)
})

export class ExitPlanModeTool implements Tool {
  readonly name = 'ExitPlanMode'
  readonly description =
    'Exit planning mode by submitting your plan as markdown text. ' +
    'The plan will be shown to the user for approval. ' +
    'If approved, write operations are unblocked and you may proceed. ' +
    'If rejected, planning mode is cancelled.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Markdown text describing exactly what changes you will make and why'
      }
    },
    required: ['plan']
  }

  constructor(
    private permissionManager: PermissionManager,
    private getSender: () => Electron.WebContents | null,
    private controller: PlanModeController
  ) {}

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = ExitPlanModeSchema.safeParse(input)
    if (!parsed.success) {
      return { output: 'Invalid input: plan text is required', isError: true }
    }

    const { plan } = parsed.data

    // Send plan to renderer for display + approval UI
    const sender = this.getSender()
    if (sender && !sender.isDestroyed()) {
      sender.send(IPC_CHANNELS['agent:plan-mode-exited'], { plan })
    }

    // Block until the user makes a decision
    const approved = await this.controller.waitForDecision()

    // Always exit plan mode regardless of decision
    this.permissionManager.setPlanMode(false)

    if (!approved) {
      return {
        output: 'Plan rejected by user. Planning mode cancelled.',
        isError: true
      }
    }

    return {
      output: 'Plan approved, proceeding.',
      isError: false
    }
  }
}
