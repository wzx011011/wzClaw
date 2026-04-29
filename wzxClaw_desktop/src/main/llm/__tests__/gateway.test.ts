import { describe, it, expect } from 'vitest'
import { LLMGateway } from '../gateway'

describe('LLMGateway', () => {
  it('detects openai provider for gpt models', () => {
    const gateway = new LLMGateway()
    expect((gateway as any).detectProvider('gpt-4o')).toBe('openai')
    expect((gateway as any).detectProvider('gpt-4o-mini')).toBe('openai')
  })

  it('detects openai provider for deepseek models', () => {
    const gateway = new LLMGateway()
    expect((gateway as any).detectProvider('deepseek-chat')).toBe('openai')
    expect((gateway as any).detectProvider('deepseek-reasoner')).toBe('openai')
  })

  it('detects anthropic provider for claude models', () => {
    const gateway = new LLMGateway()
    expect((gateway as any).detectProvider('claude-sonnet-4-20250514')).toBe('anthropic')
    expect((gateway as any).detectProvider('claude-3-5-haiku-20241022')).toBe('anthropic')
  })

  it('addProvider creates adapter for openai', () => {
    const gateway = new LLMGateway()
    gateway.addProvider({ provider: 'openai', apiKey: 'test-key' })
    expect(gateway.hasProvider('openai')).toBe(true)
    expect(gateway.hasProvider('anthropic')).toBe(false)
  })

  it('addProvider creates adapter for anthropic', () => {
    const gateway = new LLMGateway()
    gateway.addProvider({ provider: 'anthropic', apiKey: 'test-key' })
    expect(gateway.hasProvider('anthropic')).toBe(true)
    expect(gateway.hasProvider('openai')).toBe(false)
  })

  it('getAdapter returns the correct adapter instance', () => {
    const gateway = new LLMGateway()
    gateway.addProvider({ provider: 'openai', apiKey: 'test-key' })
    const adapter = gateway.getAdapter('openai')
    expect(adapter).toBeDefined()
    expect(adapter?.provider).toBe('openai')
  })

  it('getAdapter returns undefined for unconfigured provider', () => {
    const gateway = new LLMGateway()
    expect(gateway.getAdapter('openai')).toBeUndefined()
  })

  it('stream yields error for missing provider', async () => {
    const gateway = new LLMGateway()
    const events = []
    for await (const event of gateway.stream({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    if (events[0].type === 'error') {
      expect(events[0].error).toContain('No adapter configured')
    }
  })

  it('addProvider throws for unknown provider', () => {
    const gateway = new LLMGateway()
    expect(() => gateway.addProvider({ provider: 'unknown' as any, apiKey: 'test' })).toThrow(
      'Unknown provider: unknown'
    )
  })
})
