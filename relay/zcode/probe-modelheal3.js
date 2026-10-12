// 一次性探针（第三轮）：验证 -32031 死锁是否 per-session。
// heal2 结论：目标会话 current=lastUsed=available[0]=glm-5.3 同一模型仍 -32031，
// setModel / stop / send+model 参数全部无效 → 疑似历史 turn 引用已下线模型。
// 本轮：
//   A) 死锁会话 read 后 dump projection 顶层 keys + 形状（找 turn 状态线索）；
//   B) 取最新 5 个会话逐个 read（lastError 有无）+ 自检 send（成功立即 stop），
//      验证「其他会话可发」→ 证明链路健康、死锁 per-session，新建会话是逃生口。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${process.env.USERPROFILE}/.wzxclaw/zcode-companion/autostart.log`, "utf8");
const all = [...log.matchAll(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/g)];
if (!all.length) { console.log('RESULT: no-url-in-log'); process.exit(1); }
const u = new URL(all[all.length - 1][0]);
// 手动解析 query：decodeURIComponent 不把字面 '+' 当空格
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

const brief = (v, n = 400) => {
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

async function main() {
  const list = await request('session/list', {});
  const sessions = (list && list.sessions) || [];
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const picks = sessions.slice(0, 5);
  console.log(`total=${sessions.length} picks=${picks.length}`);

  // A) 死锁会话（最新的那个）projection 顶层形状
  const deadlock = picks[0];
  const read0 = await request('session/read', { sessionId: deadlock.sessionId }).catch((e) => {
    console.log(`A.read ERR code=${e.code} msg=${brief(e.message, 120)}`); return null;
  });
  if (read0 && read0.projection) {
    console.log('A.projection-keys:', Object.keys(read0.projection).join(','));
    const le = read0.projection.lastError;
    if (le) console.log('A.lastError:', brief(le, 200));
  }

  // B) 逐会话自检（send 前必须 resume materialize，否则 -32004）
  let sendable = 0;
  for (const s of picks) {
    const r = await request('session/read', { sessionId: s.sessionId }).catch(() => null);
    const le = r && r.projection && r.projection.lastError ? 'LASTERR' : 'clean';
    const resumed = await request('session/resume', { sessionId: s.sessionId })
      .then(() => true).catch((e) => { console.log(`  resume ERR code=${e.code}`); return false; });
    let outcome = 'NO-RESUME';
    if (resumed) {
      try {
        await request('session/send', { sessionId: s.sessionId, content: '（自检）只回复 ok' });
        outcome = 'SEND-OK';
        sendable++;
      } catch (e) {
        outcome = `REJECT-${e.code}`;
      }
      await request('session/stop', { sessionId: s.sessionId }).catch(() => {});
    }
    console.log(`B ${s.sessionId.slice(0, 13)} ${le} ${outcome} title=${JSON.stringify((s.title || '').slice(0, 24))}`);
  }
  console.log(`RESULT: sendable=${sendable}/${picks.length}`);
  process.exit(0);
}
