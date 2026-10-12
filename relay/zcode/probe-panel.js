// 悬浮窗数据源探针：session/read（todos/todoGroups）+ session/goal +
// session/subagents 的真实形状。只打印键名/计数/短字段，不打印消息正文。
// 用法: node probe-panel.js
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${__dirname}/pairing-qr.log`, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('no-url'); process.exit(1); }
const u = new URL(m[m.length - 1]);
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 45s'), 45000);
let id = 0;
const send = (method, params) =>
  ws.send(JSON.stringify({ type: 'data', payload: { id: ++id, method, params } }));
const short = (v) => {
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
};

ws.on('open', () =>
  ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'error') { fail(`relay-error ${msg.code}`); return; }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') &&
      msg.pair_status === 'matched') {
    send('session/list', {});
    return;
  }
  if (msg.type !== 'data') return;
  const p = msg.payload || {};
  if (p.id === 1) {
    const sessions = (p.result && p.result.sessions) || [];
    if (!sessions.length) fail('no-sessions');
    const newest = sessions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    console.log(`target-session: ws=${newest.workspace?.workspaceKey} status=${newest.status} updated=${new Date(newest.updatedAt).toISOString().slice(0, 16)}`);
    global.__sid = newest.sessionId;
    send('session/read', { sessionId: newest.sessionId });
    return;
  }
  if (p.id === 2) {
    if (p.error) { console.log(`session/read error: ${p.error.code} ${p.error.message}`); }
    else {
      const r = p.result || {};
      console.log('read-keys:', Object.keys(r).join(','));
      for (const k of ['todos', 'todoGroups']) {
        const v = r[k];
        if (v === undefined) { console.log(`${k}: absent`); continue; }
        if (Array.isArray(v)) {
          console.log(`${k}: array[${v.length}]`);
          v.slice(0, 3).forEach((it, i) =>
            console.log(`  [${i}] keys=${Object.keys(it || {}).join(',')} sample=${short({ s: it.status, t: it.text ?? it.title ?? it.content })}`));
        } else console.log(`${k}: ${short(v)}`);
      }
    }
    send('session/goal', { sessionId: global.__sid });
    return;
  }
  if (p.id === 3) {
    if (p.error) { console.log(`session/goal error: ${p.error.code} ${p.error.message}`); }
    else console.log('goal:', short(p.result));
    send('session/subagents', { sessionId: global.__sid });
    return;
  }
  if (p.id === 4) {
    if (p.error) { console.log(`session/subagents error: ${p.error.code} ${p.error.message}`); }
    else {
      const r = p.result;
      const arr = Array.isArray(r) ? r : (r && (r.subagents || r.agents)) || [];
      console.log(`subagents: ${Array.isArray(arr) ? `array[${arr.length}]` : typeof r}`);
      if (Array.isArray(arr) && arr.length) {
        console.log('  first-keys:', Object.keys(arr[0]).join(','));
        console.log('  first:', short({ ...arr[0] }));
      } else if (!Array.isArray(arr)) console.log('  raw:', short(r));
    }
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
