import { describe, expect, it } from 'vitest'
import { SessionTaskStateManager, isActiveSessionTaskStatus } from '../session-task-state-manager'

describe('SessionTaskStateManager', () => {
  it('emits lifecycle state changes with run metadata', () => {
    const manager = new SessionTaskStateManager()
    const seen: string[] = []
    manager.onChanged(state => seen.push(`${state.sessionId}:${state.status}:${state.phase}`))

    const started = manager.start('s1', 'run-1')
    expect(started.status).toBe('starting')
    expect(started.runId).toBe('run-1')

    manager.update('s1', { status: 'running', phase: 'streaming', message: 'Streaming' })
    const finished = manager.finish('s1', 'completed', { persistedMessageCount: 3 })

    expect(finished?.status).toBe('completed')
    expect(finished?.completedAt).toBeTypeOf('number')
    expect(finished?.persistedMessageCount).toBe(3)
    expect(seen).toEqual([
      's1:starting:starting',
      's1:running:streaming',
      's1:completed:completed',
    ])
  })

  it('classifies active and terminal statuses', () => {
    expect(isActiveSessionTaskStatus('running')).toBe(true)
    expect(isActiveSessionTaskStatus('waiting_user')).toBe(true)
    expect(isActiveSessionTaskStatus('stopping')).toBe(true)
    expect(isActiveSessionTaskStatus('completed')).toBe(false)
    expect(isActiveSessionTaskStatus('failed')).toBe(false)
  })
})
