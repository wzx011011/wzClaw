// probe-fork3 — 钉死 session/fork 成功路径的返回形状与复制语义
//   前置结论（probe-fork/fork2）：fork 只收 {sessionId}；历史非活跃会话 -32004；
//   无 checkpoint 的活跃会话 INVALID_STATE_TRANSITION。
//   本脚本：关掉 probe-fork 双触发泄漏的两个 scratch 会话 → 自建活跃会话 →
//   发一轮最小对话产生 checkpoint → fork → 读副本形状 → 全部清理。
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timeout: true }); } }, 30000);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
    const out = (label, v) => console.log(label, '=>', JSON.stringify(v).slice(0, 1200));
    const closeQuiet = async (id) => { const r = await rpc('session/close', { sessionId: id }); out('close ' + id.slice(0, 18), r.error ?? 'ok'); };

    // 0) 关掉早前探针遗留的会话（probe-fork 双触发的两个 scratch + 首轮 fork 副本）
    for (const id of [
      'sess_fa09dfaf-400c-4565-bacd-dbac2ae0259a',
      'sess_26d2719b-871a-4e2f-8014-712b6ab3899c',
      'sess_04a4f447-b0e7-4f26-86bd-b36d2f8c8898',
    ]) {
      await closeQuiet(id);
    }
    try {
      for (const d of fs.readdirSync(os.tmpdir())) {
        if (d.startsWith('probe-fork-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
      }
    } catch {}

    // 1) 自建活跃会话
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fork3-'));
    const created = await rpc('session/create', { workspace: { workspaceKey: 'probe-fork3', workspacePath: tmpDir } });
    const srcId = created.result && created.result.session && created.result.session.sessionId;
    if (!srcId) { out('create failed', created.error); process.exit(1); }
    console.log('scratch src:', srcId);

    // 2) 一轮最小对话，产生 checkpoint（fork 前置条件 = 工作区文件变更）
    //    临时目录不在信任清单，写文件会触发权限反向请求把回合挂死——先 yolo 绕过
    const sm = await rpc('session/setMode', { sessionId: srcId, mode: 'yolo' });
    out('session/setMode{yolo}', sm.error ?? 'ok');
    const sent = await rpc('session/send', { sessionId: srcId, content: '在当前工作目录创建文件 hello.txt，内容为一行：hi。除此之外不要做任何事，不要回复多余内容。' });
    out('session/send', sent.error ?? 'accepted');
    let turned = false;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      // projection.status 是 create 返回实证的形状；status 变 idle 即回合结束
      const rd = await rpc('session/read', { sessionId: srcId });
      const s = rd.result && rd.result.projection && rd.result.projection.status;
      if (i % 5 === 4) console.log('poll', i, 'projection.status=', s);
      if (s && s !== 'running' && s !== 'waiting') { turned = true; break; }
    }
    console.log('turn finished:', turned);
    if (!turned) { await closeQuiet(srcId); console.log('TURN-TIMEOUT'); process.exit(1); }

    // 3) fork 成功路径
    const fk = await rpc('session/fork', { sessionId: srcId });
    out('session/fork SUCCESS-SHAPE', fk.error ?? fk.result);
    const fkBody = fk.result || {};
    // 实测字段：forkedSessionId（不是 sessionId）
    const forkId = fkBody.forkedSessionId || fkBody.sessionId || (fkBody.session && fkBody.session.sessionId);

    if (forkId) {
      const st = await rpc('session/status', { sessionId: forkId });
      out('fork session/status', st.error ?? st.result);
      const fr = await rpc('session/read', { sessionId: forkId });
      const fb = fr.result || fr.error || {};
      const srcR = await rpc('session/read', { sessionId: srcId });
      const sb = srcR.result || srcR.error || {};
      console.log('fork msgs=', Array.isArray(fb.messages) ? fb.messages.length : '(n/a)',
        ' src msgs=', Array.isArray(sb.messages) ? sb.messages.length : '(n/a)',
        ' fork workspace=', JSON.stringify((fb.session && fb.session.workspace) || fkBody.workspace || '(见上)').slice(0, 200));
      await closeQuiet(forkId);
    }

    // 4) 清理
    await closeQuiet(srcId);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log('DONE');
    ws.close(); process.exit(0);
  }
});
