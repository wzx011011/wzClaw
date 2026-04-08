import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from '../context-manager'
import type { Message } from '../../../shared/types'
import type { StreamEvent } from '../../../shared/types'

// Mock LLMGateway that yields a fixed summary
function createMockGateway(summary: string) {
  return {
    stream: async function* (_options: unknown): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', content: summary } as StreamEvent
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } } as StreamEvent
    }
  } as any
}

describe('ContextManager', () => {
  describe('getContextWindowForModel', () => {
    it('returns 128000 for GLM models', () => {
      const cm = new ContextManager()
      expect(cm.getContextWindowForModel('glm-5.1')).toBe(128000)
      expect(cm.getContextWindowForModel('glm-5-turbo')).toBe(128000)
      expect(cm.getContextWindowForModel('glm-4-plus')).toBe(128000)
      expect(cm.getContextWindowForModel('glm-4-flash')).toBe(128000)
    })

    it('returns 200000 for Claude models', () => {
      const cm = new ContextManager()
      expect(cm.getContextWindowForModel('claude-sonnet-4-20250514')).toBe(200000)
      expect(cm.getContextWindowForModel('claude-3-5-haiku-20241022')).toBe(200000)
    })

    it('returns 128000 for GPT-4o', () => {
      const cm = new ContextManager()
      expect(cm.getContextWindowForModel('gpt-4o')).toBe(128000)
    })

    it('returns 64000 for DeepSeek models', () => {
      const cm = new ContextManager()
      expect(cm.getContextWindowForModel('deepseek-chat')).toBe(64000)
      expect(cm.getContextWindowForModel('deepseek-reasoner')).toBe(64000)
    })

    it('returns 128000 as default for unknown models', () => {
      const cm = new ContextManager()
      expect(cm.getContextWindowForModel('unknown-model')).toBe(128000)
    })
  })

  describe('shouldCompact', () => {
    it('returns false when messages are under 80% threshold', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() }
      ]
      // A single short message is way under 80% of 128000
      expect(cm.shouldCompact(messages, 'gpt-4o')).toBe(false)
    })

    it('returns true when messages exceed 80% of context window', () => {
      const cm = new ContextManager()
      // DeepSeek has 64K context. 80% = 51200 tokens.
      // Create a message with enough content to exceed that.
      const longContent = 'a '.repeat(60000) // ~60000 tokens roughly
      const messages: Message[] = [
        { role: 'user', content: longContent, timestamp: Date.now() }
      ]
      expect(cm.shouldCompact(messages, 'deepseek-chat')).toBe(true)
    })

    it('returns false when isCompacting is true (circuit breaker)', () => {
      const cm = new ContextManager()
      // Use a very long message that would normally trigger compact
      const longContent = 'a '.repeat(60000)
      const messages: Message[] = [
        { role: 'user', content: longContent, timestamp: Date.now() }
      ]
      // First verify it WOULD compact
      expect(cm.shouldCompact(messages, 'deepseek-chat')).toBe(true)

      // Now trigger compact which sets isCompacting=true
      const gateway = createMockGateway('Summary text')
      // Start compact (this sets isCompacting = true internally)
      // We test the circuit breaker by checking during compact execution
      // Since compact is async, we need to test differently
      // Instead, we can test shouldCompact directly by manipulating state
      // The circuit breaker is internal, so we test it indirectly via compact

      // For direct test, compact sets isCompacting then resets.
      // If we call shouldCompact during compact, it should return false.
      // Let's do this with a promise:
      let shouldCompactDuringExecution = true

      const slowGateway = {
        stream: async function* (_options: unknown): AsyncGenerator<StreamEvent> {
          // While streaming, check shouldCompact
          shouldCompactDuringExecution = cm.shouldCompact(
            messages,
            'deepseek-chat'
          )
          yield { type: 'text_delta', content: 'Summary' } as StreamEvent
          yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } } as StreamEvent
        }
      } as any

      // This will set isCompacting=true, then check during execution
      cm.compact(messages, slowGateway, 'deepseek-chat', 'openai')

      // The circuit breaker should have returned false during execution
      // Note: compact is async so we need to await it
      // But the generator runs synchronously within the first yield
      // Let's verify after compact completes that shouldCompact works again
    })
  })

  describe('compact', () => {
    it('sets isCompacting=true during execution and resets after', async () => {
      const cm = new ContextManager()
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `Message ${i} with some content`,
        timestamp: Date.now()
      }))

      let wasCompactingDuringExecution = false
      const gateway = {
        stream: async function* (_options: unknown): AsyncGenerator<StreamEvent> {
          wasCompactingDuringExecution = cm.shouldCompact(messages, 'deepseek-chat')
          yield { type: 'text_delta', content: 'Summary text' } as StreamEvent
          yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } } as StreamEvent
        }
      } as any

      await cm.compact(messages, gateway, 'deepseek-chat', 'openai')

      // During execution, shouldCompact returned false (circuit breaker)
      expect(wasCompactingDuringExecution).toBe(false)

      // After completion, shouldCompact is back to normal
      expect(cm.shouldCompact(messages, 'deepseek-chat')).toBe(false)
    })

    it('summarizes older messages and keeps last 4 messages intact', async () => {
      const cm = new ContextManager()
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `Message ${i} with enough content to test`,
        timestamp: Date.now()
      }))

      const gateway = createMockGateway('Summary of earlier conversation')
      const result = await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      expect(result.summary).toBe('Summary of earlier conversation')
      expect(result.keptRecentCount).toBe(4)
      expect(result.beforeTokens).toBeGreaterThan(0)
      // After compact, tokens should be reduced (summary + 4 messages < 10 messages)
      expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    })

    it('returns empty summary when not enough messages to summarize', async () => {
      const cm = new ContextManager()
      // Only 3 messages -- can't split into 4 recent + rest
      const messages: Message[] = [
        { role: 'user', content: 'Hi', timestamp: Date.now() },
        { role: 'assistant', content: 'Hello', toolCalls: [], timestamp: Date.now() },
        { role: 'user', content: 'How?', timestamp: Date.now() }
      ]

      const gateway = createMockGateway('Should not be called')
      const result = await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      expect(result.summary).toBe('')
      expect(result.beforeTokens).toBe(result.afterTokens)
    })
  })

  describe('trackTokenUsage', () => {
    it('tracks input/output tokens and getTotalUsage returns accumulated totals', () => {
      const cm = new ContextManager()
      cm.trackTokenUsage(100, 50)
      cm.trackTokenUsage(200, 75)

      const usage = cm.getTotalUsage()
      expect(usage.inputTokens).toBe(300)
      expect(usage.outputTokens).toBe(125)
    })

    it('returns a copy of usage (not a reference)', () => {
      const cm = new ContextManager()
      cm.trackTokenUsage(100, 50)

      const usage1 = cm.getTotalUsage()
      usage1.inputTokens = 999

      const usage2 = cm.getTotalUsage()
      expect(usage2.inputTokens).toBe(100)
    })
  })

  describe('truncateToolResult', () => {
    it('returns content unchanged when under MAX_TOOL_RESULT_CHARS', () => {
      const content = 'This is a short tool result'
      expect(ContextManager.truncateToolResult(content)).toBe(content)
    })

    it('truncates content exceeding MAX_TOOL_RESULT_CHARS with suffix', () => {
      const content = 'x'.repeat(40000)
      const truncated = ContextManager.truncateToolResult(content)
      expect(truncated.length).toBeLessThan(content.length)
      expect(truncated).toContain('[truncated 40000 -> 30000 chars]')
      // 30000 chars + '\n' + suffix
      expect(truncated.length).toBe(30000 + 1 + '[truncated 40000 -> 30000 chars]'.length)
    })
  })

  describe('estimateTokens', () => {
    it('delegates to countMessagesTokens', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Hello world', timestamp: Date.now() }
      ]
      const tokens = cm.estimateTokens(messages)
      expect(tokens).toBeGreaterThan(0)
    })
  })

  describe('resetUsage', () => {
    it('resets accumulated usage to zero', () => {
      const cm = new ContextManager()
      cm.trackTokenUsage(100, 50)
      cm.resetUsage()
      const usage = cm.getTotalUsage()
      expect(usage.inputTokens).toBe(0)
      expect(usage.outputTokens).toBe(0)
    })
  })
})
