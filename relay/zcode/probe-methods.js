// 只读优先探针：对 9 个未实现接口做 schema 发现。
// 策略：全部先发空参数 {} —— 有必填字段时服务端回 -32602 ZodError
// （完整字段路径与类型），零副作用拿到请求 schema；
// 只读接口（usage/subagents/goal 查询）再用 sessionId 真实调用一次。
// 绝不触碰桌面端当前活跃对话 sess_7c449132-d5d7-44ab-a7d8-350329632757。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const LIVE = 'sess_7c449132-d5d7-44ab-a7d8-350329632757';
const log = fs.readFileSync(`${__dirname}/pairing-qr.log`, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('RESULT: no-url'); process.exit(1); }
const u = new URL(m[m.length - 1]);
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');
const ws = new WebSocket(u.origin.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 90s'), 90000);

let nextId = 1;
const pending = new Map();
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); }
    }, 12000);
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
    if (p.id != null && pending.has(p.id)) {
      pending.get(p.id).resolve(p);
      pending.delete(p.id);
    }
  }
});

const short = (v) => {
  const s = JSON.stringify(v);
  return s.length > 420 ? `${s.slice(0, 420)}…` : s;
};

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1500));
  const list = await rpc('session/list');
  const result = list.result || {};
  const sessions = (result.sessions || [])
    .filter((s) => s.sessionId !== LIVE)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sessions.length) { fail('no eligible sessions'); return; }
  const target = sessions[sessions.length - 1]; // 取最旧的会话做试验，把影响降到最低
  console.log(`target(oldest) ${target.sessionId} updatedAt=${target.updatedAt}`);
  const sidArg = { sessionId: target.sessionId };

  // 1) resume 激活（后续调用需要会话在场）
  await rpc('session/resume', sidArg);

  // 2) 空参数 ZodError 反推 schema（校验失败即返回，无副作用）
  const methods = [
    'session/setThoughtLevel', 'session/usage', 'session/compact',
    'session/fork', 'session/cancelBackgroundTask', 'session/goal',
    'session/subagents', 'session/updateRuntimeModelConfig', 'session/close',
  ];
  for (const method of methods) {
    const resp = await rpc(method, {});
    const err = resp.error;
    if (err) {
      console.log(`\n### ${method} {} -> error ${err.code}`);
      console.log(`  schema: ${short(err.data && err.data.message || err.message)}`);
    } else {
      // 空参数被接受（全部字段可选）：打印响应形状，标注"已执行！"
      console.log(`\n### ${method} {} -> EXECUTED result: ${short(resp.result)}`);
    }
  }

  // 3) 只读接口真实调用（带 sessionId）
  for (const method of ['session/usage', 'session/subagents', 'session/goal']) {
    const resp = await rpc(method, sidArg);
    console.log(`\n### ${method} (real) -> ${resp.error ? `error ${short(resp.error)}` : `result: ${short(resp.result)}`}`);
  }
  console.log('\nPROBE-DONE');
  process.exit(0);
}
main().catch((e) => fail(e.message));
