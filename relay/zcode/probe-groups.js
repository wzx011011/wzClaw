// 分组详情探针：session/list 按 workspace 输出 key+path+最新更新时间。
// 输出仅含路径与计数，不含会话内容/凭据。
// 用法: node probe-groups.js
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
setTimeout(() => fail('timeout'), 30000);
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
    ws.send(JSON.stringify({ type: 'data', payload: { id: 1, method: 'session/list' } }));
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (p.id !== 1) return;
    const sessions = (p.result && p.result.sessions) || [];
    const groups = new Map();
    for (const s of sessions) {
      const w = s.workspace || {};
      const k = w.workspaceKey || '(no-key)';
      if (!groups.has(k)) {
        groups.set(k, { path: w.workspacePath || '', count: 0, newest: 0, sample: (s.title || '').slice(0, 16) });
      }
      const g = groups.get(k);
      g.count++;
      if (s.updatedAt > g.newest) g.newest = s.updatedAt;
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].newest - a[1].newest);
    for (const [k, g] of rows) {
      console.log(`${new Date(g.newest).toISOString().slice(0, 16)} n=${String(g.count).padStart(2)} key=${JSON.stringify(k)} path=${JSON.stringify(g.path)} sample=${JSON.stringify(g.sample)}`);
    }
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
