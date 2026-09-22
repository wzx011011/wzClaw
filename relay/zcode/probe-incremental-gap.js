'use strict';
// 定向探针（2026-09-22 夜）：复盘会话 sess_da582a41 回合末尾两条消息
// （#48/#49）在手机视口缺失——验证引擎增量分页 session/messages
// afterMessageId 是否正确返回它们（决定「点刷新能否治愈」）。
// 只读：list/resume/messages/read，无副作用。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const pairUrl = fs.readFileSync(
  `${process.env.HOME || process.env.USERPROFILE}/.wzxclaw/zcode-companion/pair-url.txt`,
  'utf8',
);
const m = pairUrl.match(/https?:\/\/\S*\/pair\?sid=([^&\s]+)&hash=([^&\s]+)/);
if (!m) { console.log('RESULT: fail no-pair-url'); process.exit(1); }
const sid = decodeURIComponent(m[1]);
const hash = decodeURIComponent(m[2]);
const u = new URL(pairUrl.trim());
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
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); }
    }, 15000);
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
const AFTER_47 = 'msg_muco06dj_9f2a5030-816d-4018-afa3-bf76a2f6decb';

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1200));

  const resume = await rpc('session/resume', { sessionId: SID });
  if (resume.error) console.log('resume error:', JSON.stringify(resume.error).slice(0, 200));

  // 手机端回合末对账的实际调用形状：增量 afterMessageId
  const inc = await rpc('session/messages', { sessionId: SID, afterMessageId: AFTER_47 });
  if (inc.error) {
    console.log('incremental error:', JSON.stringify(inc.error).slice(0, 300));
  } else {
    const msgs = (inc.result && inc.result.messages) || [];
    console.log('incremental(after #47) ->', msgs.length, '条');
    for (const msg of msgs) {
      const info = msg.info || {};
      const texts = (msg.parts || []).filter((p) => p.type === 'text')
        .map((p) => `text[${(p.text || '').length}]`);
      console.log(`  id=${info.id} role=${info.role} finish=${info.finish} ${texts.join(',') || '(无 text part)'}`);
    }
  }

  // 对照：手机打开会话的尾窗形状 {limit}
  const tail = await rpc('session/messages', { sessionId: SID, limit: 6 });
  const tmsgs = (tail.result && tail.result.messages) || [];
  console.log('tail(limit 6) ->', tmsgs.length, '条, ids:');
  for (const msg of tmsgs) console.log('  ', (msg.info || {}).id, (msg.info || {}).finish);

  console.log('RESULT: ok');
  process.exit(0);
}
main().catch((e) => fail(e.message));
