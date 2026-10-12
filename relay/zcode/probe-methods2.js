// 二阶探针：枚举值/嵌套对象精确形状 + fork 实测（最旧会话）。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const LIVE = 'sess_7c449132-d5d7-44ab-a7d8-350329632757';
const log = fs.readFileSync(`${__dirname}/pairing-qr.log`, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
const u = new URL(m[m.length - 1]);
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');
const ws = new WebSocket(u.origin.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 60s'), 60000);

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
  if (msg.type === 'error') { fail(`relay ${msg.code}`); return; }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (p.id != null && pending.has(p.id)) { pending.get(p.id).resolve(p); pending.delete(p.id); }
  }
});
const short = (v) => { const s = JSON.stringify(v); return s.length > 600 ? `${s.slice(0, 600)}…` : s; };
const zodEnums = (err) => {
  try {
    const issues = JSON.parse(err.data.message);
    return issues.map((i) => i.code === 'invalid_value'
      ? `${i.path.join('.')}: [${i.values.join('|')}]`
      : `${i.path.join('.')}: ${i.code} expected=${i.expected || ''}`).join('; ');
  } catch { return short(err.data || err.message); }
};

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1500));
  const list = await rpc('session/list');
  const sessions = ((list.result || {}).sessions || [])
    .filter((s) => s.sessionId !== LIVE)
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  if (!sessions.length) { fail('no sessions'); return; }
  const target = sessions[0].sessionId; // 最旧会话
  const sidArg = { sessionId: target };
  console.log(`target(oldest) ${target}`);

  await rpc('session/resume', sidArg);

  // setThoughtLevel：level 字段名与枚举
  let r = await rpc('session/setThoughtLevel', { ...sidArg, level: '__x__' });
  console.log(`setThoughtLevel bad-level -> ${r.error ? zodEnums(r.error) : short(r.result)}`);

  // goal show（只读）
  r = await rpc('session/goal', { ...sidArg, action: 'show' });
  console.log(`goal show -> ${r.error ? `err ${short(r.error)}` : short(r.result)}`);

  // updateRuntimeModelConfig：runtimeModel 内层 schema
  r = await rpc('session/updateRuntimeModelConfig', { ...sidArg, runtimeModel: {} });
  console.log(`updateRuntimeModelConfig {} -> ${r.error ? zodEnums(r.error) : short(r.result)}`);

  // cancelBackgroundTask：不存在的 taskId（业务错误语义）
  r = await rpc('session/cancelBackgroundTask', { ...sidArg, taskId: 'probe-not-exist' });
  console.log(`cancelBackgroundTask fake-id -> ${r.error ? `err ${short(r.error)}` : short(r.result)}`);

  // fork 实测（最旧会话，产生一个副本条目）
  r = await rpc('session/fork', sidArg);
  console.log(`fork -> ${r.error ? `err ${short(r.error)}` : short(r.result)}`);

  console.log('PROBE-DONE');
  process.exit(0);
}
main().catch((e) => fail(e.message));
