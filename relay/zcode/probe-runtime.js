// 一次性探针：实测输入区三个快捷钮需要的协议面（只读为主）。
// 1) state.updated 初始快照：读当前 mode/model/permission/thoughtLevel 实际取值
// 2) session/setThoughtLevel：用「当前值回设」探测参数形状（无净行为变更）；
//    -32602 的 zod 报错会揭示期望字段（setModel 实测先例）
// 3) session/usage：上下文用量形状（只读）
// 4) 模型目录候选：session/models / model/list / provider/list（只读）
// 凭据走 companion 落盘 pair-url.txt，不打印。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const urlFile = path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'pair-url.txt');
const raw = fs.readFileSync(urlFile, 'utf8').trim();
const m = raw.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('RESULT: no-url'); process.exit(1); }
const u = new URL(m[0]);
const sid = u.searchParams.get('sid');
const hash = decodeURIComponent(u.searchParams.get('hash'));

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 90s'), 90000);

let nextId = 1;
const pending = new Map();
let snapshot = null;
let sessionId = null;

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { method, resolve });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); }
    }, 20000);
  });
}

const summarize = (v, depth = 0) => {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return depth > 2 ? `[${v.length}]` : `[${v.length}] ${v.length ? summarize(v[0], depth + 1) : ''}`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 14).join(',')}${keys.length > 14 ? ',…' : ''}}`;
  }
  const s = String(v);
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
};

ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', async (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'error') { fail(`relay-error ${msg.code}`); return; }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    const list = await rpc('session/list', {});
    const sessions = (list.result && list.result.sessions) || [];
    if (!sessions.length) { fail('no sessions'); return; }
    sessionId = sessions[0].sessionId;
    console.log(`[probe] sessionId=${sessionId}`);

    // 2) 订阅拿 state.updated 初始快照
    const sub = await rpc('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
    console.log(`[probe] subscribe -> ${summarize(sub.result ?? sub.error)}`);
    // 快照可能随订阅确认推送，稍等
    await new Promise((r) => setTimeout(r, 3000));

    // 3) thoughtLevel 形状探测：回设当前值（若有）
    const tl = snapshot && snapshot.thoughtLevel;
    console.log(`[probe] 当前 thoughtLevel=${JSON.stringify(tl ?? '未捕获')}`);
    if (tl !== undefined && tl !== null) {
      for (const params of [
        { sessionId, level: tl },
        { sessionId, thoughtLevel: tl },
      ]) {
        const r = await rpc('session/setThoughtLevel', params);
        console.log(`[probe] setThoughtLevel ${summarize(params)} -> ${summarize(r.result ?? r.error ?? r)}`);
        if (!r.__timeout && !r.error) break;
      }
    }

    // 4) usage 形状
    const usage = await rpc('session/usage', { sessionId });
    console.log(`[probe] session/usage -> ${summarize(usage.result ?? usage.error ?? usage)}`);
    if (usage.result) console.log(`   detail: ${JSON.stringify(usage.result).slice(0, 700)}`);

    // 5) 模型目录候选（只读）
    for (const method of ['session/models', 'model/list', 'provider/list', 'session/providers']) {
      const r = await rpc(method, { sessionId });
      const body = r.result ?? r.error ?? r;
      console.log(`[probe] ${method} -> ${summarize(body)}`);
      if (r.result) console.log(`   detail: ${JSON.stringify(r.result).slice(0, 700)}`);
    }

    console.log('RESULT: done');
    ws.close();
    process.exit(0);
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (pending.has(p.id)) { const { resolve } = pending.get(p.id); pending.delete(p.id); resolve(p); return; }
    // state.updated 快照：抓 method/事件里的 thoughtLevel/model
    const method = p.method || '';
    if (method.includes('state')) {
      const st = (p.params && (p.params.state || p.params)) || {};
      snapshot = st;
      console.log(`[probe] state(${method}) -> ${summarize(st)}`);
      console.log(`   keys: mode=${JSON.stringify(st.mode)} model=${JSON.stringify(st.model)} permission=${JSON.stringify(st.permission)} thoughtLevel=${JSON.stringify(st.thoughtLevel)}`);
    }
  }
});
