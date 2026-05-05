import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { getSessionsDir } from '../paths'
import type { AgentStep, StepStatus } from '../../shared/types'

// ============================================================
// Step Event Types
// ============================================================

export type StepEvent =
  | { type: 'step:created'; step: AgentStep; sessionId: string }
  | { type: 'step:updated'; step: AgentStep; sessionId: string }

// ============================================================
// StepManager — session-isolated step management with persistence
// Steps are stored per-session in sessions/{hash}/{sessionId}.steps.json
// ============================================================

export class StepManager {
  /** Per-session steps: sessionId → Map<stepId, AgentStep> */
  private sessionSteps = new Map<string, Map<string, AgentStep>>()
  /** Per-session ID counter */
  private sessionNextId = new Map<string, number>()
  /** Active session ID — new steps are created in this session */
  private activeSessionId: string | null = null
  /** Base sessions directory for file persistence */
  private sessionsBaseDir: string | null = null
  private listeners: Set<(event: StepEvent) => void> = new Set()

  /**
   * Get the active session ID — used by tools to include in IPC events.
   */
  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  /**
   * Set the active session. All subsequent createStep/updateStep calls
   * operate on this session's steps unless explicitly overridden.
   */
  setActiveSession(sessionId: string): void {
    this.activeSessionId = sessionId
  }

