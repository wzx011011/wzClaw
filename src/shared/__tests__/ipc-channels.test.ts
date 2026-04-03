import { describe, it, expect } from 'vitest'
import { IPC_CHANNELS, IpcSchemas } from '../ipc-channels'

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
