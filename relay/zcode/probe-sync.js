'use strict';

// probe-sync — P1.1 同步层协议实测（只读，不 session/send，不花 token）：
//   Q1 session/subscribe 语义与推送帧形状
//   Q2 事件/通知帧是否携带 sessionId
//   Q3 eventId 全局唯一还是 per-session
//   Q4 非本进程 active 会话的事件是否可读（后台可达性）
//   Q5 session/read 是否为轻量 meta
// 用法: node probe-sync.js [--cwd <工作区>] [--observe <秒>]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const CWD = flag('--cwd', process.cwd());
const OBSERVE_SEC = Number(flag('--observe', '12'));

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) {
    return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  }
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

// ── 帧层 ──────────────────────────────────────────────
const zc = defaultZcodeCommand();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', CWD], {
  cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map();
const pushed = []; // 通知/反向请求原文（裁剪）
let buffer = '';

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true, method }); }, 12000).unref();
  });
}

// 深度找 sessionId 类键
function findSessionIds(v, out = new Set(), depth = 0) {
  if (depth > 8 || v == null) return out;
  if (Array.isArray(v)) { for (const x of v) findSessionIds(x, out, depth + 1); return out; }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (/^session/i.test(k) && typeof x === 'string' && x.length > 10) out.add(`${k}=${x.slice(0, 14)}…`);
      findSessionIds(x, out, depth + 1);
    }
  }
  return out;
}
const brief = (frame) => {
  const o = { method: frame.method || null, id: frame.id ?? null };
  if (frame.result !== undefined) o.resultKeys = Object.keys(frame.result || {}).slice(0, 12);
  if (frame.error) o.error = { code: frame.error.code, msg: String(frame.error.message).slice(0, 160) };
  if (frame.params && frame.method) o.paramKeys = Object.keys(frame.params).slice(0, 12);
  if (frame.method && frame.id != null) o.isReverseRequest = true;
  const sids = [...findSessionIds(frame)];
  if (sids.length) o.sessionIdFields = sids.slice(0, 4);
  return o;
};

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
      pushed.push({ t: Date.now(), brief: brief(f) });
      if (f.method && f.id != null) { // 反向请求：runtime prefs 代答，其余记下并回绝
        if (f.method === 'session/requestRuntimePreferences') {
          send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        } else {
          send({ id: f.id, error: { code: -32601, message: 'probe: not supported' } });
        }
      }
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c.toString().slice(0, 300)}`));

// ── 实测流程 ──────────────────────────────────────────
const size = (r) => { try { return Buffer.byteLength(JSON.stringify(r ?? {})); } catch { return -1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

(async () => {
  try {
    await sleep(600); // 等进程就绪
    // 0) 会话列表
    const list = await request('session/list', {});
    const sessions = (list?.result?.sessions || []).map(s => ({
      id: s.sessionId, title: String(s.title || '').slice(0, 24), status: s.status,
      kind: s.sessionKind, updatedAt: s.updatedAt,
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    report.sessionCount = sessions.length;
    const running = sessions.filter(s => s.status === 'running');
    const A = sessions.find(s => s.status !== 'running');           // 最近空闲
    const B = sessions.filter(s => s.status !== 'running')[3] || sessions[5]; // 更早的一个
    report.picked = { running: running.slice(0, 2).map(s => s.id), A: A?.id, B: B?.id };
    console.log(`sessions=${sessions.length} running=${running.length} A=${A?.id?.slice(0, 14)} B=${B?.id?.slice(0, 14)}`);

    // Q5) session/read 轻量性
    if (A) {
      const read = await request('session/read', { sessionId: A.id });
      report.sessionRead = { ok: !read?.error, bytes: size(read?.result),
        keys: Object.keys(read?.result || {}), error: read?.error?.message?.slice(0, 200) };
      console.log('session/read:', JSON.stringify(report.sessionRead).slice(0, 300));
    }

    // resume A（本进程 active = A）
    if (A) {
      const resume = await request('session/resume', { sessionId: A.id });
      report.resumeA = { bytes: size(resume?.result),
        keys: Object.keys(resume?.result || {}),
        messageCount: resume?.result?.messages?.length,
        messagesTruncated: resume?.result?.messagesTruncated === true,
        error: resume?.error?.message?.slice(0, 120) };
      console.log('resume A bytes=', report.resumeA.bytes, 'msgs=', report.resumeA.messageCount);
    }

    // Q1) session/subscribe 语义
    if (A) {
      const sub = await request('session/subscribe', { sessionId: A.id });
      report.subscribe = { error: sub?.error ? { code: sub.error.code, msg: String(sub.error.message).slice(0, 400) } : null,
        result: sub?.result, resultKeys: Object.keys(sub?.result || {}) };
      console.log('subscribe A:', JSON.stringify(report.subscribe).slice(0, 500));
    }

    // Q2/Q3) events 事件对象结构
    const evAnalysis = {};
    for (const [tag, sid, note] of [
      ['A_active', A?.id, '本进程 active'],
      ['R_external', report.picked.running[0], '桌面正在跑、本进程未 resume'],
      ...(B ? [['B_notResumed', B.id, '从未 resume 的第三会话']] : []),
    ]) {
      if (!sid) continue;
      const ev = await request('session/events', { sessionId: sid, limit: 8 });
      const events = ev?.result?.events || [];
      evAnalysis[tag] = {
        note, ok: !ev?.error, count: events.length,
        error: ev?.error?.message?.slice(0, 150),
        eventIds: events.map(e => e.eventId).slice(0, 6),
        payloadKinds: events.map(e => e.payload?.kind).slice(0, 6),
        topKeys: events[0] ? Object.keys(events[0]) : [],
        carriesSessionId: [...findSessionIds(events)].slice(0, 3),
      };
      console.log(`events ${tag}:`, JSON.stringify(evAnalysis[tag]).slice(0, 320));
    }
    report.events = evAnalysis;

    // Q4) 切走 active（resume B）后再读 A 的事件
    if (B && A) {
      const rb = await request('session/resume', { sessionId: B.id });
      report.resumeB_bytes = size(rb?.result);
      const evA2 = await request('session/events', { sessionId: A.id, limit: 5 });
      report.afterSwitch_readA = { ok: !evA2?.error, count: evA2?.result?.events?.length,
        error: evA2?.error?.message?.slice(0, 150) };
      console.log('after switch, read A events:', JSON.stringify(report.afterSwitch_readA));
    }

    // 观察窗：被动收推送
    console.log(`observing pushed frames for ${OBSERVE_SEC}s...`);
    await sleep(OBSERVE_SEC * 1000);
    report.pushedFrames = pushed.map(p => p.brief);
    report.pushedSummary = {};
    for (const p of pushed) {
      const k = `${p.brief.method || 'response'}`;
      report.pushedSummary[k] = (report.pushedSummary[k] || 0) + 1;
    }
    console.log('pushed summary:', JSON.stringify(report.pushedSummary));
    console.log('pushed sample:', JSON.stringify(report.pushedFrames.slice(0, 8), null, 1));

    fs.writeFileSync(path.join(__dirname, 'probe-sync-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== REPORT SAVED probe-sync-report.json ===');
  } finally {
    child.removeAllListeners('exit');
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 2500);
  }
})();
