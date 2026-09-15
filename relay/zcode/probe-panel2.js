// 第二轮：read 嵌套结构 / goal 结构 / subagents(action:show) / messages 的 agent 分布。
// 只打印键名/计数/agent 名等元信息，不打印消息正文。
// 用法: node probe-panel2.js
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
const short = (v, n = 100) => {
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const shape = (v, depth = 0) => {
  if (v === null || typeof v !== 'object') return `${typeof v}`;
  if (Array.isArray(v)) return `array[${v.length}]`;
  const out = {};
  for (const k of Object.keys(v).slice(0, 20)) {
    out[k] = depth >= 2 ? short(v[k], 40) : shape(v[k], depth + 1);
  }
  return out;
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
    console.log(`sid-picked status=${newest.status}`);
    send('session/read', { sessionId: global.__sid });
    return;
  }
  if (p.id === 2) {
    if (p.error) console.log(`read-error: ${p.error.code} ${short(p.error.message)}`);
    else console.log('read-shape:', JSON.stringify(shape(p.result), null, 1).slice(0, 1500));
    send('session/goal', { sessionId: global.__sid });
    return;
  }
  if (p.id === 3) {
    if (p.error) console.log(`goal-error: ${p.error.code} ${short(p.error.message)}`);
    else {
      const r = p.result || {};
      console.log('goal-top-keys:', Object.keys(r).join(','));
      const msgs = r.messages || [];
      console.log(`goal-messages[${msgs.length}]`);
      if (msgs.length) {
        console.log('  info-keys:', Object.keys(msgs[0].info || {}).join(','));
        const agents = [...new Set(msgs.map((x) => x.info?.agent))];
        console.log('  agents:', agents.join(' | '));
        console.log('  parts-types:', JSON.stringify(msgs.flatMap((x) => (x.parts || []).map((pt) => pt.type)).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {})));
      }
    }
    send('session/subagents', { sessionId: global.__sid, action: 'show' });
    return;
  }
  if (p.id === 4) {
    if (p.error) console.log(`subagents-error: ${p.error.code} ${short(p.error.message)}`);
    else console.log('subagents:', short(p.result, 400));
    send('session/messages', { sessionId: global.__sid, limit: 200 });
    return;
  }
  if (p.id === 5) {
    if (p.error) console.log(`messages-error: ${p.error.code}`);
    else {
      const rows = (p.result && p.result.messages) || [];
      const byAgent = new Map();
      for (const row of rows) {
        const a = row.info?.agent ?? '(none)';
        if (!byAgent.has(a)) byAgent.set(a, { n: 0, parts: {} });
        const e = byAgent.get(a);
        e.n++;
        for (const pt of row.parts || []) e.parts[pt.type] = (e.parts[pt.type] || 0) + 1;
      }
      console.log(`messages-rows=${rows.length} byAgent:`);
      for (const [a, e] of byAgent) console.log(`  agent=${a} n=${e.n} parts=${JSON.stringify(e.parts)}`);
      const first = rows.find((r) => r.info?.agent && r.info.agent !== 'zcode-agent' && r.info.agent !== '(none)');
      if (first) console.log('subagent-row-info:', short(first.info, 300));
    }
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
