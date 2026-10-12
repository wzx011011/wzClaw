// 第四轮：todos/todoGroups/goalStats 精确字段（内容截断）。
// 用法: node probe-panel4.js
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
const fail = (w) => { console.log(`fail: ${w}`); process.exit(1); };
setTimeout(() => fail('timeout'), 45000);
let id = 0;
const send = (method, params) =>
  ws.send(JSON.stringify({ type: 'data', payload: { id: ++id, method, params } }));
const short = (v, n = 150) => {
  const s = JSON.stringify(v) ?? 'undefined';
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
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    global.__cands = sorted.slice(0, 3);
    global.__i = 0;
    send('session/goal', { sessionId: global.__cands[0].sessionId });
    return;
  }
  if (p.id >= 2) {
    if (p.error) {
      console.log(`goal-error on candidate ${global.__i}: code=${p.error.code}`);
      global.__i++;
      if (global.__i < global.__cands.length) {
        send('session/goal', { sessionId: global.__cands[global.__i].sessionId });
      } else fail('no materialized session');
      return;
    }
    const r = p.result || {};
    console.log('todos:', short(r.todos, 800));
    console.log('todoGroups:', short(r.todoGroups, 800));
    console.log('goalStats:', short(r.goalStats, 300));
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
