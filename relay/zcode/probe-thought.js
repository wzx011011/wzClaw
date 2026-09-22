// probe-thought — 钉死 session/setThoughtLevel：参数名、合法值、读回路径
// 不发消息、不烧模型回合；建 scratch → set → session/read 找落点 → 清理
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { deriveProof } = require('./lib/proof');

const raw = fs.readFileSync(path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'pair-url.txt'), 'utf8').trim();
const m = raw.match(/https?:\/\/\S*\/pair\?sid=[^&\s]+&hash=[^&\s]+/);
const u = new URL(m[0]);
const sid = u.searchParams.get('sid');
const hash = decodeURIComponent(u.searchParams.get('hash'));
const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
let nextId = 1; const pending = new Map();
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++; pending.set(id, resolve);
  ws.send(JSON.stringify({ type: 'data', payload: { id, method, ...(params ? { params } : {}) } }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, 20000);
});
let ran = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', async (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (pending.has(p.id)) { pending.get(p.id)(p); pending.delete(p.id); }
    return;
  }
  if (msg.type === 'auth_challenge') {
    const proof = deriveProof({ passHash: hash, nonce: msg.nonce, role: 'probe', sid });
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof })); return;
  }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    if (ran) return; ran = true;
    const out = (label, v) => console.log(label, '=>', JSON.stringify(v).slice(0, 600));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-thought-'));

    const created = await rpc('session/create', { workspace: { workspaceKey: 'probe-thought', workspacePath: tmpDir } });
    const srcId = created.result && created.result.session && created.result.session.sessionId;
    if (!srcId) { out('create failed', created.error); process.exit(1); }

    // 基线：read 里 thoughtLevel/reasoning 相关字段的初始值
    const before = await rpc('session/read', { sessionId: srcId });
    const b = before.result || {};
    console.log('baseline session.model =', JSON.stringify(b.session && b.session.model));
    console.log('baseline projection keys =', b.projection ? Object.keys(b.projection).join(',') : '(none)');

    // 参数名两形态
    const s1 = await rpc('session/setThoughtLevel', { sessionId: srcId, thoughtLevel: 'high' });
    out('setThoughtLevel{thoughtLevel:high}', s1.error ?? s1.result);
    if (s1.error) {
      const s2 = await rpc('session/setThoughtLevel', { sessionId: srcId, level: 'high' });
      out('setThoughtLevel{level:high}', s2.error ?? s2.result);
    }
    // 非法值口径
    const s3 = await rpc('session/setThoughtLevel', { sessionId: srcId, thoughtLevel: 'bogus' });
    out('setThoughtLevel{bogus}', s3.error ?? s3.result);

    // 读回：找 thoughtLevel 落点
    const after = await rpc('session/read', { sessionId: srcId });
    const a = after.result || {};
    console.log('after session.model =', JSON.stringify(a.session && a.session.model));
    console.log('after projection.thoughtLevel =', a.projection && a.projection.thoughtLevel);

    const cl = await rpc('session/close', { sessionId: srcId });
    out('close', cl.error ?? 'ok');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log('DONE');
    ws.close(); process.exit(0);
  }
});
