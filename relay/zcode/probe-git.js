// 一次性探针：实测 workspace/* 与 git 分支相关方法是否存在及其 schema。
// 背景：手机端要做「输入区工作区 chip + git 分支选择器」（对齐官方 ZCode
// 输入区），APP-SERVER.md 只记了 workspace/* 方法族存在、逐个方法未实测。
// 凭据从 companion 落盘的 pair-url.txt 读取，不打印、不落日志。
// 用法: node probe-git.js
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

// 只读候选方法（不触发任何切换/检出类变更）
const CANDIDATES = [
  ['workspace/list', {}],
  ['workspace/listRecent', {}],
  ['workspace/recent', {}],
  ['workspace/info', {}],
  ['workspace/status', {}],
  ['workspace/current', {}],
  ['git/status', {}],
  ['git/branches', {}],
  ['git/listBranches', {}],
  ['workspace/gitStatus', {}],
  ['workspace/gitBranches', {}],
  ['workspace/listBranches', {}],
  ['session/gitStatus', {}],
];

const ws = new WebSocket('wss://zcode.5945.top/ws', { handshakeTimeout: 15000 });
const fail = (why) => { console.log(`RESULT: fail: ${why}`); process.exit(1); };
setTimeout(() => fail('timeout 60s'), 60000);

let nextId = 1;
const pending = new Map();
const results = [];

function summarize(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 2) return `[${value.length}]`;
    return `[${value.length}] ${value.length ? summarize(value[0], depth + 1) : ''}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `{${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…' : ''}}`;
  }
  const s = String(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth_init', role: 'probe', device_sid: sid }));
});
ws.on('message', (rawMsg) => {
  let msg; try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
  if (msg.type === 'auth_challenge') {
    const proof = crypto.createHmac('sha256', hash)
      .update(`${msg.nonce}|probe|${sid}`).digest('base64url');
    ws.send(JSON.stringify({ type: 'auth_response', device_sid: sid, proof }));
    return;
  }
  if (msg.type === 'error') { fail(`relay-error ${msg.code}`); return; }
  if ((msg.type === 'auth_ack' || msg.type === 'pair_status_ack') && msg.pair_status === 'matched') {
    for (const [method, params] of CANDIDATES) {
      const id = nextId++;
      pending.set(id, method);
      ws.send(JSON.stringify({ type: 'data', payload: { id, method, params } }));
    }
    return;
  }
  if (msg.type === 'data') {
    const p = msg.payload || {};
    const method = pending.get(p.id);
    if (!method) return;
    pending.delete(p.id);
    if (p.error) {
      results.push(`${method} -> ERROR ${p.error.code} ${summarize(p.error.message)}`);
    } else {
      results.push(`${method} -> OK ${summarize(p.result)}`);
      if (method === 'workspace/list' || method === 'workspace/info') {
        results.push(`   detail: ${JSON.stringify(p.result).slice(0, 600)}`);
      }
    }
    if (pending.size === 0) {
      console.log(results.join('\n'));
      console.log('RESULT: done');
      ws.close();
      process.exit(0);
    }
  }
});
