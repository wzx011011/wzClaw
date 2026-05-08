import type { SessionTaskState, SessionTaskStatus } from '../../shared/types'

export type SessionTaskStateChangedListener = (state: SessionTaskState) => void

export const ACTIVE_SESSION_TASK_STATUSES = new Set<SessionTaskStatus>([
  'starting',
  'running',
  'waiting_permission',
  'waiting_user',
  'stopping',
])

export function isActiveSessionTaskStatus(status: SessionTaskStatus): boolean {
  return ACTIVE_SESSION_TASK_STATUSES.has(status)
}

export interface SessionTaskStatePatch {
  status?: SessionTaskStatus
  phase?: string | null
  message?: string | null
  error?: string | null
  recoverable?: boolean | null
  persistedMessageCount?: number
  completedAt?: number | null
}

export class SessionTaskStateManager {
  private states = new Map<string, SessionTaskState>()
  private listeners = new Set<SessionTaskStateChangedListener>()

  onChanged(listener: SessionTaskStateChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(sessionId: string, runId: string, message?: string): SessionTaskState {
    const now = Date.now()
    return this.set(sessionId, {
      sessionId,
      runId,
      status: 'starting',
      phase: 'starting',
      message: message ?? 'Starting',
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      recoverable: null,
      persistedMessageCount: 0,
    })
  }

  update(sessionId: string, patch: SessionTaskStatePatch): SessionTaskState | null {
    const current = this.states.get(sessionId)
    if (!current) return null
    const now = Date.now()
    return this.set(sessionId, {
      ...current,
      ...patch,
      phase: patch.phase === undefined ? current.phase : patch.phase,
      message: patch.message === undefined ? current.message : patch.message,
      error: patch.error === undefined ? current.error : patch.error,
      recoverable: patch.recoverable === undefined ? current.recoverable : patch.recoverable,
      completedAt: patch.completedAt === undefined ? current.completedAt : patch.completedAt,
      updatedAt: now,
    })
  }

  finish(sessionId: string, status: Extract<SessionTaskStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>, patch: Omit<SessionTaskStatePatch, 'status' | 'completedAt'> = {}): SessionTaskState | null {
    const current = this.states.get(sessionId)
    if (!current) return null
    const now = Date.now()
    return this.set(sessionId, {
      ...current,
      ...patch,
      status,
      phase: patch.phase === undefined ? status : patch.phase,
      message: patch.message === undefined ? status : patch.message,
      error: patch.error === undefined ? current.error : patch.error,
      recoverable: patch.recoverable === undefined ? current.recoverable : patch.recoverable,
      completedAt: now,
      updatedAt: now,
    })
  }

  get(sessionId: string): SessionTaskState | null {
    return this.states.get(sessionId) ?? null
  }

  snapshot(): Record<string, SessionTaskState> {
    return Object.fromEntries(this.states)
  }

  listActive(): SessionTaskState[] {
    return Array.from(this.states.values()).filter(state => isActiveSessionTaskStatus(state.status))
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId)
  }

  clearAll(): void {
    this.states.clear()
  }

  private set(sessionId: string, state: SessionTaskState): SessionTaskState {
    this.states.set(sessionId, state)
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (err) {
        console.error('[SessionTaskStateManager] listener error:', err)
      }
    }
    return state
  }
}
