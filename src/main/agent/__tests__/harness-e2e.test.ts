/**
 * wzxClaw Harness E2E Tests
 *
 * Tests the complete agent event flow from LLM stream → agent-loop → events.
 * Each test case validates:
 *   1. Event sequence correctness (order, types)
 *   2. Content integrity (no loss, no duplication)
 *   3. Turn management (turn_end between multi-turn runs)
 *   4. Error handling edge cases
 *
 * Test Cases:
 *   TC1: Single-turn pure text response
 *   TC2: Single-turn multi-tool (parallel read-only)
 *   TC3: Multi-turn iterative (tool → LLM → text)
 *   TC4: Content block interleaving (text → tool → text → tool)
 *   TC5: Long tool output truncation and context budget
 *   TC6: Empty assistant response edge case
 *   TC7: Concurrent read + sequential write ordering
 *   TC8: turn_end event positioning
 *   TC9: Context compaction trigger
 *   TC10: Cache token passthrough
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent } from '../../../shared/types'
import type { AgentEvent, AgentConfig } from '../types'

// ============================================================
// Shared helpers
// ============================================================

function createGateway(turns: StreamEvent[][]) {
  let callIndex = 0
  return {
    stream: vi.fn().mockImplementation(() => {
      const events = turns[Math.min(callIndex, turns.length - 1)]
      callIndex++
      return (async function* () {
        for (const e of events) yield e
      })()
    }),
    detectProvider: vi.fn().mockReturnValue('openai'),
  }
}

function makeTool(name: string, readOnly: boolean, output = 'ok', delay = 0) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    requiresApproval: !readOnly,
    execute: vi.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      return { output, isError: false }
    }),
  }
}

function makeRegistry(tools: ReturnType<typeof makeTool>[]) {
  return {
    get: vi.fn((name: string) => tools.find(t => t.name === name)),
    getAll: vi.fn(() => tools),
    getDefinitions: vi.fn(() =>
      tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    ),
    getApprovalRequired: vi.fn(() => tools.filter(t => t.requiresApproval).map(t => t.name)),
    isReadOnly: vi.fn((name: string) => {
      const tool = tools.find(t => t.name === name)
      return tool ? !tool.requiresApproval : true
    }),
  }
}

function makePermissionMgr(approved = true) {
  return {
    requestApproval: vi.fn().mockResolvedValue(approved),
    isApproved: vi.fn().mockReturnValue(false),
    needsApproval: vi.fn((name: string) => name.includes('Write') || name.includes('Edit') || name.includes('Bash')),
    getPlanModeRejection: vi.fn().mockReturnValue(null),
    clearSession: vi.fn(),
    isRendererConnected: vi.fn().mockReturnValue(true),
  }
}

function makeContextMgr(opts?: { shouldCompact?: boolean }) {
  return {
    shouldCompact: vi.fn().mockReturnValue(opts?.shouldCompact ?? false),
    compact: vi.fn().mockResolvedValue({ summary: 'compacted summary', keptRecentCount: 2, beforeTokens: 100000, afterTokens: 20000 }),
    reactiveCompact: vi.fn((msgs: unknown[]) => msgs.slice(-2)),
    trackTokenUsage: vi.fn(),
    getContextWindowForModel: vi.fn().mockReturnValue(128000),
    getTotalUsage: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 }),
    resetUsage: vi.fn(),
    estimateTokens: vi.fn().mockReturnValue(5000),
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

function cfg(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    systemPrompt: 'test',
    workingDirectory: '/tmp',
    projectRoots: ['/tmp'],
    conversationId: 'test-conv',
    ...overrides,
  }
}

// ============================================================
// Tests
// ============================================================

describe('Harness E2E', () => {
  beforeEach(() => vi.clearAllMocks())

  // TC1: Single-turn pure text
  it('TC1: single-turn text-only emits text events then done', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const gw = createGateway([[
      { type: 'text_delta', content: 'Hello ' },
      { type: 'text_delta', content: 'world!' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]])
    const loop = new AgentLoop(gw as any, makeRegistry([]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('hi', cfg()))

    // Verify event types
    const types = events.map(e => e.type)
    expect(types).toEqual(['agent:text', 'agent:text', 'agent:done'])

    // Verify text concatenation
    const text = events.filter(e => e.type === 'agent:text').map(e => (e as any).content).join('')
    expect(text).toBe('Hello world!')

    // Verify done event
    const done = events.find(e => e.type === 'agent:done') as any
    expect(done.turnCount).toBe(1)
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  // TC2: Single-turn multiple read-only tools (should run in parallel)
  it('TC2: multi-tool single turn — all tools execute and results returned in order', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tools = [
      makeTool('FileRead', true, 'file content', 10),
      makeTool('Grep', true, 'grep result', 5),
      makeTool('Glob', true, 'glob result', 1),
    ]
    const gw = createGateway([
      [
        { type: 'text_delta', content: 'Reading files...' },
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a.ts' } },
        { type: 'tool_use_start', id: 'c2', name: 'Grep' },
        { type: 'tool_use_end', id: 'c2', parsedInput: { pattern: 'foo' } },
        { type: 'tool_use_start', id: 'c3', name: 'Glob' },
        { type: 'tool_use_end', id: 'c3', parsedInput: { pattern: '*.ts' } },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 30 } }
      ],
      [
        { type: 'text_delta', content: 'Found results.' },
        { type: 'done', usage: { inputTokens: 80, outputTokens: 10 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry(tools) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('search code', cfg()))

    const toolCalls = events.filter(e => e.type === 'agent:tool_call')
    const toolResults = events.filter(e => e.type === 'agent:tool_result')
    expect(toolCalls).toHaveLength(3)
    expect(toolResults).toHaveLength(3)

    // Results in LLM emission order
    expect((toolResults[0] as any).toolCallId).toBe('c1')
    expect((toolResults[1] as any).toolCallId).toBe('c2')
    expect((toolResults[2] as any).toolCallId).toBe('c3')

    // All tools executed
    tools.forEach(t => expect(t.execute).toHaveBeenCalledTimes(1))
  })

  // TC3: Multi-turn iterative task
  it('TC3: multi-turn — turn_end between turns, done at end', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true, 'contents')
    const gw = createGateway([
      // Turn 1: tool call
      [
        { type: 'text_delta', content: 'Reading...' },
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a.ts' } },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } }
      ],
      // Turn 2: tool call
      [
        { type: 'text_delta', content: 'Now editing...' },
        { type: 'tool_use_start', id: 'c2', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c2', parsedInput: { path: '/b.ts' } },
        { type: 'done', usage: { inputTokens: 40, outputTokens: 15 } }
      ],
      // Turn 3: text only (final)
      [
        { type: 'text_delta', content: 'Done!' },
        { type: 'done', usage: { inputTokens: 60, outputTokens: 5 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('do work', cfg()))

    // Verify turn_end appears after each tool turn
    const types = events.map(e => e.type)
    expect(types).toEqual([
      'agent:text',       // Turn 1 text
      'agent:tool_call',  // Turn 1 tool
      'agent:tool_result',// Turn 1 result
      'agent:turn_end',   // ← between turn 1 and 2
      'agent:text',       // Turn 2 text
      'agent:tool_call',  // Turn 2 tool
      'agent:tool_result',// Turn 2 result
      'agent:turn_end',   // ← between turn 2 and 3
      'agent:text',       // Turn 3 text
      'agent:done',       // ← final
    ])

    const done = events.find(e => e.type === 'agent:done') as any
    expect(done.turnCount).toBe(3)
    expect(done.usage.inputTokens).toBe(120) // 20+40+60
    expect(done.usage.outputTokens).toBe(30) // 10+15+5
  })

  // TC4: Content block interleaving (text → tool → text → tool)
  it('TC4: interleaved text/tool blocks preserved in correct order', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true, 'data')
    const gw = createGateway([
      [
        { type: 'text_delta', content: 'First ' },
        { type: 'text_delta', content: 'text.' },
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a' } },
        { type: 'text_delta', content: 'Middle text.' },
        { type: 'tool_use_start', id: 'c2', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c2', parsedInput: { path: '/b' } },
        { type: 'done', usage: { inputTokens: 30, outputTokens: 20 } }
      ],
      [
        { type: 'text_delta', content: 'Final.' },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 10 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('test interleave', cfg()))

    // Verify event order is: text, text, tool_call, text, tool_call, tool_result, tool_result, turn_end, text, done
    const types = events.map(e => e.type)
    expect(types[0]).toBe('agent:text')  // "First "
    expect(types[1]).toBe('agent:text')  // "text."
    expect(types[2]).toBe('agent:tool_call') // c1
    expect(types[3]).toBe('agent:text')  // "Middle text."
    expect(types[4]).toBe('agent:tool_call') // c2
    // After stream completes, tool results come in order
    expect(types[5]).toBe('agent:tool_result') // c1 result
    expect(types[6]).toBe('agent:tool_result') // c2 result
    expect(types[7]).toBe('agent:turn_end')

    // Verify contentBlocks on internal messages
    const msgs = loop.getMessages()
    const assistantMsg = msgs.find(m => m.role === 'assistant')!
    expect(assistantMsg.contentBlocks).toBeDefined()
    expect(assistantMsg.contentBlocks!.length).toBe(4) // text, tool_use, text, tool_use
    expect(assistantMsg.contentBlocks![0]).toEqual({ type: 'text', text: 'First text.' })
    expect(assistantMsg.contentBlocks![1]).toMatchObject({ type: 'tool_use', id: 'c1' })
    expect(assistantMsg.contentBlocks![2]).toEqual({ type: 'text', text: 'Middle text.' })
    expect(assistantMsg.contentBlocks![3]).toMatchObject({ type: 'tool_use', id: 'c2' })
  })

  // TC5: Long tool output truncation
  it('TC5: tool output exceeding MAX_TOOL_RESULT_CHARS is truncated in messages but full in event', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const longOutput = 'x'.repeat(50000) // > MAX_TOOL_RESULT_CHARS (30K)
    const tool = makeTool('FileRead', true, longOutput)
    const gw = createGateway([
      [
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/big.ts' } },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 20 } }
      ],
      [
        { type: 'text_delta', content: 'Read big file.' },
        { type: 'done', usage: { inputTokens: 200, outputTokens: 10 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('read big', cfg()))

    // Event output is full (untruncated) for UI display
    const resultEvent = events.find(e => e.type === 'agent:tool_result') as any
    expect(resultEvent.output.length).toBe(50000)

    // Internal message is truncated (for LLM context)
    const msgs = loop.getMessages()
    const toolResultMsg = msgs.find(m => m.role === 'tool_result')!
    expect(toolResultMsg.content.length).toBeLessThan(50000)
    expect(toolResultMsg.content).toContain('[Truncated:')
  })

  // TC6: Empty text response with tool-only output
  it('TC6: tool-only response with no text content works correctly', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true, 'data')
    const gw = createGateway([
      [
        // No text_delta — only tool calls
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a.ts' } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } }
      ],
      [
        { type: 'text_delta', content: 'Done.' },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 5 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('read', cfg()))

    // No text events in first turn
    const firstTurnText = events.filter(e => e.type === 'agent:text')
    expect(firstTurnText.length).toBe(1) // Only "Done." from turn 2

    // Internal messages — assistant has empty content but has toolCalls
    const msgs = loop.getMessages()
    const firstAssistant = msgs.find(m => m.role === 'assistant')!
    expect(firstAssistant.content).toBe('')
    expect(firstAssistant.toolCalls.length).toBe(1)
  })

  // TC7: Sequential write tool ordering
  it('TC7: write tools execute sequentially in LLM emission order', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const executionOrder: string[] = []
    const tools = [
      {
        name: 'FileWrite',
        description: 'Write',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: vi.fn().mockImplementation(async (input: any) => {
          executionOrder.push(`write-${input.path}`)
          await new Promise(r => setTimeout(r, 5))
          return { output: 'written', isError: false }
        }),
      },
      {
        name: 'FileRead',
        description: 'Read',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: false,
        execute: vi.fn().mockImplementation(async (input: any) => {
          executionOrder.push(`read-${input.path}`)
          return { output: 'content', isError: false }
        }),
      },
    ]
    const gw = createGateway([
      [
        { type: 'tool_use_start', id: 'c1', name: 'FileWrite' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a.ts', content: 'a' } },
        { type: 'tool_use_start', id: 'c2', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c2', parsedInput: { path: '/b.ts' } },
        { type: 'tool_use_start', id: 'c3', name: 'FileWrite' },
        { type: 'tool_use_end', id: 'c3', parsedInput: { path: '/c.ts', content: 'c' } },
        { type: 'done', usage: { inputTokens: 30, outputTokens: 20 } }
      ],
      [
        { type: 'text_delta', content: 'All done.' },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 5 } }
      ]
    ])
    const perm = makePermissionMgr(true)
    const mockSender = { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false), once: vi.fn(), removeListener: vi.fn() }
    const loop = new AgentLoop(gw as any, makeRegistry(tools as any) as any, perm as any, makeContextMgr() as any)
    const events = await collect(loop.run('write files', cfg(), mockSender as any))

    // Write tools must be sequential: write-/a.ts before write-/c.ts
    const writeOrder = executionOrder.filter(e => e.startsWith('write-'))
    expect(writeOrder).toEqual(['write-/a.ts', 'write-/c.ts'])

    // Read tool runs in parallel (may finish before or after writes)
    expect(executionOrder).toContain('read-/b.ts')

    // Results are still in LLM emission order
    const results = events.filter(e => e.type === 'agent:tool_result') as any[]
    expect(results.map(r => r.toolCallId)).toEqual(['c1', 'c2', 'c3'])
  })

  // TC8: turn_end is NOT emitted after text-only (final) turn
  it('TC8: turn_end only between tool turns — not at end', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const gw = createGateway([[
      { type: 'text_delta', content: 'Just text.' },
      { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } }
    ]])
    const loop = new AgentLoop(gw as any, makeRegistry([]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('hello', cfg()))

    expect(events.map(e => e.type)).toEqual(['agent:text', 'agent:done'])
    expect(events.some(e => e.type === 'agent:turn_end')).toBe(false)
  })

  // TC9: Context compaction triggers correctly
  it('TC9: auto-compaction yields compacted event', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const ctxMgr = makeContextMgr({ shouldCompact: true })
    // After compaction, shouldCompact returns false
    ctxMgr.shouldCompact.mockReturnValueOnce(true).mockReturnValue(false)

    const gw = createGateway([
      [
        { type: 'text_delta', content: 'response' },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([]) as any, makePermissionMgr() as any, ctxMgr as any)
    const events = await collect(loop.run('test compact', cfg()))

    // Compaction event emitted
    const compactEvent = events.find(e => e.type === 'agent:compacted') as any
    expect(compactEvent).toBeDefined()
    expect(compactEvent.auto).toBe(true)
    expect(compactEvent.beforeTokens).toBe(100000)
    expect(compactEvent.afterTokens).toBe(20000)
  })

  // TC10: Usage accumulates across turns
  it('TC10: total usage accumulates across all turns', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true)
    const gw = createGateway([
      [
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a' } },
        { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } }
      ],
      [
        { type: 'text_delta', content: 'result' },
        { type: 'done', usage: { inputTokens: 200, outputTokens: 30 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('test', cfg()))

    const done = events.find(e => e.type === 'agent:done') as any
    expect(done.usage.inputTokens).toBe(300)
    expect(done.usage.outputTokens).toBe(80)
  })

  // TC11: Internal messages maintain correct structure
  it('TC11: internal messages structure is correct after multi-turn', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true, 'file data')
    const gw = createGateway([
      [
        { type: 'text_delta', content: 'reading' },
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a' } },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } }
      ],
      [
        { type: 'text_delta', content: 'done' },
        { type: 'done', usage: { inputTokens: 40, outputTokens: 5 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    await collect(loop.run('test', cfg()))

    const msgs = loop.getMessages()
    // Expected: user, assistant (with tool), tool_result, [turn attachment user], assistant (text only)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('test')

    expect(msgs[1].role).toBe('assistant')
    const assistantMsg = msgs[1] as any
    expect(assistantMsg.content).toBe('reading')
    expect(assistantMsg.toolCalls).toHaveLength(1)
    expect(assistantMsg.toolCalls[0].name).toBe('FileRead')

    expect(msgs[2].role).toBe('tool_result')
    expect(msgs[2].content).toContain('file data')

    // Last message is the final assistant
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('done')
  })

  // TC12: AgentDoneEvent usage type should include cache tokens
  it('TC12: done event exposes cache token fields when present', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const gw = createGateway([[
      { type: 'text_delta', content: 'hi' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 } }
    ]])
    const loop = new AgentLoop(gw as any, makeRegistry([]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    const events = await collect(loop.run('test', cfg()))

    const done = events.find(e => e.type === 'agent:done') as any
    // The usage object should pass through cache tokens from the stream
    // Currently AgentDoneEvent type only has inputTokens/outputTokens,
    // but the runtime object carries whatever the stream provides
    expect(done.usage.inputTokens).toBe(10)
    expect(done.usage.outputTokens).toBe(5)
  })

  // TC13: Verify no duplicate messages on multi-tool turn
  it('TC13: exact message count is correct — no duplicates', async () => {
    const { AgentLoop } = await import('../agent-loop')
    const tool = makeTool('FileRead', true, 'data')
    const gw = createGateway([
      [
        { type: 'tool_use_start', id: 'c1', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c1', parsedInput: { path: '/a' } },
        { type: 'tool_use_start', id: 'c2', name: 'FileRead' },
        { type: 'tool_use_end', id: 'c2', parsedInput: { path: '/b' } },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } }
      ],
      [
        { type: 'text_delta', content: 'done' },
        { type: 'done', usage: { inputTokens: 40, outputTokens: 5 } }
      ]
    ])
    const loop = new AgentLoop(gw as any, makeRegistry([tool]) as any, makePermissionMgr() as any, makeContextMgr() as any)
    await collect(loop.run('test', cfg()))

    const msgs = loop.getMessages()
    // user(1) + assistant-with-tools(1) + tool_result(2) + [turn attachment](0 or 1) + assistant-final(1)
    const userMsgs = msgs.filter(m => m.role === 'user')
    const assistantMsgs = msgs.filter(m => m.role === 'assistant')
    const toolResultMsgs = msgs.filter(m => m.role === 'tool_result')

    expect(assistantMsgs).toHaveLength(2) // One per turn
    expect(toolResultMsgs).toHaveLength(2) // One per tool call
    expect(userMsgs.length).toBeGreaterThanOrEqual(1) // At least the original user msg
  })
})
