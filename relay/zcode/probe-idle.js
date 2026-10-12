// 空闲存活探针：以 probe 角色认证进房后完全静默，测量连接被谁何时掐断。
// 输出仅含 连接序号/存活毫秒/关闭码/是否clean，不含 sid/hash。
// 用法: node probe-idle.js <pairingUrlFile> [durationSec=300]
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const urlFile = process.argv[2];
const durationMs = (Number(process.argv[3]) || 300) * 1000;
const log = fs.readFileSync(urlFile, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('SETUP: no-url'); process.exit(1); }
const u = new URL(m[m.length - 1]); // 文件里可能有多个码，取最后一个
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');
const relayWs = u.origin.replace(/^http/, 'ws') + '/ws';

const startedAt = Date.now();
let connIndex = 0;
let closedByUs = false;

function connectOnce() {
  connIndex += 1;
  const idx = connIndex;
  const openedAt = Date.now();
  const ws = new WebSocket(relayWs, { handshakeTimeout: 15000 });
  let authed = false;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'auth_challenge') {
      const proof = crypto.createHmac('sha256', hash)
        .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
      ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    } else if (msg.type === 'auth_ack' || msg.type === 'pair_status_ack') {
      if (!authed) { authed = true; console.log(`CONN#${idx} authed pair=${msg.pair_status}`); }
    } else if (msg.type === 'error') {
      console.log(`CONN#${idx} relay-error code=${msg.code || 'unknown'}`);
    } else if (msg.type === 'data') {
      const p = msg.payload;
      if (p && typeof p === 'object' && p.method && p.id != null) {
        // 反向请求默认拒绝（不影响存活测量）
        ws.send(JSON.stringify({ type: 'data', payload: {
          id: p.id, error: { code: -32000, message: 'idle probe' } } }));
      }
    }
  });
  ws.on('close', (code) => {
    const life = Date.now() - openedAt;
    console.log(`CONN#${idx} closed life=${life}ms code=${code} clean=${code === 1000}`);
    if (!closedByUs && Date.now() - startedAt < durationMs) {
      setTimeout(connectOnce, 5000);
    } else {
      console.log('IDLE-TEST-DONE');
      process.exit(0);
    }
  });
  ws.on('error', (e) => console.log(`CONN#${idx} error ${e.message}`));
}

connectOnce();
setTimeout(() => { closedByUs = true; console.log('IDLE-TEST-DONE'); process.exit(0); }, durationMs).unref();
