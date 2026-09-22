// probe-skillcatalog — 确认用户级技能（batch/verify/run/simplify）出现在大脑节点的技能目录里
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
    const proof = crypto.createHmac('sha256', hash).update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof })); return;
  }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    if (ran) return; ran = true;
    const r = await rpc('skills/referenceCatalog', {
      workspace: { workspaceKey: 'wzxclaw', workspacePath: 'E:\\ai\\wzxClaw' },
    });
    if (r.error) { console.log('ERROR =>', JSON.stringify(r.error).slice(0, 400)); process.exit(1); }
    const skills = (r.result && r.result.skills) || [];
    console.log('authority=', r.result && r.result.authority, ' total=', skills.length);
    const want = ['batch', 'verify', 'run', 'simplify'];
    for (const name of want) {
      const hit = skills.find(s => s.id === name || s.name === name);
      console.log(name.padEnd(10), hit ? `FOUND (source=${hit.source || '?'})` : 'MISSING');
    }
    console.log('--- 全部技能 id:');
    console.log(skills.map(s => s.id || s.name).join(', '));
    ws.close(); process.exit(0);
  }
});
