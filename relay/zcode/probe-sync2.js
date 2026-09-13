'use strict';

// probe-sync2 — P1.1 第二轮：subscribe deliveryKind / 事件对象原文 /
// session/read(active 后) / 真实最小回合的推送帧形状。
// 会创建一个测试会话并发一句 "只回复 ok"（最小 token 消耗）。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', process.cwd());
const REUSE_SID = flag('--session', null); // 复用已有会话（需先 resume）

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', CWD], {
  cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1;
const pending = new Map();
const pushed = [];
let buffer = '';

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, 15000).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f && f.id != null && (f.result !== undefined || f.error !== undefined) && !f.method) {
      const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); }
    } else {
      pushed.push(f);
      if (f.method && f.id != null) {
        if (f.method === 'session/requestRuntimePreferences') {
          send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        } else {
          console.log(`!! 未预期的反向请求: ${f.method} params=${JSON.stringify(f.params).slice(0, 300)}`);
          send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
        }
      }
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c.toString().slice(0, 200)}`));

function findSessionIds(v, out = new Set(), d = 0) {
  if (d > 8 || v == null) return out;
  if (Array.isArray(v)) { for (const x of v) findSessionIds(x, out, d + 1); return out; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (/^session/i.test(k) && typeof x === 'string' && x.length > 10) out.add(`${k}=${x.slice(0, 12)}…`);
    findSessionIds(x, out, d + 1);
  }
  return out;
}

(async () => {
  const report = {};
  try {
    await sleep(600);
    // 新建或复用测试会话
    let sid = REUSE_SID;
    if (sid) {
      const rs = await request('session/resume', { sessionId: sid });
      console.log('resumed', sid, 'ok=', !rs?.error, rs?.error?.message?.slice(0, 120));
      if (rs?.error) throw new Error('resume failed');
    } else {
      const create = await request('session/create', {
        workspace: { workspaceKey: CWD.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: CWD },
      });
      sid = create?.result?.session?.sessionId;
      report.create = { ok: !!sid };
      console.log('created', sid);
      if (!sid) throw new Error('create failed: ' + JSON.stringify(create?.error));
    }

    // Q5b) active 会话上的 session/read
    const read1 = await request('session/read', { sessionId: sid });
    report.read_active = { bytes: Buffer.byteLength(JSON.stringify(read1?.result ?? {})),
      keys: Object.keys(read1?.result || {}), error: read1?.error?.message?.slice(0, 120) };
    console.log('read(active):', JSON.stringify(report.read_active).slice(0, 240));

    // Q1b) subscribe with deliveryKind
    const sub1 = await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    report.subscribe_replayable = { result: sub1?.result ?? sub1?.error?.message?.slice(0, 300) };
    console.log('subscribe(web-remote-replayable):', JSON.stringify(sub1?.result ?? sub1?.error).slice(0, 400));

    // 真实最小回合
    console.log('sending minimal turn...');
    const send1 = await request('session/send', { sessionId: sid, content: '协议探测：请只回复 ok' });
    report.send = { result: send1?.result ?? send1?.error?.message?.slice(0, 200) };

    // 等回合结束（turn.terminal 出现在推送里）
    const t0 = Date.now();
    while (Date.now() - t0 < 45000 && !pushed.some(f => f.params?.kind === 'turn.terminal')) await sleep(500);
    await sleep(1500);

    // 推送帧统计 + 样本
    report.pushedSummary = {};
    for (const f of pushed) report.pushedSummary[f.method || `resp`] = (report.pushedSummary[f.method || 'resp'] || 0) + 1;
    report.telemetryKinds = {};
    for (const f of pushed) if (f.method === 'v4/telemetry/event') {
      const k = f.params?.kind; report.telemetryKinds[k] = (report.telemetryKinds[k] || 0) + 1;
    }
    console.log('pushed summary:', JSON.stringify(report.pushedSummary));
    console.log('telemetry kinds:', JSON.stringify(report.telemetryKinds));

    // text_delta 帧原文（关键：内容在哪、带不带 sessionId、eventId 形状）
    const textFrames = pushed.filter(f => f.params?.kind === 'text_delta');
    report.textDeltaSample = textFrames.slice(0, 3).map(f => ({
      method: f.method, paramKeys: Object.keys(f.params || {}),
      hasContent: typeof f.params?.delta === 'string',
      sessionIdFields: [...findSessionIds(f)],
      raw: JSON.stringify(f).slice(0, 500),
    }));
    console.log('text_delta frames:', textFrames.length, 'first raw:', report.textDeltaSample[0]?.raw);

    // ★ session/event 订阅推送帧原文（是否带正文内容）
    const subFrames = pushed.filter(f => f.method === 'session/event');
    report.sessionEventFrames = subFrames.map(f => JSON.stringify(f).slice(0, 600));
    report.sessionEventKinds = subFrames.map(f => f.params?.payload?.kind ?? f.params?.type ?? `keys:${Object.keys(f.params || {}).join(',')}`);
    console.log('session/event count:', subFrames.length);
    for (const raw of report.sessionEventFrames.slice(0, 4)) console.log('session/event raw:', raw);

    // stream.chunk（telemetry）原文
    const sc = pushed.find(f => f.params?.kind === 'stream.chunk');
    report.streamChunkRaw = sc ? JSON.stringify(sc).slice(0, 400) : null;
    console.log('stream.chunk raw:', report.streamChunkRaw);

    // state.updated 原文（带不带 sessionId）
    const su = pushed.filter(f => f.method === 'state.updated').slice(0, 2).map(f => JSON.stringify(f).slice(0, 400));
    report.stateUpdatedSamples = su;
    console.log('state.updated samples:', su[0]);

    // events 分页字段：afterSeq 还是 afterEventId
    const ev = await request('session/events', { sessionId: sid, limit: 3 });
    report.eventTopKeys = ev?.result?.events?.[0] ? Object.keys(ev.result.events[0]) : null;
    report.eventRaw = JSON.stringify(ev?.result?.events?.[0] ?? {}).slice(0, 500);
    report.eventsRespKeys = Object.keys(ev?.result || {});
    console.log('event top keys:', report.eventTopKeys, 'respKeys:', report.eventsRespKeys);
    console.log('event raw:', report.eventRaw);

    fs.writeFileSync(path.join(__dirname, 'probe-sync2-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== REPORT SAVED probe-sync2-report.json ===');
  } finally {
    child.removeAllListeners('exit');
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 2500);
  }
})();
