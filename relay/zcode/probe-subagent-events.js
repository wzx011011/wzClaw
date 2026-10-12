'use strict';
// 子代理事件形状捕获：新会话 → 派一个最小子代理 → 抓父会话事件流全量落盘。
// 目的：钉死「子代理工具进度是否走父会话订阅推送、事件里带什么标识字段」，
// 为手机端过滤子工具泄漏提供契约依据。
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const pairUrl = fs.readFileSync(
  path.join(os.homedir(), '.wzxclaw/zcode-companion/pair-url.txt'), 'utf8');
const m = pairUrl.match(/https?:\/\/\S*\/pair\?sid=([^&\s]+)&hash=([^&\s]+)/);
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, 20000);
  });
}

const events = [];
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
      return;
    }
    // 非应答帧 = 事件推送，全量记录
    events.push({ t: Date.now(), frame: p });
  }
});

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1200));
  const created = await rpc('session/create', {
    workspace: { workspaceKey: 'wzxClaw', workspacePath: 'E:\\ai\\wzxClaw' },
  });
  const newSid = created?.result?.session?.sessionId;
  console.log('created:', newSid);
  await rpc('session/resume', { sessionId: newSid });
  await rpc('session/subscribe', { sessionId: newSid, deliveryKind: 'web-remote-replayable' });
  events.length = 0; // 订阅前的杂帧不记
  const sent = await rpc('session/send', {
    sessionId: newSid,
    content: '请用 Agent 工具派一个 Explore 子代理，让它只读取 package.json 的 name 字段然后立刻结束。子代理结束后用一句话汇报。',
  });
  console.log('send:', JSON.stringify(sent).slice(0, 150));
  // mid-turn 轮询：每 3 秒拉父时间线，抓临时子进度行
  const midturn = [];
  for (let i = 0; i < 26; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const msgs = await rpc('session/messages', { sessionId: newSid, limit: 8 });
    const list = msgs?.result?.messages || [];
    const snap = [];
    for (const msg of list) {
      const info = msg.info || {};
      for (const part of msg.parts || []) {
        if (part.type === 'tool') {
          snap.push({
            msgId: (info.id || '').slice(-12),
            agent: info.agent || null,
            tool: part.tool,
            status: part.state?.status,
            hasInput: !!(part.state?.input && String(part.state.input).trim()),
            callId: (part.callID || '').slice(-8),
          });
        }
      }
    }
    if (snap.length) midturn.push({ at: Date.now(), snapshot: snap });
  }
  const out2 = path.join(os.tmpdir(), 'midturn-messages.json');
  fs.writeFileSync(out2, JSON.stringify(midturn, null, 1));
  console.log('midturn snapshots:', midturn.length, '->', out2);
  const out = path.join(os.tmpdir(), 'subagent-events.json');
  fs.writeFileSync(out, JSON.stringify(events, null, 1));
  console.log('events:', events.length, '->', out);
  // 摘要：事件类型分布 + 工具事件的字段
  const kinds = {};
  for (const e of events) {
    const k = e.frame.type || e.frame.method || '?';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  console.log('kinds:', JSON.stringify(kinds));
  process.exit(0);
}
main().catch((e) => { console.log('fail', e.message); process.exit(1); });
