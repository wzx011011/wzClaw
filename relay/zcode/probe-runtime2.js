// 一次性补探：subscribe/目录候选/setThoughtLevel 的完整错误详情
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const raw = fs.readFileSync(path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'pair-url.txt'), 'utf8').trim();
const m = raw.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
const u = new URL(m[0]);
const sid = u.searchParams.get('sid');
const hash = decodeURIComponent(u.searchParams.get('hash'));
const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
let nextId = 1; const pending = new Map();
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++; pending.set(id, resolve);
  ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, 15000);
});
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', async (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (pending.has(p.id)) { pending.get(p.id)(p); pending.delete(p.id); }
    return;
  }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash).update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof })); return;
  }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    const list = await rpc('session/list', {});
    const sessions = (list.result && list.result.sessions) || [];
    if (!sessions.length) { console.log('no sessions'); process.exit(1); }
    const sessionId = sessions[0].sessionId;
    for (const method of ['session/status', 'session/info', 'session/get']) {
      const r = await rpc(method, { sessionId });
      console.log(method, '=>', JSON.stringify(r.error ?? r.result).slice(0, 600));
    }
    for (const method of ['session/models', 'model/list', 'provider/list']) {
      const r = await rpc(method, { sessionId });
      console.log(method, '=>', JSON.stringify(r.error ?? r.result).slice(0, 300));
    }
    const st1 = await rpc('session/setThoughtLevel', { sessionId, level: 'high' });
    console.log('setThoughtLevel{level:high} =>', JSON.stringify(st1.error ?? st1.result).slice(0, 400));
    const st2 = await rpc('session/setThoughtLevel', { sessionId, thoughtLevel: 'high' });
    console.log('setThoughtLevel{thoughtLevel:high} =>', JSON.stringify(st2.error ?? st2.result).slice(0, 400));
    console.log('DONE');
    ws.close(); process.exit(0);
  }
});
