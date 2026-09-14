import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileAppServerBridge,
  brainEngineEnabled,
  resetBrainBridgeForTest,
  type EngineFrame,
  type EngineLike,
} from '../mobile-app-server-bridge'

// ── Fake engine ─────────────────────────────────────────────────────

class FakeEngine implements EngineLike {
  running = true
  requests: Array<{ method: string; params?: unknown }> = []
  private scripted = new Map<string, EngineFrame>()
  private notificationListeners: Array<(frame: EngineFrame) => void> = []

  /** 按 method 脚本化响应帧 */
  respond(method: string, frame: EngineFrame): void {
    this.scripted.set(method, frame)
  }

  /** 模拟引擎通知推送 */
  emitNotification(frame: EngineFrame): void {
    for (const l of this.notificationListeners) l(frame)
  }

  on(event: string, listener: (frame: EngineFrame) => void): unknown {
    if (event === 'notification') this.notificationListeners.push(listener)
    return this
  }

  start(): void {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<EngineFrame> {
    void timeoutMs
    this.requests.push({ method, params })
    const scripted = this.scripted.get(method)
    return Promise.resolve(
      scripted ?? { error: { code: -32022, message: `timeout: ${method}` } },
    )
  }
}

// ── 桥构造辅助 ──────────────────────────────────────────────────────

function makeBridge(engine: EngineLike, broadcastLog: Array<{ event: string; data: unknown }>) {
  return new MobileAppServerBridge({
    cwd: '/tmp/ws',
    brainName: 'brain-test',
    apiKey: 'dummy-key',
    broadcast: (event, data) => broadcastLog.push({ event, data }),
    engine,
    logger: () => {},
  })
}

const ok = (result: unknown): EngineFrame => ({ result })

afterEach(() => {
  delete process.env.WZXCLAW_BRAIN_ENGINE
  resetBrainBridgeForTest()
  vi.restoreAllMocks()
})

describe('brainEngineEnabled', () => {
  it('默认关闭；WZXCLAW_BRAIN_ENGINE=1 开启', () => {
    process.env.WZXCLAW_BRAIN_ENGINE = undefined as unknown as string
    expect(brainEngineEnabled()).toBe(false)
    process.env.WZXCLAW_BRAIN_ENGINE = '1'
    expect(brainEngineEnabled()).toBe(true)
  })
})

describe('MobileAppServerBridge', () => {
  it('session:list → engine session/list → 旧响应形状', async () => {
    const engine = new FakeEngine()
    engine.respond('session/list', ok({
      sessions: [{ sessionId: 'sess_1', title: 'T1', updatedAt: 100, status: 'idle' }],
    }))
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    const handled = await bridge.handleMessage('session:list:request', { requestId: 'r1' })
    expect(handled).toBe(true)
    expect(engine.requests[0]?.method).toBe('session/list')

    const resp = log.find((e) => e.event === 'session:list:response') as {
      data: { requestId: string; sessions: Array<{ id: string; title: string; isRunning: boolean }> }
    }
    expect(resp.data.requestId).toBe('r1')
    expect(resp.data.sessions[0]).toMatchObject({ id: 'sess_1', title: 'T1', isRunning: false })
  })

  it('session:load → resume+subscribe+messages → 旧 ChatMessage 形状', async () => {
    const engine = new FakeEngine()
    engine.respond('session/resume', ok({}))
    engine.respond('session/subscribe', ok({}))
    engine.respond('session/messages', ok({
      messages: [
        {
          info: { role: 'user', id: 'm0', time: { created: 10 } },
          parts: [{ type: 'text', text: '问题' }],
        },
        {
          info: { role: 'assistant', id: 'm1', time: { created: 20 } },
          parts: [
            { type: 'text', text: '回答' },
            { type: 'tool', callId: 'c1', tool: 'bash', state: { status: 'completed', output: 'ok' } },
            { type: 'step-finish', tokens: { total: 500, output: 50 } },
          ],
        },
      ],
    }))
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('session:load:request', { requestId: 'r2', sessionId: 'sess_9' })
    const resp = log.find((e) => e.event === 'session:load:response') as {
      data: { requestId: string; sessionId: string; messages: Array<Record<string, unknown>> }
    }
    expect(resp.data.sessionId).toBe('sess_9')
    // 空内容行被过滤
    expect(resp.data.messages.length).toBe(2)
    const assistant = resp.data.messages[1]
    expect(assistant).toMatchObject({ role: 'assistant', content: '回答' })
    expect(assistant.tool_calls).toEqual([
      expect.objectContaining({ toolCallId: 'c1', toolName: 'bash', status: 'done' }),
    ])
    expect(assistant.usage).toMatchObject({ output_tokens: 50 })
    // resume/subscribe 已按序调用
    expect(engine.requests.map((r) => r.method)).toEqual([
      'session/resume', 'session/subscribe', 'session/messages',
    ])
  })

  it('command:send → ack + session/send + 通知翻译为 stream:agent:*', async () => {
    const engine = new FakeEngine()
    engine.respond('session/send', ok({ accepted: true, sessionId: 'sess_1' }))
    engine.respond('session/subscribe', ok({}))
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('command:send', {
      content: 'hi', messageId: 'm-1', sessionId: 'sess_1',
    })
    const sendReq = engine.requests.find((r) => r.method === 'session/send')
    expect(sendReq?.params).toMatchObject({ sessionId: 'sess_1', content: 'hi' })
    expect(log.some((e) => e.event === 'command:ack')).toBe(true)

    // 引擎通知推送：text_delta + turn.terminal 翻译为手机事件
    engine.emitNotification({
      method: 'session/event',
      params: {
        sessionId: 'sess_1',
        events: [
          { payload: { kind: 'text_delta', delta: 'answer' } },
          { payload: { kind: 'turn.terminal', status: 'completed' } },
        ],
      },
    })
    const texts = log.filter((e) => e.event === 'stream:agent:text')
    expect(texts.length).toBeGreaterThanOrEqual(1)
    expect(texts[0].data).toMatchObject({ sessionId: 'sess_1', content: 'answer' })
    expect(log.some((e) => e.event === 'stream:agent:turn_end')).toBe(true)
    expect(log.some((e) => e.event === 'stream:agent:done')).toBe(true)
  })

  it('command:stop → session/stop', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('command:stop', { sessionId: 'sess_1' })
    expect(engine.requests.some((r) => r.method === 'session/stop')).toBe(true)
  })

  it('未启用引擎时 handleMessage 返回 false（回落旧处理器）', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    // 不调用 ensureEngine：直接 handleMessage 走 ensureEngine —— 已注入引擎则处理；
    // 未注入（engineCommand 缺失）→ null → false
    const bare = new MobileAppServerBridge({
      cwd: '/tmp/ws',
      brainName: 'b',
      broadcast: (e, d) => log.push({ event: e, data: d }),
      logger: () => {},
    })
    const handled = await bare.handleMessage('session:list:request', { requestId: 'r0' })
    expect(handled).toBe(false)
    void engine
  })

  it('request 拒绝路径 → session:error 广播', async () => {
    const engine = new FakeEngine()
    engine.respond('session/list', { error: { code: -32004, message: 'Session is not active' } })
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('session:list:request', { requestId: 'rE' })
    const err = log.find((e) => e.event === 'session:error') as
      { data: { error: string } } | undefined
    expect(err?.data.error).toContain('Session is not active')
  })
})

// 保持 vi 引入（stubEnv 备用）
void vi