  /**
   * Set the workspace root for file persistence.
   * Must be called before persistence operations.
   */
  setWorkspaceRoot(workspaceRoot: string): void {
    const crypto = require('crypto')
    const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 16)
    this.sessionsBaseDir = getSessionsDir(projectHash)
    fs.mkdirSync(this.sessionsBaseDir, { recursive: true })
  }

  /**
   * Get the steps file path for a session.
   */
  private getStepsFilePath(sessionId: string): string {
    if (!this.sessionsBaseDir) return ''
    return path.join(this.sessionsBaseDir, `${sessionId}.steps.json`)
  }

  /**
   * Ensure the session's step map exists in memory.
   */
  private ensureSession(sessionId: string): Map<string, AgentStep> {
    let steps = this.sessionSteps.get(sessionId)
    if (!steps) {
      steps = new Map()
      this.sessionSteps.set(sessionId, steps)
    }
    if (!this.sessionNextId.has(sessionId)) {
      this.sessionNextId.set(sessionId, 1)
    }
    return steps
  }

  /**
   * Get the effective session ID — uses activeSessionId if not explicitly provided.
   */
  private resolveSession(sessionId?: string): string {
    const sid = sessionId ?? this.activeSessionId
    if (!sid) throw new Error('No active session set for StepManager')
    return sid
  }

  createStep(subject: string, description: string, blockedBy: string[] = [], sessionId?: string): AgentStep {
    const sid = this.resolveSession(sessionId)
    const steps = this.ensureSession(sid)
    const nextId = this.sessionNextId.get(sid) ?? 1
    const id = `step-${nextId}`
    this.sessionNextId.set(sid, nextId + 1)

    const now = Date.now()

    // Determine initial status
    let status: StepStatus = 'pending'
    for (const blockerId of blockedBy) {
      const blocker = steps.get(blockerId)
      if (!blocker || blocker.status !== 'completed') {
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

    steps.set(id, step)
    this.emit({ type: 'step:created', step, sessionId: sid })
    // Debounced persist
    this.persistSteps(sid)
    return step
  }

  updateStep(
    stepId: string,
    updates: Partial<Pick<AgentStep, 'status' | 'subject' | 'description' | 'blockedBy'>>,
    sessionId?: string
  ): AgentStep | null {
    const sid = this.resolveSession(sessionId)
    const steps = this.sessionSteps.get(sid)
    if (!steps) return null

    const step = steps.get(stepId)
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
        const blocker = steps.get(blockerId)
        if (!blocker || blocker.status !== 'completed') {
          shouldBlock = true
          break
        }
      }
      if (shouldBlock && step.status !== 'blocked') {
        step.status = 'blocked'
      }
    }

    step.updatedAt = Date.now()
    this.emit({ type: 'step:updated', step, sessionId: sid })

    // If this step was just completed, check dependents for unblocking
    if (step.status === 'completed') {
      this.checkDependents(stepId, sid)
    }

    this.persistSteps(sid)
    return step
  }

  getStep(stepId: string, sessionId?: string): AgentStep | undefined {
    const sid = this.resolveSession(sessionId)
    return this.sessionSteps.get(sid)?.get(stepId)
  }

  /**
   * Get all steps for the active or specified session.
   */
  getAllSteps(sessionId?: string): AgentStep[] {
    const sid = this.resolveSession(sessionId)
    const steps = this.sessionSteps.get(sid)
    return steps ? Array.from(steps.values()) : []
  }

  /**
   * Clear steps for a specific session.
   */
  clearSession(sessionId: string): void {
    this.sessionSteps.delete(sessionId)
    this.sessionNextId.delete(sessionId)
    this.deletePersistedSteps(sessionId)
  }

  /**
   * Clear all sessions' steps.
   */
  clearAllSteps(): void {
    this.sessionSteps.clear()
    this.sessionNextId.clear()
  }

  /**
   * Load steps for a session from disk. Returns the loaded steps.
   */
  async loadSessionSteps(sessionId: string): Promise<AgentStep[]> {
    const filePath = this.getStepsFilePath(sessionId)
    if (!filePath) return []

    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []

      const steps = this.ensureSession(sessionId)
      steps.clear()

      let maxId = 0
      for (const step of parsed) {
        if (step.id && step.subject !== undefined) {
          steps.set(step.id, step as AgentStep)
          // Track max step ID to avoid collisions
          const numMatch = step.id.match(/^step-(\d+)$/)
          if (numMatch) {
            const num = parseInt(numMatch[1], 10)
            if (num >= maxId) maxId = num
          }
        }
      }
      this.sessionNextId.set(sessionId, maxId + 1)
      return Array.from(steps.values())
    } catch {
      return []
    }
  }

  /**
   * Persist steps for a session to disk (debounced).
   */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private persistSteps(sessionId: string): void {
    // Debounce: 500ms
    const existing = this.persistTimers.get(sessionId)
    if (existing) clearTimeout(existing)

    this.persistTimers.set(sessionId, setTimeout(() => {
      this.persistTimers.delete(sessionId)
      this._doPersist(sessionId)
    }, 500))
  }

  private async _doPersist(sessionId: string): Promise<void> {
    const filePath = this.getStepsFilePath(sessionId)
    if (!filePath) return

    const steps = this.sessionSteps.get(sessionId)
    if (!steps) return

    const data = Array.from(steps.values())
    try {
      const tmp = `${filePath}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
      await fsp.rename(tmp, filePath)
    } catch (err) {
      console.warn(`[steps] Failed to persist steps for session ${sessionId}:`, err)
    }
  }

  private async deletePersistedSteps(sessionId: string): Promise<void> {
    const filePath = this.getStepsFilePath(sessionId)
    if (!filePath) return
    try {
      await fsp.unlink(filePath)
    } catch { /* ignore */ }
  }

  onStepEvent(listener: (event: StepEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: StepEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private checkDependents(completedStepId: string, sessionId: string): void {
    const steps = this.sessionSteps.get(sessionId)
    if (!steps) return

    for (const [, step] of steps) {
      if (step.blockedBy.includes(completedStepId) && step.status === 'blocked') {
        const allCompleted = step.blockedBy.every((blockerId) => {
          const blocker = steps.get(blockerId)
          return blocker?.status === 'completed'
        })

        if (allCompleted) {
          step.status = 'pending'
          step.updatedAt = Date.now()
          this.emit({ type: 'step:updated', step, sessionId })
        }
      }
    }
  }
}

// Suppress unused import warning
void (0 as unknown as StepStatus)
