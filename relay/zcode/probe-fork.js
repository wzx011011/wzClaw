// 一次性补探：session/fork 的 schema 与语义（参数/结果/消息复制/生命周期）+ setThoughtLevel 复核
// 只动自建 scratch 会话，不碰真实会话；结束清理 fork 出的会话与临时目录
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fork-'));
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid })));
ws.on('message', async (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    if (pending.has(p.id)) { pending.get(p.id)(p); pending.delete(p.id); }
    return;
  }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash).update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof })); return;
  }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    const out = (label, v) => console.log(label, '=>', JSON.stringify(v).slice(0, 800));

    // 1) 建 scratch 会话当 fork 源（不动真实会话）
    const created = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-fork-src', workspacePath: tmpDir },
    });
    out('session/create', created.error ?? created.result);
    const srcId = created.result && (created.result.sessionId || (created.result.session && created.result.session.sessionId));
    if (!srcId) { console.log('CREATE-FAILED'); process.exit(1); }

    // 2) fork：裸参 {sessionId}，记录原始形状
    const fk = await rpc('session/fork', { sessionId: srcId });
    out('session/fork{sessionId}', fk.error ?? fk.result);
    const fkBody = fk.result || {};
    const forkId = fkBody.sessionId || (fkBody.session && fkBody.session.sessionId);

    if (forkId) {
      // 3) fork 出的会话：status / read，看复制了什么、kind 是什么
      const st = await rpc('session/status', { sessionId: forkId });
      out('fork session/status', st.error ?? st.result);
      const fr = await rpc('session/read', { sessionId: forkId });
      const body = fr.result || fr.error || {};
      console.log('fork session/read keys=', Object.keys(body).join(','), 'msgs=', Array.isArray(body.messages) ? body.messages.length : '(n/a)');
      // 4) setThoughtLevel 复核（参数名 thoughtLevel vs level）
      const s1 = await rpc('session/setThoughtLevel', { sessionId: forkId, thoughtLevel: 'high' });
      out('setThoughtLevel{thoughtLevel:high}', s1.error ?? s1.result);
      if (s1.error) {
        const s2 = await rpc('session/setThoughtLevel', { sessionId: forkId, level: 'high' });
        out('setThoughtLevel{level:high}', s2.error ?? s2.result);
      }
      // 5) 清理 fork
      const cl = await rpc('session/close', { sessionId: forkId });
      out('fork session/close', cl.error ?? 'ok');
    } else {
      out('session/fork{}(no params)', await rpc('session/fork', {}));
    }

    // 6) 清理 scratch 源与临时目录
    const cls = await rpc('session/close', { sessionId: srcId });
    out('src session/close', cls.error ?? 'ok');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log('DONE');
    ws.close(); process.exit(0);
  }
});
