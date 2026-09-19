import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppServerEngine } from '../app-server-engine'
import { translateEngineEvent } from '../app-server-translate'

// 引擎子进程夹具：FAKE_MODE 控制行为
// - normal：响应 session/list（固定结果）+ session/boom（错误帧），
//   启动即发实测形状 session/event 通知 + server-N 反向请求
//   （runtimePrefs 期待代答；interaction/test 期待 error 帧拒绝）；
//   未知方法静默（测超时）
// - crash-once：<marker> 文件不存在则立即退出；存在则正常响应
//   （验证崩溃自动重启）
function writeFakeEngine(dir: string): string {
  const file = path.join(dir, 'fake-app-server.cjs')
  writeFileSync(
    file,
    `'use strict';
const fs = require('node:fs');
const mode = process.env.FAKE_MODE || 'normal';
const marker = process.env.FAKE_MARKER;
if (mode === 'crash-once' && marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'crashed');
  process.exit(1);
}
let buf = '';
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
// 实测形状：单事件 type/payload 在 params 顶层（APP-SERVER.md）
send({ method: 'session/event', params: { sessionId: 'sess_x', eventId: 'e1', seq: 1, type: 'model.streaming', payload: { kind: 'text_delta', delta: 'hello', done: false } } });
// 反向请求：runtimePrefs 期待被代答；答对后回执探针通知
send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
// 未知反向请求：期待 error 帧安全拒绝
send({ id: 'server-2', method: 'interaction/test', params: {} });
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line) } catch { continue }
    if (f.method === 'session/list') {
      send({ id: f.id, result: { sessions: [{ sessionId: 'sess_mock', title: 'mock' }] } });
    } else if (f.method === 'session/boom') {
      send({ id: f.id, error: { code: -32031, message: 'boom' } });
    } else if (f.id === 'server-1') {
      send({ method: 'fake/runtime-prefs', params: { answered: f.result != null && f.result.nativeSearchEnhancementsEnabled === false } });
    } else if (f.id === 'server-2') {
      send({ method: f.error !== undefined ? 'fake/interaction-denied' : 'fake/interaction-answered', params: {} });
    }
    // 其它方法：静默（由请求超时兜底）
  }
});
`,
    'utf8',
  )
  return file
}

describe('AppServerEngine', () => {
  let dir: string
  let fakeEngine: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'as-engine-'))
    fakeEngine = writeFakeEngine(dir)
  })
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })

  it('roundtrip：请求/响应 + 通知事件 + 反向请求应答 + 错误帧透传', async () => {
    const engine = new AppServerEngine({
      command: process.execPath,
      args: [fakeEngine],
      cwd: dir,
      env: { ...process.env, FAKE_MODE: 'normal' },
      requestTimeoutMs: 3000,
    })
    const notifications: unknown[] = []
    const reverseRequests: Array<{ id: string | number; method?: string }> = []
    engine.on('notification', (frame) => notifications.push(frame))
    engine.on('reverseRequest', (frame) => {
      reverseRequests.push(frame)
      // runtimePrefs 代答；未知请求安全拒绝
      if (frame.method === 'session/requestRuntimePreferences') {
        engine.respond(frame.id as string, { nativeSearchEnhancementsEnabled: false })
      } else {
        engine.respondError(frame.id as string, -32000, 'denied')
      }
    })

    engine.start()
    const list = await engine.request('session/list')
    expect(
      (list.result as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId,
    ).toBe('sess_mock')
    // 实测形状通知已被转发
    expect(notifications.length).toBeGreaterThanOrEqual(1)
    // 两条启动期反向请求都被识别并转给订阅者
    expect(reverseRequests.map((r) => r.method)).toEqual([
      'session/requestRuntimePreferences',
      'interaction/test',
    ])
    // fixture 收到应答后回执探针通知（denied 名区分 error 帧）
    await new Promise((r) => setTimeout(r, 200))

    const boom = await engine.request('session/boom')
    expect(boom.error?.code).toBe(-32031)

    await engine.stop()
    expect(engine.running).toBe(false)
  })

  it('未知方法：按请求超时回错误帧（-32022）', async () => {
    const engine = new AppServerEngine({
      command: process.execPath,
      args: [fakeEngine],
      cwd: dir,
      env: { ...process.env, FAKE_MODE: 'normal' },
      requestTimeoutMs: 3000,
    })
    engine.start()
    const resp = await engine.request('session/never-answers', undefined, 400)
    expect(resp.error?.code).toBe(-32022)
    await engine.stop()
  })

  it('stop 后请求直接返回 engine not running', async () => {
    const engine = new AppServerEngine({
      command: process.execPath,
      args: [fakeEngine],
      cwd: dir,
      env: { ...process.env, FAKE_MODE: 'normal' },
    })
    engine.start()
    await engine.stop()
    const resp = await engine.request('session/list')
    expect(resp.error?.code).toBe(-32000)
  })

  it('子进程立即崩溃：自动重启后正常响应（restartCount=1）', async () => {
    // crash-once 夹具：首次 spawn 无 marker → 写 marker 后退出；
    // 引擎自动重启 → 第二次 spawn 正常响应
    const marker = path.join(dir, 'crash-marker')
    const engine = new AppServerEngine({
      command: process.execPath,
      args: [fakeEngine],
      cwd: dir,
      env: { ...process.env, FAKE_MODE: 'crash-once', FAKE_MARKER: marker },
      restartDelayMs: 50,
      requestTimeoutMs: 3000,
    })
    engine.start()

    // 轮询等待重启后的实例就绪（最多 3s）
    let resp: Awaited<ReturnType<typeof engine.request>> | null = null
    for (let i = 0; i < 30 && resp === null; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const attempt = await engine.request('session/list')
      if (attempt.error?.code === -32022) continue // 仍在退避窗口
      if (attempt.error?.code === -32000 && !engine.running) continue
      resp = attempt
    }
    expect(resp).not.toBeNull()
    expect(
      (resp!.result as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId,
    ).toBe('sess_mock')
    expect(engine.restartCount).toBe(1)
    await engine.stop()
  })

  it('feed 注入：reverse-request 字符串 id 不误配数字 pending', () => {
    const engine = new AppServerEngine({ command: 'node', cwd: dir })
    const reverse: Array<{ id: string | number }> = []
    engine.on('reverseRequest', (frame) => reverse.push(frame))
    // 字符串 id + method = 反向请求；数字 id + result = 应答
    engine.feed('{"id":"server-9","method":"interaction/requestPermission","params":{}}\n')
    engine.feed('{"id":1,"result":{"ok":true}}\n')
    expect(reverse.length).toBe(1)
    expect(reverse[0].id).toBe('server-9')
  })
})

