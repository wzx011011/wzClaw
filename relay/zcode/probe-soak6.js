// 一次性探针：复现手机端「一直在断线重连」——用与 ZcodeRelayClient 完全
// 一致的协议（probe 角色 + 15s pair_status_query 心跳）挂在公网 relay 上
// 长跑，记录每个入站帧与关闭事件的时间戳。跑 6 分钟自动退出。
// 用法: node probe-soak.js <pairUrl>
'use strict';
require('node:dns').setDefaultResultOrder('ipv6first');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const url = new URL(process.argv[2] || '');
const sid = url.searchParams.get('sid');
const hash = url.searchParams.get('hash');
if (!sid || !hash) { console.log('need pair url'); process.exit(1); }
const wsUrl = `wss://${url.host}/ws`;

const t0 = Date.now();
const ts = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;
console.log(`${ts()} connect ${wsUrl}`);

const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
let hb = null;
let lastInbound = Date.now();

ws.on('open', () => {
  console.log(`${ts()} open → auth_init`);
  ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid }));
});
ws.on('message', (raw) => {
  lastInbound = Date.now();
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${m.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    console.log(`${ts()} ← challenge → proof`);
    return;
  }
  if (m.type === 'auth_ack') {
    console.log(`${ts()} ← auth_ack pair_status=${m.pair_status}（开始 15s 心跳）`);
    hb = setInterval(() => {
      ws.send(JSON.stringify({ type: 'pair_status_query', device_sid: sid }));
    }, 15000);
    return;
  }
  console.log(`${ts()} ← ${m.type}${m.pair_status ? ` ${m.pair_status}` : ''}`);
});
ws.on('close', (code, reason) => {
  clearInterval(hb);
  console.log(`${ts()} CLOSE code=${code} reason=${reason.toString() || '-'} idle=${Math.round((Date.now() - lastInbound) / 1000)}s`);
  process.exit(0);
});
ws.on('error', (e) => console.log(`${ts()} ERROR ${e.message}`));
ws.on('unexpected-response', (_req, res) => console.log(`${ts()} HTTP ${res.statusCode}`));

setTimeout(() => { console.log(`${ts()} soak done（6 分钟无断开）`); ws.close(1000); process.exit(0); }, 360000);
