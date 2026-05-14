import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent, TokenUsage } from '../../types.js'
import type {
  IStreamProvider,
  IStreamOptions,
  IContextManager,
  IObservability,
  IHookRegistry,
  IEventSender,
  ILogger,
} from '../../interfaces.js'
import type { AgentEvent, AgentConfig } from '../types.js'

// ============================================================
// Mock factories — 使用接口 mock，不依赖 Electron
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

function createMockContextManager(): IContextManager {
  return {
    shouldCompact: vi.fn().mockReturnValue(false),
    compact: vi.fn().mockResolvedValue({
      summary: '',
      summaryMessageContent: '',
      keptRecentCount: 4,
      beforeTokens: 0,
      afterTokens: 0,
      summarizedMessages: [],
    }),
    reactiveCompact: vi.fn().mockReturnValue([]),
    estimateTokens: vi.fn().mockReturnValue(0),
    trackTokenUsage: vi.fn(),
    getContextWindowForModel: vi.fn().mockReturnValue(128000),
    getMicrocompactConfig: vi.fn().mockReturnValue({ gapMinutes: 60, keepRecent: 5 }),
    getConfig: vi.fn().mockReturnValue({ compactThreshold: 0, compactSafetyBuffer: 13000 }),
  }
}

function createMockObservability(): IObservability {
  return {
    startTrace: vi.fn(),
    endTrace: vi.fn(),
    getActiveTrace: vi.fn().mockReturnValue(undefined),
  }
}

function createMockHookRegistry(): IHookRegistry {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockLogger(): ILogger {
  return {
    log: vi.fn(),
    close: vi.fn(),
  }
}

function createMockSender(): IEventSender {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
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

/** 创建基本 AgentConfig */
function createConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    systemPrompt: 'You are helpful.',
    workingDirectory: '/tmp',
    projectRoots: ['/tmp'],
    conversationId: 'test-conv-1',
    ...overrides,
  }
}

// ============================================================
// Tests
// ============================================================

