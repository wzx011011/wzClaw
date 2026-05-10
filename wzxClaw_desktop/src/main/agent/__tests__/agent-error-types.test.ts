import { describe, it, expect } from 'vitest'
import type { AgentErrorEvent } from '../types'

describe('AgentErrorEvent error codes', () => {
  it('accepts SAFETY_CEILING errorCode', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'Safety ceiling reached',
      recoverable: true,
      errorCode: 'SAFETY_CEILING',
    }
    expect(event.errorCode).toBe('SAFETY_CEILING')
    expect(event.recoverable).toBe(true)
  })

  it('accepts PROMPT_TOO_LONG errorCode', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'PromptTooLongError',
      recoverable: true,
      errorCode: 'PROMPT_TOO_LONG',
    }
    expect(event.errorCode).toBe('PROMPT_TOO_LONG')
  })

  it('accepts TOKEN_BUDGET errorCode', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'Token budget exceeded',
      recoverable: true,
      errorCode: 'TOKEN_BUDGET',
    }
    expect(event.errorCode).toBe('TOKEN_BUDGET')
  })

  it('accepts TURN_ERROR errorCode', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'Unexpected error in turn',
      recoverable: false,
      errorCode: 'TURN_ERROR',
    }
    expect(event.errorCode).toBe('TURN_ERROR')
    expect(event.recoverable).toBe(false)
  })

  it('accepts CANCELLED errorCode', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'Cancelled by user',
      recoverable: true,
      errorCode: 'CANCELLED',
    }
    expect(event.errorCode).toBe('CANCELLED')
  })

  it('errorCode is optional', () => {
    const event: AgentErrorEvent = {
      type: 'agent:error',
      error: 'Some error',
      recoverable: false,
    }
    expect(event.errorCode).toBeUndefined()
  })
})

describe('LangfuseObserver recordErrorCode integration', () => {
  it('AgentTraceContext stores lastErrorCode and exposes in metadata', async () => {
    // Import dynamically to avoid side effects
    const { AgentTraceContext: _Ctx } = await import('../../observability/langfuse-observer')
    // We just verify the module exports the class — actual integration
    // is tested via the agent-loop unit tests that check errorCode propagation
    expect(_Ctx).toBeDefined()
  })
})
