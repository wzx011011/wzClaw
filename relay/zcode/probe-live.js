'use strict';

// probe-live — 跨进程实时性实测：从第二个 app-server 进程观察一个
// 正在被桌面进程驱动的会话（即正在跑的那个会话）。
//   Q1 另一进程 session/list 里它的 status 是否如实 running？
//   Q2 resume 物化后，session/events 拉取能否实时看到新 text_delta？
//   Q3 session/subscribe(web-remote-replayable) 推送能否跨进程到达？
// 只读观察，不 send。用法: node probe-live.js [--cwd E:/ai/wzxClaw] [--observe 60]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', 'E:/ai/wzxClaw');
const OBSERVE = Number(flag('--observe', '60'));
const FIXED_SID = flag('--session', null);

console.log('[probe-live] start', { CWD, OBSERVE, FIXED_SID });

const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', CWD], { stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1; const pending = new Map(); const pushed = []; let buf = '';
function send(f) { child.stdin.write(JSON.stringify(f) + '\n'); }
function request(m, p) {
  const id = nextId++;
  return new Promise((r) => { pending.set(id, r); send({ id, method: m, params: p });
    setTimeout(() => { if (pending.delete(id)) r({ __timeout: true }); }, 12000).unref(); });
}
child.stdout.on('data', (c) => {
  buf += c.toString(); let j;
  while ((j = buf.indexOf('\n')) !== -1) {
    const l = buf.slice(0, j).trim(); buf = buf.slice(j + 1); if (!l) continue;
    let f; try { f = JSON.parse(l); } catch { continue; }
    if (f.method && f.id != null) {
      send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } }); // 反向请求代答
    } else if (f.id != null && !f.method && (f.result !== undefined || f.error !== undefined)) {
      const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); }
    } else if (f.method) {
      pushed.push({ t: Date.now(), f });
    }
  }
});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const report = { picked: null, listStatus: null, subCursor: null,
    pulls: [], pushedSessionEvents: 0, pushedWithText: null };
  try {
    await sleep(700);
    // 1) 找目标会话：--session 直接指定；否则按 updatedAt 倒序，排除探针测试会话
    let target = null;
    if (FIXED_SID) {
      const c0 = { id: FIXED_SID, title: '(fixed)', status: '?' };
      const rs0 = await request('session/resume', { sessionId: FIXED_SID });
      console.log('[probe-live] resume(fixed) ok=', !rs0.error, rs0.error?.message?.slice(0, 120),
        'bytes=', JSON.stringify(rs0.result ?? {}).length);
      if (!rs0.error) { target = c0; report.listStatus = 'fixed'; }
    }
    if (!target) {
      const list = await request('session/list', {});
      const ss = (list.result?.sessions || [])
        .map(s => ({ id: s.sessionId, title: String(s.title || ''), status: s.status, updatedAt: s.updatedAt }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const cands = ss.filter(s => !/协议探测/.test(s.title)).slice(0, 4);
      console.log('候选:', cands.map(c => `${c.id.slice(5, 13)} status=${c.status} ${c.title.slice(0, 18)}`).join(' | '));
      for (const c of cands) {
        const rs = await request('session/resume', { sessionId: c.id });
        if (rs.error) continue;
        report.listStatus = c.status; // 记录列表视角的 status
        target = c;
        // resume 顺带回全量消息——看尾部消息是否含本会话特有关键词
        const tailText = JSON.stringify((rs.result?.messages || []).slice(-4)).slice(0, 4000);
        if (/PLAN-zcode-remote|probe-sync/.test(tailText)) { report.matchedBy = 'keyword'; break; }
      }
    }
    if (!target) throw new Error('no candidate resumed');
    report.picked = { id: target.id, title: target.title, listStatus: target.status };
    console.log('目标:', target.id, 'listStatus=', target.status, 'title=', target.title.slice(0, 24));

    // 2) 订阅（Q3）
    const sub = await request('session/subscribe', { sessionId: target.id, deliveryKind: 'web-remote-replayable' });
    report.subCursor = sub.result?.eventSeq ?? sub.error?.message?.slice(0, 120);
    console.log('subscribe cursor:', report.subCursor);

    // 3) 观察窗：每 2s 拉一次增量（Q2），同时被动收推送（Q3）
    let lastSeq = typeof sub.result?.eventSeq === 'number' ? sub.result.eventSeq : 0;
    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE * 1000) {
      await sleep(2000);
      const ev = await request('session/events', { sessionId: target.id, limit: 100 });
      const events = ev.result?.events || [];
      const fresh = events.filter(e => (e.seq ?? 0) > lastSeq);
      if (fresh.length) lastSeq = Math.max(...fresh.map(e => e.seq ?? 0));
      const texts = fresh.filter(e => e.payload?.kind === 'text_delta' || e.type === 'model.streaming');
      report.pulls.push({ t: Math.round((Date.now() - t0) / 1000), fresh: fresh.length, textDeltas: texts.length,
        kinds: fresh.map(e => e.payload?.kind || e.type).slice(0, 6) });
      if (texts.length && !report.pulledWithText) {
        report.pulledWithText = { t: Math.round((Date.now() - t0) / 1000),
          sample: JSON.stringify(texts[0].payload).slice(0, 200) };
      }
      const subPushed = pushed.filter(p => p.f.method === 'session/event' && p.f.params?.sessionId === target.id);
      report.pushedSessionEvents = subPushed.length;
      const pushedText = subPushed.filter(p => p.f.params?.payload?.kind === 'text_delta' || p.f.params?.type === 'model.streaming');
      if (pushedText.length && !report.pushedWithText) {
        report.pushedWithText = { t: Math.round((Date.now() - t0) / 1000),
          sample: JSON.stringify(pushedText[0].f.params.payload).slice(0, 200) };
      }
    }
    console.log('pull 时间线:', JSON.stringify(report.pulls));
    console.log('拉到正文?', JSON.stringify(report.pulledWithText));
    console.log('推送到正文?', JSON.stringify(report.pushedWithText), '推送 session/event 总数:', report.pushedSessionEvents);
    fs.writeFileSync(path.join(__dirname, 'probe-live-report.json'), JSON.stringify(report, null, 2));
    console.log('=== probe-live-report.json saved ===');
  } catch (e) {
    console.error('FAIL', e.message || e);
    fs.writeFileSync(path.join(__dirname, 'probe-live-report.json'), JSON.stringify(report, null, 2));
  } finally {
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 2000);
  }
})();
