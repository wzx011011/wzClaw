// 只读探针：从 resume/subscribe/read 响应与推送通知中抓取模型目录结构。
// 输出仅含模型/提供商显示名与字段形状（非敏感），不含凭据。
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const log = fs.readFileSync(`${__dirname}/pairing-qr.log`, 'utf8');
const m = log.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
if (!m) { console.log('RESULT: no-url'); process.exit(1); }
const u = new URL(m[m.length - 1]);
const sid = u.searchParams.get('sid');
const hash = u.searchParams.get('hash');
const ws = new WebSocket(u.origin.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 45s'), 45000);

let nextId = 1;
const pending = new Map();
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('rpc timeout')); } }, 20000);
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
      const entry = pending.get(p.id);
      pending.delete(p.id);
      p.error ? entry.reject(new Error(JSON.stringify(p.error))) : entry.resolve(p.result);
      return;
    }
    if (p.method) walkValue(p.params || p.payload || {}, `push:${p.method}`);
  }
});

let done = false;
function walkValue(node, label) {
  if (done || !node || typeof node !== 'object') return;
  const found = [];
  const walk = (n, path, depth) => {
    if (depth > 5 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      if (n.length && n[0] && typeof n[0] === 'object' && n[0].ref) found.push({ path, arr: n });
      for (let i = 0; i < Math.min(n.length, 5); i++) walk(n[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(n)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(node, '', 0);
  // 额外：打印 settings.model 的非 available 部分（当前选中模型形状）
  const findModel = (n, path, depth) => {
    if (depth > 5 || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n.slice(0,3)) findModel(x, path, depth+1); return; }
    for (const [k,v] of Object.entries(n)) {
      if (k === 'model' && v && typeof v === 'object' && !Array.isArray(v) && v.available) {
        const clone = { ...v };
        delete clone.available;
        console.log('[' + label + '] settings.model (minus available) =', JSON.stringify(clone).slice(0, 500));
      }
      findModel(v, path ? path+'.'+k : k, depth+1);
    }
  };
  findModel(node, '', 0);
  if (!found.length) { console.log(`[${label}] no model catalog array; keys=${Object.keys(node).join(',')}`); return; }
  done = true;
  for (const { path, arr } of found) {
    console.log(`[${label}] MODEL CATALOG @ ${path} (count=${arr.length})`);
    const byProvider = new Map();
    for (const item of arr) {
      const ref = item.ref || {};
      const pid = ref.providerId || '?';
      if (!byProvider.has(pid)) byProvider.set(pid, []);
      byProvider.get(pid).push({
        modelId: ref.modelId,
        extra: Object.keys(item).filter((k) => k !== 'ref').join(','),
        name: item.displayName || item.name || item.label || '',
      });
    }
    for (const [pid, models] of byProvider) {
      console.log(`  provider=${pid} (${models.length} models)`);
      for (const mm of models.slice(0, 10)) {
        console.log(`    - ${mm.modelId}${mm.name ? ` [${mm.name}]` : ''}${mm.extra ? ` {${mm.extra}}` : ''}`);
      }
      if (models.length > 10) console.log(`    ... +${models.length - 10} more`);
    }
  }
  console.log('PROBE-DONE');
  process.exit(0);
}

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1500));
  const list = await rpc('session/list');
  const sessions = ((list && list.sessions) || [])
    .filter((s) => s.sessionId !== 'sess_7c449132-d5d7-44ab-a7d8-350329632757') // 桌面端活跃对话，不可碰
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sessions.length) { fail('no eligible sessions'); return; }
  const target = sessions[0];
  console.log(`target updatedAt=${target.updatedAt}`);
  const resumeResult = await rpc('session/resume', { sessionId: target.sessionId });
  walkValue(resumeResult, 'resume');
  const subResult = await rpc('session/subscribe', { sessionId: target.sessionId, deliveryKind: 'web-remote-replayable' });
  walkValue(subResult, 'subscribe');
  const readResult = await rpc('session/read', { sessionId: target.sessionId });
  walkValue(readResult, 'read');
  console.log('(waiting briefly for state.updated push...)');
}
main().catch((e) => fail(e.message));
