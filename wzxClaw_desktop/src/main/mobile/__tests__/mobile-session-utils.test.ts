import { describe, expect, it } from 'vitest'
import { getMobileSessionTransition, isPathWithinWorkspace } from '../mobile-session-utils'

describe('getMobileSessionTransition', () => {
  it('restores history without resetting when bootstrapping an empty requested session', () => {
    expect(getMobileSessionTransition({
      requestedSessionId: 'session-b',
      activeSessionId: null,
      hasMessages: false,
      generatedSessionId: 'generated-id',
    })).toEqual({
      sessionId: 'session-b',
      shouldResetContext: false,
      shouldRestoreHistory: true,
    })
  })

  it('resets and restores when switching to a different requested session', () => {
    expect(getMobileSessionTransition({
      requestedSessionId: 'session-b',
      activeSessionId: 'session-a',
      hasMessages: true,
      generatedSessionId: 'generated-id',
    })).toEqual({
      sessionId: 'session-b',
      shouldResetContext: true,
      shouldRestoreHistory: true,
    })
  })

  it('keeps current context when continuing the active session', () => {
    expect(getMobileSessionTransition({
      requestedSessionId: 'session-a',
      activeSessionId: 'session-a',
      hasMessages: true,
      generatedSessionId: 'generated-id',
    })).toEqual({
      sessionId: 'session-a',
      shouldResetContext: false,
      shouldRestoreHistory: false,
    })
  })
})

describe('isPathWithinWorkspace', () => {
  it('allows nested workspace paths', () => {
    expect(isPathWithinWorkspace('C:/workspace/repo', 'C:/workspace/repo/src/index.ts')).toBe(true)
  })

  it('rejects sibling paths that only share a prefix', () => {
    expect(isPathWithinWorkspace('C:/workspace/repo', 'C:/workspace/repo2/secrets.txt')).toBe(false)
  })
})