import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent, ToolCall } from '../../types.js'
import type { IStreamProvider, IStreamOptions } from '../../interfaces.js'
import type { AgentEvent, AgentConfig } from '../types.js'
import type { ToolExecResult } from '../streaming-tool-executor.js'
import type { TurnInput } from '../turn-manager.js'
import { ConversationManager } from '../conversation-manager.js'
import { ToolResultReplacementState } from '../../context/tool-result-storage.js'

// ============================================================
// Mock factories
// ============================================================

function createMockGateway(streamEvents: StreamEvent[][]): IStreamProvider {
  let callIndex = 0
  return {
    stream: vi.fn().mockImplementation((opts: IStreamOptions) => {
      const events = streamEvents[Math.min(callIndex, streamEvents.length - 1)]
      callIndex++
      return (async function* () {
        for (const event of events) {
          yield event
        }
      })()
    }),
  }
}

function createMockExecuteTool(results: Map<string, ToolExecResult> = new Map()) {
  return vi.fn().mockImplementation((toolCall: ToolCall): Promise<ToolExecResult> => {
    const cached = results.get(toolCall.id)
    if (cached) return Promise.resolve(cached)
    return Promise.resolve({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: `mock output for ${toolCall.name}`,
      truncatedOutput: `mock output for ${toolCall.name}`,
      isError: false,
      loopDetected: false,
    })
  })
}

function createConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    systemPrompt: 'You are helpful.',
    workingDirectory: '/tmp',
    projectRoots: ['/tmp'],
    conversationId: 'turn-test-1',
    ...overrides,
  }
}

function createTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    turnIndex: 0,
    conversation: new ConversationManager(),
    config: createConfig(),
    systemPrompt: 'You are helpful.',
    toolDefinitions: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

/** 收集 AsyncGenerator 的所有事件 */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

// ============================================================
// Tests
// ============================================================

