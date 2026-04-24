import { describe, it, expect } from 'vitest'
import { IPC_CHANNELS, IpcSchemas } from '../ipc-channels'
import { FileMentionSchema } from '../types'

describe('IPC_CHANNELS', () => {
  it('has all required channel names', () => {
    expect(IPC_CHANNELS['agent:send_message']).toBe('agent:send_message')
    expect(IPC_CHANNELS['agent:stop']).toBe('agent:stop')
    expect(IPC_CHANNELS['stream:text_delta']).toBe('stream:text_delta')
    expect(IPC_CHANNELS['stream:done']).toBe('stream:done')
    expect(IPC_CHANNELS['settings:get']).toBe('settings:get')
    expect(IPC_CHANNELS['settings:update']).toBe('settings:update')
  })

  it('all channel names are const (readonly)', () => {
    // Type-level check: values should be string literals, not string
    const channel: 'agent:send_message' = IPC_CHANNELS['agent:send_message']
    expect(channel).toBe('agent:send_message')
  })
})

describe('IpcSchemas', () => {
  it('validates send_message request', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'conv-123',
      content: 'Hello agent'
    })
    expect(result.success).toBe(true)
  })

  it('rejects send_message with empty content', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'conv-123',
      content: ''
    })
    expect(result.success).toBe(false)
  })

  it('validates stream:text_delta payload', () => {
    const result = IpcSchemas['stream:text_delta'].safeParse({
      content: 'hello token'
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// @-mention file injection tests (MENTION-01 through MENTION-06)
// ============================================================

describe('FileMention type', () => {
  it('has type=file_mention, path, content, size fields', () => {
    const mention = {
      type: 'file_mention' as const,
      path: 'src/utils/helpers.ts',
      content: 'export function add(a: number, b: number) { return a + b; }',
      size: 56
    }
    const result = FileMentionSchema.safeParse(mention)
    expect(result.success).toBe(true)
  })

  it('rejects missing type field', () => {
    const result = FileMentionSchema.safeParse({
      path: 'src/foo.ts',
      content: 'hello',
      size: 5
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong type value', () => {
    const result = FileMentionSchema.safeParse({
      type: 'mention',
      path: 'src/foo.ts',
      content: 'hello',
      size: 5
    })
    expect(result.success).toBe(false)
  })
})

describe('file:read-content IPC channel', () => {
  it('has file:read-content channel registered', () => {
    expect(IPC_CHANNELS['file:read-content']).toBe('file:read-content')
  })

  it('validates file:read-content request schema', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.request.safeParse({
      filePath: 'src/utils/helpers.ts'
    })
    expect(result.success).toBe(true)
  })

  it('rejects file:read-content request without filePath', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.request.safeParse({})
    expect(result.success).toBe(false)
  })

  it('validates file:read-content response with content, size, path', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.response.safeParse({
      content: 'hello world',
      size: 11,
      path: 'src/foo.ts'
    })
    expect(result.success).toBe(true)
  })

  it('validates file:read-content error response for file too large', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.response.safeParse({
      error: 'File too large',
      size: 200000,
      limit: 102400
    })
    expect(result.success).toBe(true)
  })
})
