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
    it('returns false when messages are under threshold', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() }
      ]
      // A single short message is way under threshold
      expect(cm.shouldCompact(messages, 'gpt-4o')).toBe(false)
    })

    it('returns true when messages exceed auto threshold (~93%)', () => {
      const cm = new ContextManager()
      // gpt-4o: contextWindow=128000, maxOutput=16384, safetyBuffer=13000
      // threshold = 128000 - 16384 - 13000 = 98616
      // Create enough content to exceed 98616 tokens (~98K+ tokens)
      const longContent = 'a '.repeat(120000) // ~120K tokens
      const messages: Message[] = [
        { role: 'user', content: longContent, timestamp: Date.now() }
      ]
      expect(cm.shouldCompact(messages, 'gpt-4o')).toBe(true)
    })

    it('P1: triggers at ~93% not 80% (no 50% floor)', () => {
      const cm = new ContextManager()
      // gpt-4o: contextWindow=128000
      // Old threshold with 50% floor: max(128000 - 16384 - 13000, 64000) = 64000
      // New threshold without floor: 128000 - 16384 - 13000 = 98616
      // Create content that's above 80K but below 98K tokens
      // ~80K tokens should NOT trigger (it's between old 50% floor and new ~93% threshold)
      const mediumContent = 'x '.repeat(85000) // ~85K tokens
      const messages: Message[] = [
        { role: 'user', content: mediumContent, timestamp: Date.now() }
      ]
      // With new formula: 85K < 98616 → should NOT compact
      expect(cm.shouldCompact(messages, 'gpt-4o')).toBe(false)
    })

    it('respects compactThreshold > 0 for legacy ratio mode', () => {
      const cm = new ContextManager({ compactThreshold: 0.5 })
      const messages: Message[] = [
        { role: 'user', content: 'a '.repeat(70000), timestamp: Date.now() }
      ]
      // 70K tokens > 128000 * 0.5 = 64000 → should trigger
      expect(cm.shouldCompact(messages, 'gpt-4o')).toBe(true)
    })

    it('returns false when isCompacting is true (circuit breaker)', async () => {
      const cm = new ContextManager()
      const longContent = 'a '.repeat(120000)
      const messages: Message[] = [
        { role: 'user', content: longContent, timestamp: Date.now() }
      ]

      let wasCompactingDuringExecution = false
      const gateway = {
        stream: async function* (_options: unknown): AsyncGenerator<StreamEvent> {
          wasCompactingDuringExecution = cm.shouldCompact(messages, 'gpt-4o')
          yield { type: 'text_delta', content: 'Summary' } as StreamEvent
          yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } } as StreamEvent
        }
      } as any

      await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      // During execution, shouldCompact returned false (circuit breaker)
      expect(wasCompactingDuringExecution).toBe(false)
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

      expect(wasCompactingDuringExecution).toBe(false)
      expect(cm.shouldCompact(messages, 'deepseek-chat')).toBe(false)
    })

    it('summarizes older messages and keeps last N messages intact', async () => {
      const cm = new ContextManager({ compactKeepMax: 4 })
      const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
        role: 'user' as const,
        content: `Message ${i}: This is a longer message with enough content to make the token count meaningful and ensure that compaction actually reduces the total tokens in the conversation window.`,
        timestamp: Date.now()
      }))

      const gateway = createMockGateway('Summary of earlier conversation')
      const result = await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      expect(result.summary).toBe('Summary of earlier conversation')
      expect(result.keptRecentCount).toBe(4)
      expect(result.beforeTokens).toBeGreaterThan(0)
      expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    })

    it('returns empty summary when not enough messages to summarize', async () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Hi', timestamp: Date.now() },
        { role: 'assistant', content: 'Hello', toolCalls: [], timestamp: Date.now() },
        { role: 'user', content: 'How?', timestamp: Date.now() }
      ]

      const gateway = createMockGateway('Should not be called')
      const result = await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      expect(result.summary).toBe('')
      expect(result.beforeTokens).toBe(result.afterTokens)
      expect(result.summarizedMessages).toEqual([])
    })

    it('P0: returns summarizedMessages for file restoration', async () => {
      const cm = new ContextManager({ compactKeepMax: 2 })
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `Message ${i} with content`,
        timestamp: Date.now()
      }))

      const gateway = createMockGateway('Summary')
      const result = await cm.compact(messages, gateway, 'gpt-4o', 'openai')

      expect(result.summarizedMessages.length).toBe(8) // 10 - 2 kept
      expect(result.summarizedMessages[0].content).toContain('Message 0')
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

  describe('reactiveCompact', () => {
    it('keeps only last reactiveCompactKeepCount messages', () => {
      const cm = new ContextManager({ reactiveCompactKeepCount: 2 })
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `Msg ${i}`,
        timestamp: Date.now()
      }))

      const result = cm.reactiveCompact(messages)
      expect(result.length).toBe(2)
      expect(result[0].content).toBe('Msg 8')
      expect(result[1].content).toBe('Msg 9')
    })
  })

  describe('reactiveCompactByTurns (P2)', () => {
    it('keeps the last 2 turns and removes earlier turns', () => {
      const cm = new ContextManager()
      // 3 turns: user+assistant+tool_result each
      const messages: Message[] = [
        // Turn 1
        { role: 'user', content: 'Turn 1 user', timestamp: 1 },
        { role: 'assistant', content: 'Turn 1 assistant', toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: '/a.ts' } }], timestamp: 2 },
        { role: 'tool_result', toolCallId: 'tc1', content: 'file a content', isError: false, timestamp: 3 },
        // Turn 2
        { role: 'user', content: 'Turn 2 user', timestamp: 4 },
        { role: 'assistant', content: 'Turn 2 assistant', toolCalls: [{ id: 'tc2', name: 'FileRead', input: { path: '/b.ts' } }], timestamp: 5 },
        { role: 'tool_result', toolCallId: 'tc2', content: 'file b content', isError: false, timestamp: 6 },
        // Turn 3
        { role: 'user', content: 'Turn 3 user', timestamp: 7 },
        { role: 'assistant', content: 'Turn 3 assistant', toolCalls: [], timestamp: 8 },
      ]

      const result = cm.reactiveCompactByTurns(messages)
      // Should keep turns 2 and 3 (last 2 turns)
      expect(result.length).toBe(5) // user + assistant + tool_result + user + assistant
      expect(result[0].content).toBe('Turn 2 user')
      expect(result[result.length - 1].content).toBe('Turn 3 assistant')
    })

    it('returns all messages if <= 2 turns', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Turn 1', timestamp: 1 },
        { role: 'assistant', content: 'Response', toolCalls: [], timestamp: 2 },
      ]

      const result = cm.reactiveCompactByTurns(messages)
      expect(result.length).toBe(2)
    })

    it('fallback to simple truncation when too few messages', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Only message', timestamp: 1 },
      ]

      const result = cm.reactiveCompactByTurns(messages)
      expect(result.length).toBe(1)
    })

    it('handles messages without tool_result (text-only turns)', () => {
      const cm = new ContextManager()
      const messages: Message[] = [
        { role: 'user', content: 'Q1', timestamp: 1 },
        { role: 'assistant', content: 'A1', toolCalls: [], timestamp: 2 },
        { role: 'user', content: 'Q2', timestamp: 3 },
        { role: 'assistant', content: 'A2', toolCalls: [], timestamp: 4 },
        { role: 'user', content: 'Q3', timestamp: 5 },
        { role: 'assistant', content: 'A3', toolCalls: [], timestamp: 6 },
      ]

      const result = cm.reactiveCompactByTurns(messages)
      // Keeps last 2 turns: Q2+A2+Q3+A3 = 4 messages
      expect(result.length).toBe(4)
      expect(result[0].content).toBe('Q2')
    })
  })

  describe('getMicrocompactConfig (P3)', () => {
    it('returns default config when no overrides', () => {
      const cm = new ContextManager()
      const config = cm.getMicrocompactConfig()
      expect(config.gapMinutes).toBe(60)
      expect(config.keepRecent).toBe(5)
    })

    it('returns overridden config', () => {
      const cm = new ContextManager({ microcompactGapMinutes: 30, microcompactKeepRecent: 10 })
      const config = cm.getMicrocompactConfig()
      expect(config.gapMinutes).toBe(30)
      expect(config.keepRecent).toBe(10)
    })
  })

  describe('getConfig', () => {
    it('returns merged config with defaults', () => {
      const cm = new ContextManager({ compactSafetyBuffer: 20000 })
      const config = cm.getConfig()
      expect(config.compactSafetyBuffer).toBe(20000)
      expect(config.compactThreshold).toBe(0) // default
      expect(config.microcompactGapMinutes).toBe(60) // default
    })
  })
})
