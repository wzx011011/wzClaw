import { describe, it, expect } from 'vitest'
import { MessageBuilder } from '../message-builder'
import type { Message, ToolDefinition } from '../../../shared/types'

describe('MessageBuilder', () => {
  const builder = new MessageBuilder()

  // ============================================================
  // OpenAI format
  // ============================================================

  describe('OpenAI format', () => {
    it('converts UserMessage', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: 1000 }
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toEqual([
        { role: 'user', content: 'Hello' }
      ])
    })

    it('converts AssistantMessage without tool calls', () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'Hi there', toolCalls: [], timestamp: 1000 }
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toEqual([
        { role: 'assistant', content: 'Hi there' }
      ])
    })

    it('converts AssistantMessage with tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'file_read', input: { path: '/foo.ts' } }
          ],
          timestamp: 1000
        }
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toEqual([
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'file_read',
                arguments: JSON.stringify({ path: '/foo.ts' })
              }
            }
          ]
        }
      ])
    })

    it('converts ToolResultMessage', () => {
      const messages: Message[] = [
        {
          role: 'tool_result',
          toolCallId: 'call_1',
          content: 'file contents here',
          isError: false,
          timestamp: 1000
        }
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toEqual([
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'file contents here'
        }
      ])
    })

    it('converts a multi-turn conversation', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read foo.ts', timestamp: 1000 },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'file_read', input: { path: '/foo.ts' } }
          ],
          timestamp: 2000
        },
        {
          role: 'tool_result',
          toolCallId: 'call_1',
          content: 'file contents',
          isError: false,
          timestamp: 3000
        },
        {
          role: 'assistant',
          content: 'Here is the file content.',
          toolCalls: [],
          timestamp: 4000
        }
      ]
      const result = builder.buildMessages(messages, 'openai')
      expect(result).toHaveLength(4)
      expect(result[0].role).toBe('user')
      expect(result[1].role).toBe('assistant')
      expect((result[1] as any).tool_calls).toHaveLength(1)
      expect(result[2].role).toBe('tool')
      expect(result[3].role).toBe('assistant')
    })
  })

  // ============================================================
  // Anthropic format
  // ============================================================

  describe('Anthropic format', () => {
    it('converts UserMessage', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: 1000 }
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toEqual([
        { role: 'user', content: 'Hello' }
      ])
    })

    it('converts AssistantMessage without tool calls', () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'Hi there', toolCalls: [], timestamp: 1000 }
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toEqual([
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
      ])
    })

    it('converts AssistantMessage with tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Let me read that file.',
          toolCalls: [
            { id: 'call_1', name: 'file_read', input: { path: '/foo.ts' } }
          ],
          timestamp: 1000
        }
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'file_read',
              input: { path: '/foo.ts' }
            }
          ]
        }
      ])
    })

    it('converts ToolResultMessage as user role with content blocks', () => {
      const messages: Message[] = [
        {
          role: 'tool_result',
          toolCallId: 'call_1',
          content: 'file contents here',
          isError: false,
          timestamp: 1000
        }
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'file contents here',
              is_error: false
            }
          ]
        }
      ])
    })

    it('converts ToolResultMessage with error flag', () => {
      const messages: Message[] = [
        {
          role: 'tool_result',
          toolCallId: 'call_2',
          content: 'File not found',
          isError: true,
          timestamp: 1000
        }
      ]
      const result = builder.buildMessages(messages, 'anthropic')
      expect(result).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_2',
              content: 'File not found',
              is_error: true
            }
          ]
        }
      ])
    })
  })

  // ============================================================
  // Edge cases
  // ============================================================

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      const result = builder.buildMessages([], 'openai')
      expect(result).toEqual([])
    })

    it('returns empty array for empty input with anthropic', () => {
      const result = builder.buildMessages([], 'anthropic')
      expect(result).toEqual([])
    })
  })

  // ============================================================
  // System prompt builder
  // ============================================================

  describe('buildSystemPrompt', () => {
    it('returns base prompt when no tools provided', () => {
      const result = builder.buildSystemPrompt('You are helpful.', [])
      expect(result).toBe('You are helpful.')
    })

    it('appends tool descriptions to system prompt', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read a file from disk',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' } },
            required: ['path']
          }
        }
      ]
      const result = builder.buildSystemPrompt('You are helpful.', tools)
      expect(result).toContain('You are helpful.')
      expect(result).toContain('## Available Tools')
      expect(result).toContain('file_read')
      expect(result).toContain('Read a file from disk')
      expect(result).toContain('"path"')
    })

    it('includes multiple tools in description', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'file_read',
          description: 'Read file',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'bash',
          description: 'Execute command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } }
        }
      ]
      const result = builder.buildSystemPrompt('Base.', tools)
      expect(result).toContain('file_read')
      expect(result).toContain('bash')
      expect(result).toContain('Read file')
      expect(result).toContain('Execute command')
    })
  })
})
