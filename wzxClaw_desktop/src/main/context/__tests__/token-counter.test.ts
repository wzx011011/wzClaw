import { describe, it, expect } from 'vitest'
import { countTokens, countMessagesTokens } from '../token-counter'
import type { Message } from '../../../shared/types'

describe('TokenCounter', () => {
  describe('countTokens', () => {
    it('returns a positive integer for non-empty string', () => {
      const result = countTokens('hello world')
      expect(result).toBeTypeOf('number')
      expect(result).toBeGreaterThan(0)
    })

    it('returns 0 for empty string', () => {
      expect(countTokens('')).toBe(0)
    })

    it('gives consistent results for the same input', () => {
      const text = 'The quick brown fox jumps over the lazy dog'
      const first = countTokens(text)
      const second = countTokens(text)
      expect(first).toBe(second)
    })
  })

  describe('countMessagesTokens', () => {
    it('returns 0 for empty array', () => {
      expect(countMessagesTokens([])).toBe(0)
    })

    it('returns total greater than sum of individual content tokens (includes overhead)', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
        { role: 'assistant', content: 'Hi there', toolCalls: [], timestamp: Date.now() },
        { role: 'user', content: 'How are you?', timestamp: Date.now() }
      ]

      const total = countMessagesTokens(messages)
      const contentOnly =
        countTokens('Hello') +
        countTokens('Hi there') +
        countTokens('How are you?')

      // Total should exceed content-only sum due to per-message overhead (4 per msg)
      expect(total).toBeGreaterThan(contentOnly)
    })

    it('counts tool call input tokens for assistant messages', () => {
      const messagesWithTools: Message[] = [
        {
          role: 'assistant',
          content: 'Let me read that file',
          toolCalls: [
            {
              id: 'tc_1',
              name: 'FileRead',
              input: { path: '/some/very/long/file/path/to/read.txt' }
            }
          ],
          timestamp: Date.now()
        }
      ]

      const tokens = countMessagesTokens(messagesWithTools)
      // Should be > just the content tokens due to tool call overhead
      expect(tokens).toBeGreaterThan(countTokens('Let me read that file'))
    })
  })
})
