// 一次性 E2E 配对验证脚本：从 pairing-qr.log 读取配对链接（不打印），
// 以 probe 角色走完 认证 → matched → session/list 全链路。
// 输出只含阶段状态与数量，不含 sid/hash/会话内容。
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
if (!sid || !hash) { console.log('RESULT: bad-url-params'); process.exit(1); }

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
let stage = 'connecting';
const fail = (why) => { console.log(`RESULT: fail at ${stage}: ${why}`); process.exit(1); };
const timer = setTimeout(() => fail('timeout 30s'), 30000);

ws.on('open', () => {
  stage = 'auth_init';
  ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid }));
});
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    stage = 'auth_response';
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'auth_ack' || msg.type === 'pair_status_ack') {
    stage = `ack:${msg.pair_status}`;
    if (msg.pair_status === 'matched') {
      console.log('RESULT: matched ok');
      stage = 'session_list';
      ws.send(JSON.stringify({ type: 'data', payload: { id: 1, method: 'session/list' } }));
    } else {
      console.log('RESULT: authed but waiting (device not in room)');
      clearTimeout(timer); ws.close(); process.exit(0);
    }
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload;
    if (!p || typeof p !== 'object') return;
    // companion 反向请求：代答 runtime preferences
    if (p.method === 'session/requestRuntimePreferences') {
      ws.send(JSON.stringify({ type: 'data', payload: {
        id: p.id, result: { nativeSearchEnhancementsEnabled: false } } }));
      return;
    }
    if (p.id === 1) {
      if (p.error) { fail(`session/list error ${p.error.code}`); return; }
      const r = p.result;
      const n = Array.isArray(r) ? r.length
        : Array.isArray(r && r.sessions) ? r.sessions.length
        : Array.isArray(r && r.messages) ? r.messages.length
        : (r && typeof r === 'object') ? Object.keys(r).length : -1;
      console.log(`RESULT: session/list ok, entries=${n}`);
      clearTimeout(timer); ws.close(); process.exit(0);
    }
    return;
  }
  if (msg.type === 'error') fail(`relay error ${msg.code || msg.message || 'unknown'}`);
});
ws.on('error', (e) => fail(`ws error: ${e.message}`));
ws.on('close', (code) => { if (stage !== 'done') console.log(`(closed at ${stage}, code ${code})`); });
