'use strict';

// probe-live2 — 双订阅跨进程观察：对桌面正在驱动的会话同时订
// web-remote-replayable 与 desktop-continuous，观察窗内记录：
//   - 被动推送的每个 session/event（type + 是否带正文）
//   - 每 2s 拉一次 session/events 的增量
// 全部 appendFileSync 同步写 probe-live2.log（防 stdout 缓冲丢失）。
// 用法: node probe-live2.js [--sid <id>] [--observe 45]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const SID = flag('--sid', 'sess_a2a59f50-dc25-43fe-9b79-d4b59b9b8d45');
const OBSERVE = Number(flag('--observe', '45'));

const LOG = path.join(__dirname, 'probe-live2.log');
const out = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${m}\n`); } catch {} };
fs.writeFileSync(LOG, '');
out(`start sid=${SID.slice(5, 13)} observe=${OBSERVE}s`);

const local = path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', 'E:/ai/wzxClaw'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (c) => out('[stderr] ' + c.toString().slice(0, 150)));
child.on('exit', (c) => { out('child exit ' + c); });

let nextId = 1; const pending = new Map(); let buf = '';
function send(f) { child.stdin.write(JSON.stringify(f) + '\n'); }
function request(m, p, ms = 10000) {
  const id = nextId++;
  return new Promise((r) => { pending.set(id, r); send({ id, method: m, params: p });
    setTimeout(() => { if (pending.delete(id)) r({ __timeout: true }); }, ms).unref(); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child.stdout.on('data', (c) => {
  buf += c.toString(); let j;
  while ((j = buf.indexOf('\n')) !== -1) {
    const l = buf.slice(0, j).trim(); buf = buf.slice(j + 1); if (!l) continue;
    let f; try { f = JSON.parse(l); } catch { continue; }
    if (f.method && f.id != null) {
      send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
    } else if (f.id != null && (f.result !== undefined || f.error !== undefined) && pending.has(f.id)) {
      pending.get(f.id)(f); pending.delete(f.id);
    } else if (f.method === 'session/event' && f.params?.sessionId === SID) {
      const p = f.params;
      const hasText = p.payload?.kind === 'text_delta' || p.type === 'model.streaming';
      out(`PUSH seq=${p.seq} type=${p.type || p.payload?.kind} text=${hasText ? JSON.stringify(p.payload).slice(0, 120) : '-'}`);
    } else if (f.method === 'v4/telemetry/event' && f.params?.sessionId === SID) {
      out(`TELE kind=${f.params.kind} eventSeq=${f.params.eventSeq}`);
    }
  }
});

(async () => {
  try {
    await sleep(700);
    const rs = await request('session/resume', { sessionId: SID });
    out(`resume ok=${!rs.error} ${rs.error?.message?.slice(0, 100) ?? ''}`);
    const s1 = await request('session/subscribe', { sessionId: SID, deliveryKind: 'web-remote-replayable' });
    out(`sub(replayable) cursor=${s1.result?.eventSeq ?? JSON.stringify(s1.error).slice(0, 120)}`);
    const s2 = await request('session/subscribe', { sessionId: SID, deliveryKind: 'desktop-continuous' });
    out(`sub(continuous) ${JSON.stringify(s2.result ?? s2.error).slice(0, 160)}`);
    let lastSeq = s1.result?.eventSeq ?? 0;
    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE * 1000) {
      await sleep(2000);
      const ev = await request('session/events', { sessionId: SID, limit: 100 });
      const events = ev.result?.events || [];
      const fresh = events.filter(e => (e.seq ?? 0) > lastSeq);
      if (fresh.length) {
        lastSeq = Math.max(...fresh.map(e => e.seq ?? 0));
        out(`PULL +${fresh.length} seq→${lastSeq} kinds=${fresh.map(e => e.payload?.kind || e.type).join(',').slice(0, 150)}`);
        for (const e of fresh) {
          if (e.payload?.kind === 'text_delta' || e.type === 'model.streaming') {
            out(`  PULL-TEXT seq=${e.seq} ${JSON.stringify(e.payload).slice(0, 140)}`);
          }
        }
      }
    }
    out('window end');
  } catch (e) {
    out('FAIL ' + (e.message || e));
  } finally {
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 1500);
  }
})();
