// 一次性探针（第四轮）：heal3 发现 clean 会话 send 也 -32031（全局性）。
// 本轮钉死两个问题：
//   A) 新建会话（无历史污染）能否发——区分「全局 provider 故障」vs「历史模型污染」；
//   B) setModel 后 close+重新 resume 再 send——验证 setModel 是否需重新 materialize。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${process.env.USERPROFILE}/.wzxclaw/zcode-companion/autostart.log`, "utf8");
const all = [...log.matchAll(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/g)];
if (!all.length) { console.log('RESULT: no-url-in-log'); process.exit(1); }
const u = new URL(all[all.length - 1][0]);
const q = {};
for (const part of u.search.slice(1).split('&')) {
  const i = part.indexOf('=');
  if (i > 0) q[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
}
const sid = q.sid;
const hash = q.hash;

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 120s'), 120000);

let nextId = 1;
const pending = new Map();
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, params } }));
  });
}
function dispatch(p) {
  const entry = pending.get(p.id);
  if (!entry) return;
  pending.delete(p.id);
  if (p.error) entry.reject(Object.assign(new Error(p.error.message || 'err'), { code: p.error.code, data: p.error.data }));
  else entry.resolve(p.result);
}
const brief = (v, n = 300) => {
  const s = JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

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
    if (msg.pair_status === 'matched' && nextId === 1) main().catch((e) => fail(e.message));
    return;
  }
  if (msg.type === 'data') dispatch(msg.payload || {});
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));

async function trySend(sessionId, label) {
  try {
    const r = await request('session/send', { sessionId, content: '（自检）只回复 ok' });
    console.log(`send[${label}] ACCEPTED: ${typeof r === 'string' ? `STRING: ${r}` : brief(r, 120)}`);
    return true;
  } catch (e) {
    console.log(`send[${label}] REJECTED code=${e.code} msg=${JSON.stringify(e.message)}${e.data ? ` data=${brief(e.data, 160)}` : ''}`);
    return false;
  }
}

async function main() {
  const list = await request('session/list', {});
  const sessions = (list && list.sessions) || [];
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const target = sessions[0];
  const wsShape = target.workspace || {};

  // A) 新会话：create → send → stop → close
  let newId = null;
  try {
    const created = await request('session/create', { workspace: wsShape });
    newId = (created && (created.sessionId || (created.session && created.session.sessionId))) || null;
    console.log(`A.create OK id=${newId && newId.slice(0, 13)} keys=${created ? Object.keys(created).join(',') : '?'}`);
  } catch (e) {
    console.log(`A.create ERR code=${e.code} msg=${brief(e.message, 200)}`);
  }
  if (newId) {
    if (await trySend(newId, 'A.new-session')) {
      await request('session/stop', { sessionId: newId }).catch(() => {});
      console.log('RESULT: new-session-sendable（全局 provider 正常，旧会话为历史模型污染）');
    }
    await request('session/close', { sessionId: newId }).catch(() => {});
  }

  // B) 死锁会话：resume → setModel(avail[0]) → close → resume → send
  const resume = await request('session/resume', { sessionId: target.sessionId });
  const avail = resume && resume.settings && resume.settings.model && resume.settings.model.available || [];
  const ref = (avail[0] || {}).ref || {};
  if (ref.modelId) {
    await request('session/setModel', { sessionId: target.sessionId, model: { providerId: ref.providerId, modelId: ref.modelId } });
    console.log(`B.setModel(${ref.modelId}) OK`);
    await request('session/close', { sessionId: target.sessionId }).catch((e) => console.log(`B.close ERR code=${e.code}`));
    await request('session/resume', { sessionId: target.sessionId }).catch((e) => console.log(`B.re-resume ERR code=${e.code}`));
    if (await trySend(target.sessionId, 'B.after-setmodel-close-resume')) {
      console.log('RESULT: healed-by-setmodel-rematerialize');
      await request('session/stop', { sessionId: target.sessionId }).catch(() => {});
    }
  } else {
    console.log('B.skip: no available models');
  }
  console.log('RESULT: done');
  process.exit(0);
}
