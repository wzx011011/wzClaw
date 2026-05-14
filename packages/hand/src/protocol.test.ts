// ============================================================
// protocol.ts 单元测试
// 覆盖消息构造和解析的所有行为
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  createRegisterMessage,
  createResultMessage,
  createHeartbeatMessage,
  parseIncomingMessage,
} from './protocol.js'
import type { HandToolDefinition } from './types.js'

// ---- createRegisterMessage ----

describe('createRegisterMessage', () => {
  it('构造包含 id、capabilities、definitions 的 hand:register 消息', () => {
    const definitions: HandToolDefinition[] = [
      { name: 'FileRead', description: '读取文件', inputSchema: { type: 'object' }, isReadOnly: true },
    ]
    const msg = createRegisterMessage('hand-1', ['FileRead', 'Bash'], definitions)
    const parsed = JSON.parse(msg)

    expect(parsed.event).toBe('hand:register')
    expect(parsed.data.id).toBe('hand-1')
    expect(parsed.data.capabilities).toEqual(['FileRead', 'Bash'])
    expect(parsed.data.definitions).toEqual(definitions)
  })

  it('definitions 为空数组时仍然构造合法消息', () => {
    const msg = createRegisterMessage('hand-2', [], [])
    const parsed = JSON.parse(msg)

    expect(parsed.event).toBe('hand:register')
    expect(parsed.data.id).toBe('hand-2')
    expect(parsed.data.capabilities).toEqual([])
    expect(parsed.data.definitions).toEqual([])
  })
})

// ---- createResultMessage ----

describe('createResultMessage', () => {
  it('构造包含 callId、output、isError 的 hand:result 消息', () => {
    const msg = createResultMessage('call-123', 'file content here', false)
    const parsed = JSON.parse(msg)

    expect(parsed.event).toBe('hand:result')
    expect(parsed.data.callId).toBe('call-123')
    expect(parsed.data.output).toBe('file content here')
    expect(parsed.data.isError).toBe(false)
  })

  it('错误结果消息 isError 为 true', () => {
    const msg = createResultMessage('call-456', 'file not found', true)
    const parsed = JSON.parse(msg)

    expect(parsed.data.isError).toBe(true)
  })
})

// ---- createHeartbeatMessage ----

describe('createHeartbeatMessage', () => {
  it('构造无 data 字段的 hand:heartbeat 消息', () => {
    const msg = createHeartbeatMessage()
    const parsed = JSON.parse(msg)

    expect(parsed.event).toBe('hand:heartbeat')
    expect(parsed.data).toBeUndefined()
  })
})

// ---- parseIncomingMessage ----

describe('parseIncomingMessage', () => {
  it('解析 hand:execute 消息并提取 callId/name/input/context', () => {
    const raw = JSON.stringify({
      event: 'hand:execute',
      data: {
        callId: 'call-abc',
        name: 'FileRead',
        input: { path: '/a.ts' },
        context: { workingDirectory: '/project', projectRoots: ['/project'] },
      },
    })
    const result = parseIncomingMessage(raw)

    expect(result).not.toBeNull()
    expect(result!.event).toBe('hand:execute')
    if (result!.event === 'hand:execute') {
      expect(result!.data.callId).toBe('call-abc')
      expect(result!.data.name).toBe('FileRead')
      expect(result!.data.input).toEqual({ path: '/a.ts' })
      expect(result!.data.context).toEqual({
        workingDirectory: '/project',
        projectRoots: ['/project'],
      })
    }
  })

  it('解析 hand:heartbeat_ack 消息', () => {
    const raw = JSON.stringify({ event: 'hand:heartbeat_ack' })
    const result = parseIncomingMessage(raw)

    expect(result).not.toBeNull()
    expect(result!.event).toBe('hand:heartbeat_ack')
  })

  it('解析未知 event 类型的消息', () => {
    const raw = JSON.stringify({ event: 'unknown:event', data: { foo: 'bar' } })
    const result = parseIncomingMessage(raw)

    expect(result).not.toBeNull()
    expect(result!.event).toBe('unknown:event')
    expect(result!.data).toEqual({ foo: 'bar' })
  })

  it('空字符串返回 null', () => {
    expect(parseIncomingMessage('')).toBeNull()
  })

  it('非 JSON 字符串返回 null', () => {
    expect(parseIncomingMessage('not json at all')).toBeNull()
  })

  it('缺少 event 字段的 JSON 返回 null', () => {
    expect(parseIncomingMessage(JSON.stringify({ data: 'no event' }))).toBeNull()
  })

  it('event 不是字符串返回 null', () => {
    expect(parseIncomingMessage(JSON.stringify({ event: 123 }))).toBeNull()
  })

  it('缺少 data 字段的合法消息（如 heartbeat_ack）返回正确结果', () => {
    const raw = JSON.stringify({ event: 'hand:heartbeat_ack' })
    const result = parseIncomingMessage(raw)
    expect(result).not.toBeNull()
    expect(result!.event).toBe('hand:heartbeat_ack')
  })
})
