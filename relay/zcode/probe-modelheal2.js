// 一次性探针（第二轮）：钉死「模型不可用」会话的真正恢复动作。
// 上一轮结论：setModel {providerId,modelId} 对象格式被接受，但随后
// session/send 仍 -32031。本轮矩阵：
//   A) dump settings.model 全形（current/available）+ projection.lastError；
//   B) setModel 后 read 对比（current 是否变化、lastError 是否清除）；
//   C) send 带 model 参数（对象）——send 是否接受模型覆盖；
//   D) session/stop 后再 send；
//   E) setModel 切到 read 时刻 available 的第一个模型再 send。
// 每步输出结构化结果；所有自检 send 被接受后立即 stop 止损。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${process.env.USERPROFILE}/.wzxclaw/zcode-companion/autostart.log`, "utf8");
const all = [...log.matchAll(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/g)];
if (!all.length) { console.log('RESULT: no-url-in-log'); process.exit(1); }
const u = new URL(all[all.length - 1][0]); // 最后一条 = 最新凭据
// 手动解析 query：decodeURIComponent 不把字面 '+' 当空格（URLSearchParams
// 会——hash 含 '+' 时 HMAC 密钥被损坏，表现为 AUTH_FAILED）
const q = {};
for (const part of u.search.slice(1).split('&')) {
  const i = part.indexOf('=');
  if (i > 0) q[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
}
const sid = q.sid;
const hash = q.hash;

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 90s'), 90000);

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

const brief = (v, n = 400) => {
  const s = JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};
const modelBrief = (settings) =>
  settings && settings.model ? brief(settings.model, 500) : 'NONE';
const lastErr = (read) =>
  read && read.projection && read.projection.lastError
    ? brief(read.projection.lastError, 200)
    : 'none';
async function trySend(sessionId, label, extraParams) {
  try {
    const r = await request('session/send', {
      sessionId,
      content: '（自检）只回复 ok',
      ...extraParams,
    });
    console.log(`send[${label}] ACCEPTED: ${brief(r, 120)}`);
    await request('session/stop', { sessionId }).catch(() => {});
    return true;
  } catch (e) {
    console.log(`send[${label}] REJECTED code=${e.code} msg=${JSON.stringify(e.message)}${e.data ? ` data=${brief(e.data, 200)}` : ''}`);
    return false;
  }
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
    if (msg.pair_status === 'matched' && nextId === 1) main().catch((e) => fail(e.message));
    return;
  }
  if (msg.type === 'data') dispatch(msg.payload || {});
});
ws.on('close', (c) => fail(`ws-close ${c}`));
ws.on('error', (e) => fail(`ws-error ${e.message}`));

async function main() {
  const list = await request('session/list', {});
  const sessions = (list && list.sessions) || [];
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const sessionId = sessions[0].sessionId;
  console.log(`target title=${JSON.stringify(sessions[0].title)}`);

  // A) resume / read 的模型态
  const resume = await request('session/resume', { sessionId });
  console.log('A.resume settings.model:', modelBrief(resume.settings));
  const read1 = await request('session/read', { sessionId });
  console.log('A.read settings.model:', modelBrief(read1.settings));
  console.log('A.read projection.lastError:', lastErr(read1));

  // B) setModel → read 对比
  const r0 = (resume.settings.model.available[0] || {}).ref || {};
  await request('session/setModel', {
    sessionId,
    model: { providerId: r0.providerId, modelId: r0.modelId },
  });
  console.log('B.setModel(glm-5.3 via resume ref) OK');
  const read2 = await request('session/read', { sessionId });
  console.log('B.read settings.model:', modelBrief(read2.settings));
  console.log('B.read projection.lastError:', lastErr(read2));

  // C) send 带 model 覆盖
  if (await trySend(sessionId, 'C.with-model-param', {
    model: { providerId: r0.providerId, modelId: r0.modelId },
  })) { console.log('RESULT: healed-by-send-model-param'); return; }

  // D) stop 后普通 send
  await request('session/stop', { sessionId }).catch(() => {});
  if (await trySend(sessionId, 'D.after-stop', {})) { console.log('RESULT: healed-by-stop'); return; }

  // E) 切到 read 时刻 available 的第一个模型
  const r2 = ((read2.settings || {}).model || {}).available || [];
  const ref2 = ((r2[0] || {}).ref) || {};
  if (ref2.modelId && ref2.modelId !== r0.modelId) {
    await request('session/setModel', {
      sessionId,
      model: { providerId: ref2.providerId, modelId: ref2.modelId },
    });
    console.log(`E.setModel(${ref2.modelId}) OK`);
    if (await trySend(sessionId, 'E.after-switch', {})) { console.log('RESULT: healed-by-switch-model'); return; }
  } else {
    console.log('E.skip: read available 相同或为空');
  }

  console.log('RESULT: no-recovery-found');
}
