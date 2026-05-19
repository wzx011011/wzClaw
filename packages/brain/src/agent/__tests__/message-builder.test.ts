import { describe, it, expect } from 'vitest'
import { MessageBuilder } from '../message-builder.js'
import type { Message, LLMProvider } from '../../types.js'

describe('MessageBuilder', () => {
  const builder = new MessageBuilder()

  const baseMessages: Message[] = [
    { role: 'user', content: 'Hello', timestamp: 1000 },
    { role: 'assistant', content: 'Hi there', toolCalls: [], timestamp: 1001 },
  ]

  describe('OpenAI format', () => {
    it('converts basic user/assistant messages', () => {
      const result = builder.buildMessages(baseMessages, 'openai')
      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ])
    })

    it('converts tool_calls in assistant messages', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: '/foo.ts' } }],
          timestamp: 1001,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'file content', isError: false, timestamp: 1002 },
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result[0]).toMatchObject({ role: 'assistant', content: '' })
      expect((result[0] as Record<string, unknown>).tool_calls).toEqual([{
        id: 'tc1',
        type: 'function',
        function: { name: 'FileRead', arguments: '{"path":"/foo.ts"}' },
      }])
      expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'file content' })
    })

    it('drops orphaned tool_result without preceding tool_calls', () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'No tools', toolCalls: [], timestamp: 1001 },
        { role: 'tool_result', toolCallId: 'orphan', content: 'orphan result', isError: false, timestamp: 1002 },
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ role: 'assistant', content: 'No tools' })
    })

    it('trims trailing assistant with tool_calls but no tool_result', () => {
      const messages: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'Bash', input: { command: 'ls' } }], timestamp: 1001 },
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toHaveLength(0)
    })

    it('handles vision images in user messages', () => {
      const messages: Message[] = [{
        role: 'user',
        content: 'See this',
        images: [{ data: 'abc123', mimeType: 'image/png', name: 'test.png' }],
        timestamp: 1000,
      }]
      const result = builder.buildMessages(messages, 'openai')
      const content = result[0].content as Array<{ type: string }>
      expect(content).toHaveLength(2)
      expect(content[0]).toEqual({ type: 'text', text: 'See this' })
      expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } })
    })

    it('preserves multiple tool_results for parallel tool_calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', name: 'FileRead', input: { path: '/a.ts' } },
            { id: 'tc2', name: 'FileRead', input: { path: '/b.ts' } },
          ],
          timestamp: 1001,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'a content', isError: false, timestamp: 1002 },
        { role: 'tool_result', toolCallId: 'tc2', content: 'b content', isError: false, timestamp: 1003 },
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toHaveLength(3)
      expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'a content' })
      expect(result[2]).toEqual({ role: 'tool', tool_call_id: 'tc2', content: 'b content' })
    })
  })

  describe('Anthropic format', () => {
    it('converts basic user/assistant messages', () => {
      const result = builder.buildMessages(baseMessages, 'anthropic')
      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      ])
    })

    it('converts tool_result to user role with tool_result blocks', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: '/foo.ts' } }],
          timestamp: 1001,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'file content', isError: false, timestamp: 1002 },
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result[1]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file content', is_error: false }],
      })
    })

    it('merges consecutive tool_results into single user message', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', name: 'Bash', input: { command: 'ls' } },
            { id: 'tc2', name: 'Bash', input: { command: 'pwd' } },
          ],
          timestamp: 1001,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'file1\nfile2', isError: false, timestamp: 1002 },
        { role: 'tool_result', toolCallId: 'tc2', content: '/home', isError: false, timestamp: 1003 },
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toHaveLength(2)
      const userContent = result[1].content as Array<Record<string, unknown>>
      expect(userContent).toHaveLength(2)
      expect(userContent[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc1' })
      expect(userContent[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc2' })
    })

    it('uses contentBlocks when available', () => {
      const messages: Message[] = [{
        role: 'assistant',
        content: 'thinking...',
        contentBlocks: [
          { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
          { type: 'text', text: 'Here is the answer' },
        ],
        toolCalls: [],
        timestamp: 1001,
      }]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result[0]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
          { type: 'text', text: 'Here is the answer' },
        ],
      })
    })

    it('handles empty assistant content with tool_calls', () => {
      const messages: Message[] = [{
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'Bash', input: { command: 'ls' } }],
        timestamp: 1001,
      }]
      const result = builder.buildMessages(messages, 'anthropic')
      const content = result[0].content as Array<Record<string, unknown>>
      expect(content).toEqual([{ type: 'tool_use', id: 'tc1', name: 'Bash', input: { command: 'ls' } }])
    })

    it('handles vision images', () => {
      const messages: Message[] = [{
        role: 'user',
        content: 'Look at this',
        images: [{ data: 'xyz', mimeType: 'image/jpeg' }],
        timestamp: 1000,
      }]
      const result = builder.buildMessages(messages, 'anthropic')
      const content = result[0].content as Array<Record<string, unknown>>
      expect(content).toHaveLength(2)
      expect(content[0]).toEqual({ type: 'text', text: 'Look at this' })
      expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'xyz' } })
    })
  })

  describe('buildSystemPrompt', () => {
    it('returns base prompt when no tools', () => {
      expect(builder.buildSystemPrompt('Hello', [])).toBe('Hello')
    })

    it('appends tool definitions', () => {
      const result = builder.buildSystemPrompt('System:', [
        { name: 'FileRead', description: 'Read file', inputSchema: { type: 'object' } },
      ])
      expect(result).toContain('## Available Tools')
      expect(result).toContain('### FileRead')
      expect(result).toContain('"type": "object"')
    })
  })
})