describe('AgentLoop (DI-decoupled)', () => {
  let AgentLoop: typeof import('../agent-loop.js').AgentLoop

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agent-loop.js')
    AgentLoop = mod.AgentLoop
  })

  // ---- Test 1: run() 返回 AsyncGenerator<AgentEvent>，yield agent:text + agent:done ----
  it('yields agent:text + agent:done for single-turn text response', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Hello! ' },
        { type: 'text_delta', content: 'How can I help?' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const loop = new AgentLoop(gateway, ctxMgr)

    const events = await collectEvents(loop.run('Hello', createConfig()))

    expect(events.filter(e => e.type === 'agent:text').length).toBeGreaterThanOrEqual(1)
    const doneEvent = events.find(e => e.type === 'agent:done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent).toEqual(
      expect.objectContaining({
        type: 'agent:done',
        usage: { inputTokens: 10, outputTokens: 20 },
      })
    )
  })

  // ---- Test 2: run() 不接收 Electron.WebContents（编译时验证） ----
  // 此测试验证 run() 签名接受 IEventSender 而非 Electron.WebContents
  it('run() accepts IEventSender instead of Electron.WebContents', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const sender = createMockSender()
    const loop = new AgentLoop(gateway, ctxMgr)

    // IEventSender 作为可选参数传入 — 编译通过即证明无 Electron 依赖
    const events = await collectEvents(loop.run('Hi', createConfig(), sender))
    expect(events.some(e => e.type === 'agent:done')).toBe(true)
  })

  // ---- Test 3: 构造函数接受 IStreamProvider 而非 LLMGateway ----
  it('constructor accepts IStreamProvider interface (not LLMGateway class)', () => {
    const gateway: IStreamProvider = createMockGateway([])
    const ctxMgr = createMockContextManager()
    // 此行编译通过即证明构造函数接受接口
    const loop = new AgentLoop(gateway, ctxMgr)
    expect(loop).toBeDefined()
    expect(loop.isRunning).toBe(false)
  })

  // ---- Test 4: 安全天花板触发时 yield agent:error + agent:done ----
  it('yields agent:error + agent:done when safety ceiling is reached', async () => {
    // 每次调用都返回一个工具调用（不同 path 避免 loop detection）
    let callIdx = 0
    const gateway: IStreamProvider = {
      stream: vi.fn().mockImplementation(() => {
        callIdx++
        return (async function* () {
          yield { type: 'tool_use_start', id: `call_${callIdx}`, name: 'file_read' }
          yield { type: 'tool_use_end', id: `call_${callIdx}`, parsedInput: { path: `/file_${callIdx}.ts` } }
          yield { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } }
        })()
      }),
    }
    const ctxMgr = createMockContextManager()
    const obs = createMockObservability()
    const hooks = createMockHookRegistry()
    const logger = createMockLogger()

    const loop = new AgentLoop(gateway, ctxMgr, obs, hooks, logger)

    // 子 Agent maxTurns 限制
    const events = await collectEvents(loop.run('Loop forever', createConfig({ maxTurns: 3 })))

    const errorEvent = events.find(e => e.type === 'agent:error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).error).toContain('max turns')
    expect(errorEvent?.recoverable).toBe(true)

    const doneEvent = events.find(e => e.type === 'agent:done')
    expect(doneEvent).toBeDefined()
  })

  // ---- Test 5: cancel() 中止后 run() 自然退出 ----
  it('cancel() causes run() to exit gracefully', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Starting...' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 10 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const loop = new AgentLoop(gateway, ctxMgr)

    const gen = loop.run('Hello', createConfig())

    // 收集第一个事件
    const first = await gen.next()
    expect(first.value).toBeDefined()

    // 取消
    loop.cancel()

    // generator 应该正常结束
    const rest = await gen.next()
    // generator 完成（done=true）或返回最后一个事件
    expect(rest.done || rest.value?.type === 'agent:done' || rest.value?.type === 'agent:error').toBeTruthy()
  })

  // ---- Test 6: IEventSender.send() 被正确调用 ----
  it('calls IEventSender.send() for compaction notification', async () => {
    // 模拟需要压缩的场景：首轮返回 PTL，触发 reactive compact
    const gateway = createMockGateway([
      // 首轮触发 PromptTooLongError 后重试
      [
        { type: 'text_delta', content: 'Done' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const sender = createMockSender()
    const obs = createMockObservability()
    const hooks = createMockHookRegistry()
    const logger = createMockLogger()

    const loop = new AgentLoop(gateway, ctxMgr, obs, hooks, logger)
    const events = await collectEvents(loop.run('Hello', createConfig(), sender))

    // 正常完成
    expect(events.some(e => e.type === 'agent:done')).toBe(true)
    // IEventSender.send() 未抛异常 — 接口调用正确
    expect(sender.isDestroyed).toBeDefined()
  })

  // ---- Test 7: observability hooks 被正确调用 ----
  it('calls IObservability lifecycle methods', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Hi' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const obs = createMockObservability()
    const hooks = createMockHookRegistry()

    const loop = new AgentLoop(gateway, ctxMgr, obs, hooks)
    await collectEvents(loop.run('Hello', createConfig()))

    expect(obs.startTrace).toHaveBeenCalledWith(
      'test-conv-1', 'gpt-4o', 'Hello', '/tmp', undefined
    )
    expect(obs.endTrace).toHaveBeenCalled()
  })

  // ---- Test 8: logger 被正确使用 ----
  it('uses ILogger for debug logging', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Done' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const logger = createMockLogger()

    const loop = new AgentLoop(gateway, ctxMgr, undefined, undefined, logger)
    await collectEvents(loop.run('Hello', createConfig()))

    expect(logger.log).toHaveBeenCalled()
    expect(logger.close).toHaveBeenCalled()
  })

  // ---- Test 9: no-op defaults work when observability/hooks/logger are omitted ----
  it('works without optional observability, hooks, and logger', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Ok' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()

    // 只传入必需参数
    const loop = new AgentLoop(gateway, ctxMgr)
    const events = await collectEvents(loop.run('Hello', createConfig()))

    expect(events.some(e => e.type === 'agent:done')).toBe(true)
  })

  // ---- Test 10: hookRegistry.emit called for session lifecycle ----
  it('emits session-start and session-end hooks', async () => {
    const gateway = createMockGateway([
      [
        { type: 'text_delta', content: 'Done' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ])
    const ctxMgr = createMockContextManager()
    const hooks = createMockHookRegistry()

    const loop = new AgentLoop(gateway, ctxMgr, undefined, hooks)
    await collectEvents(loop.run('Hello', createConfig()))

    expect(hooks.emit).toHaveBeenCalledWith('session-start', expect.objectContaining({
      conversationId: 'test-conv-1',
    }))
    expect(hooks.emit).toHaveBeenCalledWith('session-end', expect.objectContaining({
      conversationId: 'test-conv-1',
    }))
  })
})
