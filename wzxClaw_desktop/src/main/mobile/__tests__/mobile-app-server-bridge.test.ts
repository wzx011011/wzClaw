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
  /** engine.respond/respondError 的记录（反向请求应答回路断言用） */
  responses: Array<{ id: string | number; frame: EngineFrame }> = []
  private scripted = new Map<string, EngineFrame>()
  private notificationListeners: Array<(frame: EngineFrame) => void> = []
  private reverseListeners: Array<(frame: EngineFrame) => void> = []

  /** 按 method 脚本化响应帧 */
  script(method: string, frame: EngineFrame): void {
    this.scripted.set(method, frame)
  }

  /** 模拟引擎通知推送 */
  emitNotification(frame: EngineFrame): void {
    for (const l of this.notificationListeners) l(frame)
  }

  /** 模拟服务端反向请求（字符串 id + method） */
  emitReverseRequest(frame: EngineFrame): void {
    for (const l of this.reverseListeners) l(frame)
  }

  on(event: string, listener: (frame: EngineFrame) => void): unknown {
    if (event === 'notification') this.notificationListeners.push(listener)
    if (event === 'reverseRequest') this.reverseListeners.push(listener)
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

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, frame: { id, result } })
  }

  respondError(id: string | number, code: number, message: string): void {
    this.responses.push({ id, frame: { id, error: { code, message } } })
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

/** 实测 permission 反向请求（options 三档原文，见 APP-SERVER.md） */
const PERMISSION_PARAMS = {
  requestId: 'perm_1',
  toolCallId: 'call_p',
  toolName: 'Bash',
  input: { command: 'printf A > probe-a.txt' },
  reason: 'High risk tools require explicit approval',
  riskLevel: 'high',
  sessionId: 'sess_1',
  options: [
    { kind: 'allow_once', optionId: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
    { kind: 'allow_always', optionId: 'allow_project', response: { decision: 'allow', permissionUpdates: [], reason: 'Approved for this project' } },
    { kind: 'deny', optionId: 'deny', response: { decision: 'deny', reason: 'Denied' } },
  ],
}

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
    engine.script('session/list', ok({
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
    engine.script('session/resume', ok({}))
    engine.script('session/subscribe', ok({}))
    engine.script('session/messages', ok({
      messages: [
        {
          info: { role: 'user', id: 'm0', time: { created: 10 } },
          parts: [{ type: 'text', text: '问题' }],
        },
        {
          info: { role: 'assistant', id: 'm1', time: { created: 20 } },
          parts: [
            { type: 'text', text: '回答' },
            // 实测字段 callID 大写 D（回归锚点）
            { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', output: 'ok' } },
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
    // resume/subscribe/messages 按序调用
    expect(engine.requests.map((r) => r.method)).toEqual([
      'session/resume', 'session/subscribe', 'session/messages',
    ])
  })

  it('resume -32004 → SESSION_BUSY 专用文案（运行时单归属是设计）', async () => {
    const engine = new FakeEngine()
    engine.script('session/resume', { error: { code: -32004, message: 'Session is not active' } })
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('session:load:request', { requestId: 'r4', sessionId: 'sess_busy' })
    const err = log.find((e) => e.event === 'session:error') as
      { data: { error: string; code: string } } | undefined
    expect(err?.data.code).toBe('SESSION_BUSY')
    expect(err?.data.error).toContain('桌面端运行中')
  })

  it('command:send → 先订阅后发送 + ack', async () => {
    const engine = new FakeEngine()
    engine.script('session/send', ok({ accepted: true, sessionId: 'sess_1' }))
    engine.script('session/subscribe', ok({}))
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('command:send', {
      content: 'hi', messageId: 'm-1', sessionId: 'sess_1',
    })
    const sendReq = engine.requests.find((r) => r.method === 'session/send')
    expect(sendReq?.params).toMatchObject({ sessionId: 'sess_1', content: 'hi' })
    expect(log.some((e) => e.event === 'command:ack')).toBe(true)
    // subscribe 必须先于 send（后订阅会丢开头事件）
    const methods = engine.requests.map((r) => r.method)
    expect(methods.indexOf('session/subscribe')).toBeLessThan(methods.indexOf('session/send'))
  })

  it('实测单事件通知（type/payload 顶层）→ stream:agent:*', async () => {
    const engine = new FakeEngine()
    engine.script('session/send', ok({ accepted: true }))
    engine.script('session/subscribe', ok({}))
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    await bridge.handleMessage('command:send', { content: 'hi', sessionId: 'sess_1' })

    engine.emitNotification({
      method: 'session/event',
      params: {
        deliveryKind: 'web-remote-replayable', eventId: 'e1', seq: 1, sessionId: 'sess_1',
        turnId: 'turn_1', type: 'model.streaming',
        payload: { assistantMessageId: 'msg_1', kind: 'text_delta', delta: 'answer', done: false },
      },
    })
    engine.emitNotification({
      method: 'session/event',
      params: {
        sessionId: 'sess_1', eventId: 'e2', seq: 2, type: 'turn.completed',
        payload: { response: 'answer', resultType: 'completed', tokenCount: 5 },
      },
    })
    expect(log.some((e) => e.event === 'stream:agent:text' && (e.data as { content: string }).content === 'answer')).toBe(true)
    expect(log.some((e) => e.event === 'stream:agent:turn_end')).toBe(true)
    expect(log.some((e) => e.event === 'stream:agent:done')).toBe(true)
  })

  it('subscribe 快照（events 数组）→ 翻译兼容路径', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    bridge // eslint-disable-line

    engine.emitNotification({
      method: 'session/event',
      params: {
        sessionId: 'sess_1',
        events: [{ sessionId: 'sess_1', type: 'model.streaming', payload: { kind: 'text_delta', delta: 'answer' } }],
      },
    })
    expect(log.some((e) => e.event === 'stream:agent:text')).toBe(true)
  })

  it('runtimePreferences 反向请求自动代答 false', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    engine.emitReverseRequest({ id: 'server-1', method: 'session/requestRuntimePreferences', params: {} })
    expect(engine.responses).toEqual([
      { id: 'server-1', frame: { id: 'server-1', result: { nativeSearchEnhancementsEnabled: false } } },
    ])
    void log
  })

  it('权限闭环：反向请求转推手机 → permission:response 回放 option.response 原文', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    engine.emitReverseRequest({ id: 'server-3', method: 'interaction/requestPermission', params: PERMISSION_PARAMS })
    const req = log.find((e) => e.event === 'stream:agent:permission_request') as
      { data: Record<string, unknown> } | undefined
    expect(req?.data).toMatchObject({
      requestId: 'perm_1', toolCallId: 'call_p', toolName: 'Bash', riskLevel: 'high',
    })
    expect((req?.data.options as unknown[]).length).toBe(3)

    // 旧 chat_store 应答形状 {toolCallId, approved}（无 remember → allow_once）
    await bridge.handleMessage('permission:response', { toolCallId: 'call_p', approved: true })
    expect(engine.responses).toEqual([
      { id: 'server-3', frame: { id: 'server-3', result: { decision: 'allow', reason: 'Approved once' } } },
    ])
  })

  it('权限闭环：approved+remember → allow_project（带 permissionUpdates）', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    engine.emitReverseRequest({ id: 'server-4', method: 'interaction/requestPermission', params: PERMISSION_PARAMS })

    await bridge.handleMessage('permission:response', { requestId: 'perm_1', approved: true, remember: true })
    expect(engine.responses[0]?.frame.result).toMatchObject({ decision: 'allow', reason: 'Approved for this project' })
  })

  it('权限闭环：拒绝 → deny 选项原文', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    engine.emitReverseRequest({ id: 'server-5', method: 'interaction/requestPermission', params: PERMISSION_PARAMS })

    await bridge.handleMessage('permission:response', { toolCallId: 'call_p', approved: false })
    expect(engine.responses[0]?.frame.result).toEqual({ decision: 'deny', reason: 'Denied' })
  })

  it('permission.resolved 事件 → permission_resolved 广播 + 清待答表', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    engine.emitReverseRequest({ id: 'server-6', method: 'interaction/requestPermission', params: PERMISSION_PARAMS })
    engine.emitNotification({
      method: 'session/event',
      params: { sessionId: 'sess_1', type: 'permission.resolved', payload: { requestId: 'perm_1', toolCallId: 'call_p', decision: 'deny' } },
    })
    expect(log.some((e) => e.event === 'stream:agent:permission_resolved')).toBe(true)
    // 待答表已清：此后应答按迟到丢弃（不 respond）
    await bridge.handleMessage('permission:response', { toolCallId: 'call_p', approved: true })
    expect(engine.responses.length).toBe(0)
  })

  it('未知反向请求 → 安全拒绝 error 帧（-32000）', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    engine.emitReverseRequest({ id: 'server-9', method: 'interaction/test', params: {} })
    expect(engine.responses).toEqual([
      { id: 'server-9', frame: { id: 'server-9', error: { code: -32000, message: expect.stringContaining('interaction/test') } } },
    ])
    expect(log.some((e) => e.event === 'stream:agent:permission_request')).toBe(false)
  })

  it('迟到权限应答：无待答帧 → 丢弃不 crash', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    await bridge.handleMessage('permission:response', { toolCallId: 'ghost', approved: true })
    expect(engine.responses.length).toBe(0)
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
    // 不注入引擎且无 engineCommand → ensureEngine 为 null → false
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
    engine.script('session/list', { error: { code: -32004, message: 'Session is not active' } })
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)

    await bridge.handleMessage('session:list:request', { requestId: 'rE' })
    const err = log.find((e) => e.event === 'session:error') as
      { data: { error: string } } | undefined
    expect(err?.data.error).toContain('Session is not active')
  })

  it('stop 后 handleMessage 返回 false（不再拉起引擎）', async () => {
    const engine = new FakeEngine()
    const log: Array<{ event: string; data: unknown }> = []
    const bridge = makeBridge(engine, log)
    await bridge.handleMessage('session:list:request', { requestId: 'r1' })
    await bridge.stop()
    const handled = await bridge.handleMessage('session:list:request', { requestId: 'r2' })
    expect(handled).toBe(false)
  })
})

// 保持 vi 引入（stubEnv 备用）
void vi
