import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  evaluateTimeBasedTrigger,
  maybeTimeBasedMicrocompact,
  TOOL_RESULT_CLEARED_MESSAGE,
} from '../microcompact'
import type { Message } from '../../../shared/types'

// ---- Helpers ----

function makeAssistant(ts: number, toolCalls?: Array<{ id: string; name: string }>): Message {
  return {
    role: 'assistant',
    content: 'response',
    toolCalls: toolCalls ?? [],
    timestamp: ts,
  }
}

function makeUser(ts: number, content: string): Message {
  return { role: 'user', content, timestamp: ts }
}

function makeToolResult(ts: number, toolCallId: string, content: string): Message {
  return { role: 'tool_result', toolCallId, content, isError: false, timestamp: ts }
}

const now = Date.now()
const TWO_HOURS_AGO = now - 120 * 60_000
const TEN_MIN_AGO = now - 10 * 60_000

// ---- Tests ----

describe('evaluateTimeBasedTrigger', () => {
  it('returns null when no assistant message exists', () => {
    const messages = [makeUser(now, 'hello')]
    expect(evaluateTimeBasedTrigger(messages)).toBeNull()
  })

  it('returns null when gap is under threshold', () => {
    const messages = [makeAssistant(TEN_MIN_AGO)]
    expect(evaluateTimeBasedTrigger(messages, { gapMinutes: 60, keepRecent: 5 })).toBeNull()
  })

  it('returns gapMinutes when gap exceeds threshold', () => {
    const messages = [makeAssistant(TWO_HOURS_AGO)]
    const result = evaluateTimeBasedTrigger(messages, { gapMinutes: 60, keepRecent: 5 })
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(60)
  })
})

describe('maybeTimeBasedMicrocompact', () => {
  it('does nothing when gap is under threshold', () => {
    const messages: Message[] = [
      makeUser(now, 'read this file'),
      makeAssistant(TEN_MIN_AGO, [{ id: 'tc1', name: 'FileRead' }]),
      makeToolResult(TEN_MIN_AGO, 'tc1', 'file content here'),
    ]
    const { messages: result, result: info } = maybeTimeBasedMicrocompact(messages)
    expect(info.didCompact).toBe(false)
    expect(result).toBe(messages) // same reference
  })

  it('clears old tool results when gap exceeds threshold', () => {
    vi.useFakeTimers({ now })
    try {
      const messages: Message[] = [
        makeUser(TWO_HOURS_AGO, 'read file A'),
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc1', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc1', 'A' .repeat(5000)),
        makeUser(TWO_HOURS_AGO, 'read file B'),
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc2', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc2', 'B'.repeat(5000)),
        makeUser(TWO_HOURS_AGO, 'read file C'),
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc3', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc3', 'C'.repeat(5000)),
        // Last assistant was 2h ago
        makeAssistant(TWO_HOURS_AGO),
      ]
      // keepRecent=1 means only tc3 is kept, tc1/tc2 cleared
      const { messages: result, result: info } = maybeTimeBasedMicrocompact(messages, {
        gapMinutes: 60,
        keepRecent: 1,
      })
      expect(info.didCompact).toBe(true)
      expect(info.clearedCount).toBe(2)
      expect(info.charsSaved).toBe(10000)

      // Verify content was replaced
      const tr1 = result.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'tc1')!
      expect((tr1 as any).content).toBe(TOOL_RESULT_CLEARED_MESSAGE)
      const tr2 = result.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'tc2')!
      expect((tr2 as any).content).toBe(TOOL_RESULT_CLEARED_MESSAGE)
      const tr3 = result.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'tc3')!
      expect((tr3 as any).content).toBe('C'.repeat(5000)) // kept
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores non-compactable tools', () => {
    vi.useFakeTimers({ now })
    try {
      const messages: Message[] = [
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc1', name: 'Agent' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc1', 'sub-agent result'),
        makeAssistant(TWO_HOURS_AGO),
      ]
      const { result: info } = maybeTimeBasedMicrocompact(messages)
      expect(info.didCompact).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not clear already-cleared results', () => {
    vi.useFakeTimers({ now })
    try {
      const messages: Message[] = [
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc1', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc1', TOOL_RESULT_CLEARED_MESSAGE),
        makeAssistant(TWO_HOURS_AGO),
      ]
      const { result: info } = maybeTimeBasedMicrocompact(messages)
      expect(info.didCompact).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mutate original messages array', () => {
    vi.useFakeTimers({ now })
    try {
      const original: Message[] = [
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc1', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc1', 'original content'),
        makeAssistant(TWO_HOURS_AGO, [{ id: 'tc2', name: 'FileRead' }]),
        makeToolResult(TWO_HOURS_AGO, 'tc2', 'kept content'),
        makeAssistant(TWO_HOURS_AGO),
      ]
      const { messages: result } = maybeTimeBasedMicrocompact(original, {
        gapMinutes: 60,
        keepRecent: 1, // keep tc2, clear tc1
      })
      // Original unchanged
      expect((original[1] as any).content).toBe('original content')
      // Result has tc1 cleared
      expect((result[1] as any).content).toBe(TOOL_RESULT_CLEARED_MESSAGE)
      // tc2 kept intact
      expect((result[3] as any).content).toBe('kept content')
    } finally {
      vi.useRealTimers()
    }
  })
})
