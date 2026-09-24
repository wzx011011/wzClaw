// 一次性探针：验证 session/list 的 workspace 分组信息可用性。
// 从 pairing-qr.log 读配对链接（不打印），probe 认证后调 session/list，
// 输出仅含聚合结果（workspace 分布、缺失数）+ 首条目字段形状（字段发现用）。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${__dirname}/pairing-qr.log`, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('RESULT: no-url-in-log'); process.exit(1); }
const u = new URL(m[0]);
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 30s'), 30000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid }));
});
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'error') { fail(`relay-error ${msg.code}`); return; }
  if (msg.type === 'auth_ack' || msg.type === 'pair_status_ack') {
    if (msg.pair_status === 'matched') {
      ws.send(JSON.stringify({ type: 'data', payload: { id: 1, method: 'session/list' } }));
    }
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (p.id !== 1) return;
    const sessions = (p.result && p.result.sessions) || [];
    const byKey = new Map();
    let missing = 0;
    for (const s of sessions) {
      const w = s.workspace || {};
      if (!w.workspaceKey && !w.workspacePath) { missing++; continue; }
      const k = w.workspaceKey || w.workspacePath;
      if (!byKey.has(k)) byKey.set(k, { count: 0, paths: new Set() });
      const e = byKey.get(k);
      e.count++;
      if (w.workspacePath) e.paths.add(w.workspacePath);
    }
    console.log(`total=${sessions.length} missingWorkspace=${missing} groups=${byKey.size}`);
    for (const [k, e] of byKey) {
      const names = [...e.paths].map((p) => p.split(/[\\/]/).filter(Boolean).pop());
      console.log(`  group count=${e.count} name=${names.join('|') || '?'}`);
    }
    console.log('first-entry-keys:', sessions[0]
      ? Object.keys(sessions[0]).join(',') : 'none');
    console.log('first-workspace-shape:', JSON.stringify(sessions[0]
      && sessions[0].workspace));
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
