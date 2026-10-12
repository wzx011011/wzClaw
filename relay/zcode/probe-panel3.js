// 第三轮消歧：messages 文档参数 / subagents 纯 action / 完整错误文本。
// 用法: node probe-panel3.js
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
setTimeout(() => fail('timeout 60s'), 60000);
let id = 0;
const send = (method, params) =>
  ws.send(JSON.stringify({ type: 'data', payload: { id: ++id, method, params } }));
const short = (v, n = 200) => {
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
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
    const newest = sessions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    global.__sid = newest.sessionId;
    send('session/messages', { sessionId: global.__sid, limit: 2 });
    return;
  }
  if (p.id === 2) {
    if (p.error) console.log(`messages(limit2)-error: ${short(p.error)}`);
    else {
      const rows = (p.result && p.result.messages) || [];
      console.log(`messages(limit2) ok rows=${rows.length} hasMore=${p.result?.hasMore}`);
    }
    send('session/subagents', { action: 'show' });
    return;
  }
  if (p.id === 3) {
    if (p.error) console.log(`subagents({action})-error: ${short(p.error)}`);
    else console.log('subagents({action}):', short(p.result));
    send('session/subagents', {});
    return;
  }
  if (p.id === 4) {
    if (p.error) console.log(`subagents({})-error: ${short(p.error)}`);
    else console.log('subagents({}):', short(p.result));
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
