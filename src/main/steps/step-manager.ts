import type { AgentStep, StepStatus } from '../../shared/types'

// ============================================================
// Step Event Types
// ============================================================

export type StepEvent =
  | { type: 'step:created'; step: AgentStep }
  | { type: 'step:updated'; step: AgentStep }

// ============================================================
// StepManager — manages agent steps with dependency tracking
// (per TASK-01 through TASK-05)
// ============================================================

export class StepManager {
  private steps: Map<string, AgentStep> = new Map()
  private listeners: Set<(event: StepEvent) => void> = new Set()
  private nextId: number = 1

  createStep(subject: string, description: string, blockedBy: string[] = []): AgentStep {
    const id = `step-${this.nextId++}`
    const now = Date.now()

    // Determine initial status: if any blockedBy step is not completed, set to 'blocked'
    let status: StepStatus = 'pending'
    for (const blockerId of blockedBy) {
      const blocker = this.steps.get(blockerId)
      if (blocker && blocker.status !== 'completed') {
        status = 'blocked'
        break
      }
      // If blocker doesn't exist yet, allow forward reference but treat as blocked
      if (!blocker) {
        status = 'blocked'
        break
      }
    }

    const step: AgentStep = {
      id,
      subject,
      description,
      status,
      blockedBy,
      createdAt: now,
      updatedAt: now
    }

    this.steps.set(id, step)
    this.emit({ type: 'step:created', step })
    return step
  }

  updateStep(
    stepId: string,
    updates: Partial<Pick<AgentStep, 'status' | 'subject' | 'description' | 'blockedBy'>>
  ): AgentStep | null {
    const step = this.steps.get(stepId)
    if (!step) return null

    // Apply updates
    if (updates.status !== undefined) step.status = updates.status
    if (updates.subject !== undefined) step.subject = updates.subject
    if (updates.description !== undefined) step.description = updates.description
    if (updates.blockedBy !== undefined) step.blockedBy = updates.blockedBy

    // Re-evaluate status if blockedBy was updated
    if (updates.blockedBy !== undefined) {
      let shouldBlock = false
      for (const blockerId of step.blockedBy) {
        const blocker = this.steps.get(blockerId)
        if (blocker && blocker.status !== 'completed') {
          shouldBlock = true
          break
        }
        if (!blocker) {
          shouldBlock = true
          break
        }
      }
      if (shouldBlock && step.status !== 'blocked') {
        step.status = 'blocked'
      }
    }

    step.updatedAt = Date.now()
    this.emit({ type: 'step:updated', step })

    // If this step was just completed, check dependents for unblocking
    if (step.status === 'completed') {
      this.checkDependents(stepId)
    }

    return step
  }

  getStep(id: string): AgentStep | undefined {
    return this.steps.get(id)
  }

  getAllSteps(): AgentStep[] {
    return Array.from(this.steps.values())
  }

  clearSteps(): void {
    this.steps.clear()
    this.nextId = 1
  }

  onStepEvent(listener: (event: StepEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Emit event to all subscribers */
  private emit(event: StepEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** When a step completes, unblock any dependents whose all blockers are now completed */
  private checkDependents(completedStepId: string): void {
    for (const [, step] of this.steps) {
      if (step.blockedBy.includes(completedStepId) && step.status === 'blocked') {
        const allCompleted = step.blockedBy.every((blockerId) => {
          const blocker = this.steps.get(blockerId)
          return blocker?.status === 'completed'
        })

        if (allCompleted) {
          step.status = 'pending'
          step.updatedAt = Date.now()
          this.emit({ type: 'step:updated', step })
        }
      }
    }
  }
}

// Suppress unused import warning
void (0 as unknown as StepStatus)
