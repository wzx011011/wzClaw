// probe-fork2 — 补探 session/fork 成功路径 + 清理 probe-fork 双触发泄漏的 scratch 会话
//   1. 清理：close 所有 workspacePath 含 probe-fork- 的会话，删临时目录
//   2. 成功路径：挑一个 idle 且有消息的历史会话 fork，记录返回形状，fork 副本立即 close
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const raw = fs.readFileSync(path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'pair-url.txt'), 'utf8').trim();
const m = raw.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
const u = new URL(m[0]);
const sid = u.searchParams.get('sid');
const hash = decodeURIComponent(u.searchParams.get('hash'));
const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
let nextId = 1; const pending = new Map();
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++; pending.set(id, resolve);
  ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, 20000);
});
let ran = false; // auth_ack 与 pair_status_ack 可能都到，只跑一次
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', async (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (pending.has(p.id)) { pending.get(p.id)(p); pending.delete(p.id); }
    return;
  }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash).update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof })); return;
  }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    if (ran) return; ran = true;
    const out = (label, v) => console.log(label, '=>', JSON.stringify(v).slice(0, 1000));

    // 1) 清理泄漏的 scratch 会话
    const list = await rpc('session/list', {});
    const sessions = (list.result && list.result.sessions) || [];
    console.log('total sessions:', sessions.length);
    for (const s of sessions) {
      const wp = s.workspace && s.workspace.workspacePath || '';
      if (wp.includes('probe-fork-')) {
        out('cleanup close ' + s.sessionId, (await rpc('session/close', { sessionId: s.sessionId })).error ?? 'ok');
      }
    }
    try {
      for (const d of fs.readdirSync(os.tmpdir())) {
        if (d.startsWith('probe-fork-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
      }
    } catch {}
    console.log('cleanup done');

    // 2) 成功路径：挑 idle、非 probe 的历史会话 fork
    const target = sessions.find(s => s.status === 'idle' && !(s.workspace && s.workspace.workspacePath || '').includes('probe-fork-') && s.sessionKind !== 'background');
    if (!target) { console.log('NO-TARGET'); ws.close(); process.exit(0); }
    console.log('fork source:', target.sessionId, 'status=', target.status, 'title=', (target.title || '').slice(0, 40));

    const fk = await rpc('session/fork', { sessionId: target.sessionId });
    out('session/fork{sessionId} SUCCESS-SHAPE', fk.error ?? fk.result);
    const fkBody = fk.result || {};
    const forkId = fkBody.sessionId || (fkBody.session && fkBody.session.sessionId);

    if (forkId) {
      const st = await rpc('session/status', { sessionId: forkId });
      out('fork session/status', st.error ?? st.result);
      const fr = await rpc('session/read', { sessionId: forkId });
      const body = fr.result || fr.error || {};
      console.log('fork session/read keys=', Object.keys(body).join(','), 'msgs=', Array.isArray(body.messages) ? body.messages.length : '(n/a)');
      const src = await rpc('session/read', { sessionId: target.sessionId });
      const sbody = src.result || src.error || {};
      console.log('src  session/read msgs=', Array.isArray(sbody.messages) ? sbody.messages.length : '(n/a)');
      out('fork close', (await rpc('session/close', { sessionId: forkId })).error ?? 'ok');
    }
    console.log('DONE');
    ws.close(); process.exit(0);
  }
});
