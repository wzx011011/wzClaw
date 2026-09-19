// 第五轮：resume 消息的 agent 分布（混合问题的数据源定位）。
// 用法: node probe-panel5.js
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
setTimeout(() => fail('timeout'), 60000);
let id = 0;
const send = (method, params) =>
  ws.send(JSON.stringify({ type: 'data', payload: { id: ++id, method, params } }));
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
    send('session/resume', { sessionId: global.__cands[0].sessionId });
    return;
  }
  if (p.id >= 2) {
    if (p.error) {
      global.__i++;
      if (global.__i < global.__cands.length) {
        send('session/resume', { sessionId: global.__cands[global.__i].sessionId });
      } else fail('no materialized session');
      return;
    }
    const rows = (p.result && p.result.messages) || [];
    const byAgent = new Map();
    for (const row of rows) {
      const a = row.info?.agent ?? '(none)';
      if (!byAgent.has(a)) byAgent.set(a, { n: 0, parts: {} });
      const e = byAgent.get(a);
      e.n++;
      for (const pt of row.parts || []) {
        e.parts[pt.type] = (e.parts[pt.type] || 0) + 1;
      }
    }
    console.log(`resume rows=${rows.length}`);
    for (const [a, e] of byAgent) {
      console.log(`  agent=${a} n=${e.n} parts=${JSON.stringify(e.parts)}`);
    }
    const sub = rows.find((r) => r.info?.agent && r.info.agent !== 'zcode-agent');
    if (sub) {
      console.log('sub-row info-keys:', Object.keys(sub.info).join(','));
      console.log('sub-row parentID:', sub.info.parentID ?? '(none)');
      console.log('sub-row semantics:', JSON.stringify(sub.info.semantics));
    } else {
      console.log('no-subagent-rows-in-resume');
    }
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
