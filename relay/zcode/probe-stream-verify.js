'use strict';
// 流式验证探针：向复盘会话（浏览器端已打开并订阅）发一条消息，
// 引擎跑一个短回合，web 客户端应实时收到流式增量。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const pairUrl = fs.readFileSync(
  `${process.env.HOME || process.env.USERPROFILE}/.wzxclaw/zcode-companion/pair-url.txt`,
  'utf8',
);
const m = pairUrl.match(/https?:\/\/\S*\/pair\?sid=([^&\s]+)&hash=([^&\s]+)/);
if (!m) throw new Error('pair-url.txt 格式不匹配（姊妹探针 probe-incremental-gap.js 同款守卫）');
const sid = decodeURIComponent(m[1]);
const hash = decodeURIComponent(m[2]);
const u = new URL(pairUrl.trim());
const ws = new WebSocket(u.origin.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 15000 });

let nextId = 1;
const pending = new Map();
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, 15000);
  });
}
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (p.id != null && pending.has(p.id)) {
      pending.get(p.id).resolve(p);
      pending.delete(p.id);
    }
  }
});

const SID = 'sess_da582a41-3ce3-4795-98e4-8ae036d70a83';

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1200));
  await rpc('session/resume', { sessionId: SID });
  const sent = await rpc('session/send', {
    sessionId: SID,
    content: '流式验证：请写一段约 300 字的短文，介绍秋天的景色，不要使用任何工具。',
  });
  console.log('send ->', JSON.stringify(sent).slice(0, 200));
  await new Promise((r) => setTimeout(r, 30000));
  console.log('done');
  process.exit(0);
}
main().catch((e) => { console.log('fail', e.message); process.exit(1); });
