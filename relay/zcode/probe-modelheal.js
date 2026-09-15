// 一次性探针：真链路验证「模型不可用 → setModel 自愈 → 重发」完整路径。
// 背景：手机端 -32031 错误帧（历史任务使用的模型已不可用）。store 的兜底
// 发 session/setModel {model: 'providerId/modelId'} 字符串——该格式从未对
// 真服务端验证过。本探针在最新会话上：
//   1) resume 取 settings.model.available[0] 构造模型引用；
//   2) send 一条自检消息，确认拒绝形态（错误帧 -32031 / 字符串 result）；
//   3) setModel 按格式回退链尝试：'p/m' 字符串 → {providerId,modelId} 对象
//      → 裸 modelId，钉死服务端接受的形状；
//   4) setModel 成功后重发，验证 accepted；随后 session/stop 止损。
// 只输出结构化结果，不打印凭据。
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
setTimeout(() => fail('timeout 60s'), 60000);

let nextId = 1;
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, params } }));
  });
}
const pending = new Map();
function dispatch(p) {
  const entry = pending.get(p.id);
  if (!entry) return;
  pending.delete(p.id);
  if (p.error) entry.reject(Object.assign(new Error(p.error.message || 'err'), { code: p.error.code }));
  else entry.resolve(p.result);
}

const brief = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
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
  // 1. 最新会话
  const list = await request('session/list', {});
  const sessions = (list && list.sessions) || [];
  if (!sessions.length) { console.log('RESULT: no-sessions'); return; }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const target = sessions[0];
  const sessionId = target.sessionId;
  console.log(`target updatedAt=${target.updatedAt} title=${JSON.stringify(target.title)}`);

  // 2. resume 取可用模型
  const resume = await request('session/resume', { sessionId });
  const avail =
    resume && resume.settings && resume.settings.model &&
    Array.isArray(resume.settings.model.available)
      ? resume.settings.model.available
      : [];
  if (!avail.length) { console.log('RESULT: no-available-models'); return; }
  const ref = (avail[0] && avail[0].ref) || {};
  const providerId = ref.providerId || '';
  const modelId = ref.modelId || '';
  console.log(`available n=${avail.length} ref0=${providerId}/${modelId}`);

  // 3. 首次 send：确认拒绝形态
  try {
    const r1 = await request('session/send', {
      sessionId,
      content: '（自检）只回复 ok',
    });
    console.log('send#1-result:', typeof r1 === 'string' ? `STRING: ${r1}` : brief(r1));
    console.log('RESULT: send-not-rejected（会话当前模型可用，无需自愈）');
    return;
  } catch (e) {
    console.log(`send#1-rejected: code=${e.code} msg=${JSON.stringify(e.message)}`);
  }

  // 4. setModel 格式回退链
  const attempts = [
    ['string p/m', modelId ? `${providerId}/${modelId}` : null],
    ['object {providerId,modelId}', (providerId && modelId) ? { providerId, modelId } : null],
    ['bare modelId', modelId || null],
  ];
  let setOk = null;
  for (const [label, model] of attempts) {
    if (model == null) continue;
    try {
      const r = await request('session/setModel', { sessionId, model });
      console.log(`setModel[${label}] OK: ${brief(r)}`);
      setOk = label;
      break;
    } catch (e) {
      console.log(`setModel[${label}] ERR code=${e.code} msg=${brief(e.message)}`);
    }
  }
  if (setOk == null) { console.log('RESULT: setmodel-all-formats-failed'); return; }
  console.log(`ACCEPTED-FORMAT: ${setOk}`);

  // 5. 重发验证 + 止损
  try {
    const r2 = await request('session/send', {
      sessionId,
      content: '（自检）只回复 ok',
    });
    console.log('send#2-result:', typeof r2 === 'string' ? `STRING: ${r2}` : brief(r2));
    if (typeof r2 !== 'string') {
      await request('session/stop', { sessionId }).catch(() => {});
      console.log('RESULT: healed');
    } else {
      console.log('RESULT: setmodel-ok-but-send-still-rejected');
    }
  } catch (e) {
    console.log(`send#2-rejected: code=${e.code} msg=${JSON.stringify(e.message)}`);
    console.log('RESULT: setmodel-ok-but-send-still-rejected');
  }
}
