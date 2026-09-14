import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppServerEngine } from '../app-server-engine'
import { translateEnginePayload } from '../app-server-translate'

// 引擎子进程夹具：FAKE_MODE 控制行为
// - normal：响应 session/list（固定结果）+ session/boom（错误帧），
//   启动即发一条 session/event text_delta 通知；未知方法静默（测超时）
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
send({ method: 'session/event', params: { sessionId: 'sess_x', events: [{ payload: { kind: 'text_delta', delta: 'hello' } }] } });
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

  it('roundtrip：请求/响应 + 通知事件 + 错误帧透传', async () => {
    const engine = new AppServerEngine({
      command: process.execPath,
      args: [fakeEngine],
      cwd: dir,
      env: { ...process.env, FAKE_MODE: 'normal' },
      requestTimeoutMs: 3000,
    })
    const notifications: unknown[] = []
    engine.on('notification', (frame) => notifications.push(frame))

    engine.start()
    const list = await engine.request('session/list')
    expect(
      (list.result as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId,
    ).toBe('sess_mock')
    // 引擎启动通知已被转发
    expect(notifications.length).toBeGreaterThanOrEqual(1)

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
})

describe('translateEnginePayload（翻译表）', () => {
  it('text_delta → stream:agent:text', () => {
    const frames = translateEnginePayload('s1', { kind: 'text_delta', delta: 'hello' })
    expect(frames).toEqual([
      { event: 'stream:agent:text', data: { sessionId: 's1', content: 'hello' } },
    ])
  })

  it('reasoning_delta → stream:agent:thinking', () => {
    const frames = translateEnginePayload('s1', { kind: 'reasoning_delta', delta: 'thinking…' })
    expect(frames[0].event).toBe('stream:agent:thinking')
    expect(frames[0].data).toMatchObject({ sessionId: 's1', content: 'thinking…' })
  })

  it('tool.call / tool.result → tool_call / tool_result', () => {
    const call = translateEnginePayload('s1', {
      kind: 'tool.call', callId: 'c1', tool: 'bash', input: { cmd: 'echo' },
    })
    expect(call[0].event).toBe('stream:agent:tool_call')
    expect(call[0].data).toMatchObject({ sessionId: 's1', toolCallId: 'c1', toolName: 'bash' })

    const result = translateEnginePayload('s1', { kind: 'tool.result', callId: 'c1', output: 'echo' })
    expect(result[0].event).toBe('stream:agent:tool_result')
    expect(result[0].data).toMatchObject({ sessionId: 's1', toolCallId: 'c1', isError: false })
  })

  it('turn.terminal → turn_end + done 两帧', () => {
    const frames = translateEnginePayload('s1', { kind: 'turn.terminal', status: 'completed' })
    expect(frames.map((f) => f.event)).toEqual(['stream:agent:turn_end', 'stream:agent:done'])
    expect(frames[1].data).toMatchObject({ sessionId: 's1', status: 'completed' })
  })

  it('model.error → stream:agent:error', () => {
    const frames = translateEnginePayload('s1', { kind: 'model.error', message: 'quota' })
    expect(frames[0].event).toBe('stream:agent:error')
    expect(frames[0].data).toMatchObject({ sessionId: 's1', error: 'quota' })
  })

  it('null kind 按 text_delta 直通；无关 payload 返回空', () => {
    expect(translateEnginePayload('s1', { delta: 'x' })[0].event).toBe('stream:agent:text')
    expect(translateEnginePayload('s1', { projection: {} })).toEqual([])
  })
})