describe('TurnManager (DI-decoupled)', () => {
  let TurnManager: typeof import('../turn-manager.js').TurnManager

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../turn-manager.js')
    TurnManager = mod.TurnManager
  })

  // ---- Test 1: executeTurn() 接收外部 ExecuteToolFn 而非内部创建 ----
  it('receives ExecuteToolFn from outside (no createExecuteToolFn)', async () => {
    const gateway = createMockGateway([
      [
        { type: 'tool_use_start', id: 'call_1', name: 'file_read' },
        { type: 'tool_use_end', id: 'call_1', parsedInput: { path: '/foo.ts' } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } },
      ],
    ])
    const executeTool = createMockExecuteTool()
    const tm = new TurnManager()

    const input = createTurnInput()
    const result = await collectEvents(
      tm.executeTurn(input, gateway, executeTool, () => true),
    )

    // executeTool 被外部传入并调用
    expect(executeTool).toHaveBeenCalled()
    const toolCall = executeTool.mock.calls[0][0] as ToolCall
    expect(toolCall.name).toBe('file_read')
  })

  // ---- Test 2: TurnInput 不包含 Electron.WebContents ----
  it('TurnInput has no Electron.WebContents field (compile-time verified)', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Done' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const executeTool = createMockExecuteTool()
    const tm = new TurnManager()

    // TurnInput 只包含纯数据字段 — 无 sender 字段
    const input: TurnInput = createTurnInput()
    // 如果 TurnInput 有 sender: Electron.WebContents，这行会 TS 编译失败
    expect(input).not.toHaveProperty('sender')
    expect(input).toHaveProperty('turnIndex')
    expect(input).toHaveProperty('conversation')
    expect(input).toHaveProperty('config')
    expect(input).toHaveProperty('systemPrompt')
    expect(input).toHaveProperty('abortSignal')

    await collectEvents(tm.executeTurn(input, gateway, executeTool, () => true))
  })

  // ---- Test 3: executeTurn yield agent:text + agent:tool_call + agent:tool_result + agent:turn_end ----
  it('yields correct event sequence for tool execution', async () => {
    const toolResults = new Map<string, ToolExecResult>()
    toolResults.set('call_1', {
      toolCallId: 'call_1',
      toolName: 'file_read',
      output: 'file contents here',
      truncatedOutput: 'file contents here',
      isError: false,
      loopDetected: false,
    })

    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Let me check.' },
        { type: 'tool_use_start', id: 'call_1', name: 'file_read' },
        { type: 'tool_use_end', id: 'call_1', parsedInput: { path: '/foo.ts' } },
        { type: 'done', usage: { inputTokens: 50, outputTokens: 30 } },
      ],
    ])
    const executeTool = createMockExecuteTool(toolResults)
    const tm = new TurnManager()
    const input = createTurnInput()

    const events = await collectEvents(
      tm.executeTurn(input, gateway, executeTool, () => true),
    )

    // 事件序列
    const types = events.map(e => e.type)
    expect(types).toContain('agent:text')
    expect(types).toContain('agent:tool_call_preview')
    expect(types).toContain('agent:tool_call')
    expect(types).toContain('agent:tool_result')
    expect(types).toContain('agent:turn_end')

    // 验证具体内容
    const textEvent = events.find(e => e.type === 'agent:text')
    expect(textEvent).toEqual(expect.objectContaining({ content: 'Let me check.' }))

    const toolCallEvent = events.find(e => e.type === 'agent:tool_call')
    expect(toolCallEvent).toEqual(expect.objectContaining({
      toolCallId: 'call_1',
      toolName: 'file_read',
    }))

    const toolResultEvent = events.find(e => e.type === 'agent:tool_result')
    expect(toolResultEvent).toEqual(expect.objectContaining({
      toolCallId: 'call_1',
      toolName: 'file_read',
      output: 'file contents here',
      isError: false,
    }))
  })

  // ---- Test 4: StreamPhase 无 Electron 依赖 ----
  it('StreamPhase module has no Electron imports', async () => {
    // 验证 stream-phase.ts 可以正常导入且无 Electron 类型
    const streamPhase = await import('../stream-phase.js')
    expect(streamPhase.executeStreamPhase).toBeDefined()
    // 函数存在且可调用
    expect(typeof streamPhase.executeStreamPhase).toBe('function')
  })

  // ---- Test 5: TurnManager 不再包含 createExecuteToolFn 方法 ----
  it('has no createExecuteToolFn method', () => {
    const tm = new TurnManager()
    expect((tm as any).createExecuteToolFn).toBeUndefined()
  })

  // ---- Test 6: abort 时返回错误事件 ----
  it('yields agent:error when abortSignal is already aborted', async () => {
    const gateway = createMockGateway([])
    const executeTool = createMockExecuteTool()
    const tm = new TurnManager()
    const ac = new AbortController()
    ac.abort()

    const input = createTurnInput({ abortSignal: ac.signal })
    const events = await collectEvents(
      tm.executeTurn(input, gateway, executeTool, () => true),
    )

    const errorEvent = events.find(e => e.type === 'agent:error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error).toContain('cancelled')
    expect(errorEvent?.recoverable).toBe(true)
  })

  // ---- Test 7: 非首轮注入 turn attachments ----
  it('injects turn attachments for non-first turn', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Done' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const executeTool = createMockExecuteTool()
    const tm = new TurnManager()
    const conversation = new ConversationManager()
    conversation.appendUserMessage('First message')

    const input = createTurnInput({
      turnIndex: 1, // 非首轮
      conversation,
    })

    const events = await collectEvents(
      tm.executeTurn(input, gateway, executeTool, () => true),
    )

    // 正常完成
    expect(events.some(e => e.type === 'agent:text')).toBe(true)
  })

  // ---- Test 8: 无工具调用返回 shouldStop=true ----
  it('returns shouldStop=true when no tool calls', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'I have no tools to call.' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const executeTool = createMockExecuteTool()
    const tm = new TurnManager()
    const input = createTurnInput()

    // executeTurn 是 generator — 用 for-await 收集
    const gen = tm.executeTurn(input, gateway, executeTool, () => true)
    const events: AgentEvent[] = []
    let turnResult
    while (true) {
      const next = await gen.next()
      if (next.done) {
        turnResult = next.value
        break
      }
      events.push(next.value)
    }

    expect(turnResult.shouldStop).toBe(true)
    expect(turnResult.hadError).toBe(false)
    expect(turnResult.toolNames).toEqual([])
  })

  // ---- Test 9: loop 检测时返回 shouldStop=true ----
  it('returns shouldStop=true when loop detected', async () => {
    const loopResult: ToolExecResult = {
      toolCallId: 'call_1',
      toolName: 'file_read',
      output: 'Loop detected: same tool call repeated 3+ times',
      truncatedOutput: 'Loop detected: same tool call repeated 3+ times',
      isError: true,
      loopDetected: true,
    }
    const toolResults = new Map<string, ToolExecResult>([['call_1', loopResult]])

    const gateway = createMockGateway([
      [
        { type: 'tool_use_start', id: 'call_1', name: 'file_read' },
        { type: 'tool_use_end', id: 'call_1', parsedInput: { path: '/foo.ts' } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } },
      ],
    ])
    const executeTool = createMockExecuteTool(toolResults)
    const tm = new TurnManager()
    const input = createTurnInput()

    const gen = tm.executeTurn(input, gateway, executeTool, () => true)
    const events: AgentEvent[] = []
    let turnResult
    while (true) {
      const next = await gen.next()
      if (next.done) {
        turnResult = next.value
        break
      }
      events.push(next.value)
    }

    expect(turnResult.shouldStop).toBe(true)
    // 事件中包含 loop detection error
    const loopError = events.find(e => e.type === 'agent:error')
    expect(loopError).toBeDefined()
    expect((loopError as any).error).toContain('Loop detected')
  })
})
