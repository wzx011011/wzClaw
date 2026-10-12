// 一次性探针：钉死「可用模型列表」还能从哪些响应拿到。
// 背景：setModel 兜底依赖 state.updated 的 patch.model.available，但刚打开
// 旧会话第一次 send 就撞 -32031 时该列表可能还是空的。候选来源：
// session/resume 响应、session/read 响应、session/subscribe 快照。
// 从 pairing-qr.log 读配对链接（不打印），只输出结构形状，不含凭据。
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

// 递归找 model.available 形状（available: [{ref:{providerId,modelId}}]）
const found = [];
function scan(node, path, depth) {
  if (depth > 6 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.slice(0, 5).forEach((v) => scan(v, path, depth + 1)); return; }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'available' && Array.isArray(v) && v.length > 0 &&
        v[0] && typeof v[0] === 'object' && 'ref' in v[0]) {
      const sample = v[0].ref || {};
      found.push(`${path}.available[n=${v.length}] ref0=${JSON.stringify(sample)}`);
    }
    scan(v, path ? `${path}.${k}` : k, depth + 1);
  }
}

let phase = 'auth';
function send(id, method, params) {
  ws.send(JSON.stringify({ type: 'data', payload: { id, method, params } }));
}

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
    if (msg.pair_status === 'matched' && phase === 'auth') {
      phase = 'list';
      send(1, 'session/list', {});
    }
    return;
  }
  if (msg.type !== 'data') return;
  const p = msg.payload || {};

  if (p.id === 1) {
    const sessions = (p.result && p.result.sessions) || [];
    if (!sessions.length) { console.log('RESULT: no-sessions'); process.exit(0); }
    // 选 updatedAt 最新的一条（最可能在桌面活跃过）
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const sid1 = sessions[0].sessionId;
    console.log(`picked updatedAt=${sessions[0].updatedAt} title=${JSON.stringify(sessions[0].title)}`);
    phase = 'resume';
    send(2, 'session/resume', { sessionId: sid1 });
    return;
  }
  if (p.id === 2) {
    const r = p.result || {};
    console.log('resume-top-keys:', Object.keys(r).join(','));
    found.length = 0;
    scan(r, 'resume', 0);
    console.log('resume-model-available:', found.length ? found.join(' | ') : 'NONE');
    phase = 'read';
    send(3, 'session/read', { sessionId: r.session && r.session.sessionId });
    return;
  }
  if (p.id === 3) {
    const r = p.result || {};
    console.log('read-top-keys:', Object.keys(r).join(','));
    found.length = 0;
    scan(r, 'read', 0);
    console.log('read-model-available:', found.length ? found.join(' | ') : 'NONE');
    // read 的 projection/settings 浅形状（截断）
    try {
      const proj = r.projection ? JSON.stringify(r.projection).slice(0, 600) : 'null';
      console.log('read-projection-shape:', proj);
    } catch (e) { console.log('read-projection-shape: err'); }
    phase = 'subscribe';
    const sid1 = (p.result && p.result.session && p.result.session.sessionId);
    send(4, 'session/subscribe', { sessionId: sid1, deliveryKind: 'web-remote-replayable' });
    return;
  }
  if (p.id === 4) {
    const r = p.result || {};
    const events = r.events || [];
    const types = events.map((e) => e.type || (e.payload && e.payload.kind) || '?');
    console.log(`subscribe-events n=${events.length} types=${[...new Set(types)].join(',')}`);
    found.length = 0;
    scan(r, 'subscribe', 0);
    console.log('subscribe-model-available:', found.length ? found.join(' | ') : 'NONE');
    console.log('RESULT: done');
    process.exit(0);
  }
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));