describe('translateEngineEvent（实测词典翻译表）', () => {
  it('model.streaming text_delta → stream:agent:text（实测单事件形状）', () => {
    const frames = translateEngineEvent('s1', 'model.streaming', { kind: 'text_delta', delta: 'hello', done: false })
    expect(frames).toEqual([
      { event: 'stream:agent:text', data: { sessionId: 's1', content: 'hello' } },
    ])
  })

  it('model.streaming reasoning_delta → stream:agent:thinking', () => {
    const frames = translateEngineEvent('s1', 'model.streaming', { kind: 'reasoning_delta', delta: 'thinking…' })
    expect(frames[0].event).toBe('stream:agent:thinking')
    expect(frames[0].data).toMatchObject({ sessionId: 's1', content: 'thinking…' })
  })

  it('tool.updated 轨迹：scheduled→tool_call；result→tool_result（content/success）', () => {
    const call = translateEngineEvent('s1', 'tool.updated', {
      toolCallId: 'c1', toolName: 'Bash', kind: 'scheduled', inputOmitted: true,
    })
    expect(call[0].event).toBe('stream:agent:tool_call')
    expect(call[0].data).toMatchObject({ sessionId: 's1', toolCallId: 'c1', toolName: 'Bash' })

    const result = translateEngineEvent('s1', 'tool.updated', {
      toolCallId: 'c1', kind: 'result', result: { success: true, content: 'echo 输出' }, duration: 12,
    })
    expect(result[0].event).toBe('stream:agent:tool_result')
    expect(result[0].data).toMatchObject({ sessionId: 's1', toolCallId: 'c1', output: 'echo 输出', isError: false })

    const failed = translateEngineEvent('s1', 'tool.updated', {
      toolCallId: 'c1', kind: 'result', result: { success: false, content: 'boom' },
    })
    expect(failed[0].data).toMatchObject({ isError: true })
    // progress/batch：旧协议无对应 → 空数组（调用方留观测）
    expect(translateEngineEvent('s1', 'tool.updated', { toolCallId: 'c1', kind: 'progress' })).toEqual([])
    expect(translateEngineEvent('s1', 'tool.updated', { kind: 'batch', toolCallIds: ['c1'] })).toEqual([])
  })

  it('turn.started → running；turn.completed → turn_end + done', () => {
    expect(translateEngineEvent('s1', 'turn.started', {})[0].event).toBe('stream:agent:running')
    const frames = translateEngineEvent('s1', 'turn.completed', {
      response: '全文', resultType: 'completed', tokenCount: 5, duration: 100, toolCallCount: 0,
    })
    expect(frames.map((f) => f.event)).toEqual(['stream:agent:turn_end', 'stream:agent:done'])
    expect(frames[1].data).toMatchObject({ sessionId: 's1', status: 'completed' })
  })

  it('permission.resolved → stream:agent:permission_resolved', () => {
    const frames = translateEngineEvent('s1', 'permission.resolved', {
      requestId: 'perm_1', toolCallId: 'call_p', decision: 'allow', reason: 'Approved once',
    })
    expect(frames[0].event).toBe('stream:agent:permission_resolved')
    // 词典不含 reason（与手机端 zcode_protocol_translate.dart 一致）
    expect(frames[0].data).toEqual({ sessionId: 's1', requestId: 'perm_1', toolCallId: 'call_p', decision: 'allow' })
  })

  it('model.error → stream:agent:error；未识别 type → 空', () => {
    expect(translateEngineEvent('s1', 'model.error', { error: 'quota' })[0].data).toMatchObject({ error: 'quota' })
    expect(translateEngineEvent('s1', 'session.updated', { title: 'x' })).toEqual([])
  })
})
