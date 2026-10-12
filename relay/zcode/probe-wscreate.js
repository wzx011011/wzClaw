'use strict';

// probe-wscreate — 实测 session/create 的 workspace 参数语义（手机端
// 「新建会话时自选节点目录」的前置探针）：
//   1. workspacePath = 一个从未注册过的 mkdtemp 任意目录 + 自造 key → 能否建？
//   2. workspacePath = 不存在的路径 → 报什么错？
//   3. session/list 里新会话的 workspace 回显形状。
// 安全约束：直连 app-server stdio；引擎 cwd 与 workspace 均为 mkdtemp
// 临时目录；不发消息、不跑工具；结束 session/close 并清理临时目录。
// 用法: node probe-wscreate.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const ENGINE_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-wsc-engine-'));
const WS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-wsc-ws-'));
const WS_MISSING = path.join(WS_DIR, 'no-such-subdir');

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.env.ZCODE_BIN, args: [] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', ENGINE_CWD], {
  cwd: ENGINE_CWD, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1;
const pending = new Map();
const events = [];
let buffer = '';

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, 30000).unref();
  });
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f && f.id != null && (f.result !== undefined || f.error !== undefined) && !f.method) {
      const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); }
      continue;
    }
    events.push(f);
    if (f.method && f.id != null) {
      // 反向请求：runtime prefs 代答；其余记录后拒绝（本探针不该出现别的）
      if (f.method === 'session/requestRuntimePreferences') {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        continue;
      }
      console.log(`reverse-request: ${f.method} scope=${f.params?.scope || '?'}`);
      send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
    }
  }
});
child.stderr.on('data', (c) => {
  for (const l of c.toString().split('\n')) if (l.trim()) console.log('stderr:', l.slice(0, 300));
});

function shape(v, depth = 0) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (depth > 2) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  if (Array.isArray(v)) return `[${v.slice(0, 3).map((x) => shape(x, depth + 1)).join(', ')}${v.length > 3 ? ', …' : ''}]`;
  const keys = Object.keys(v).slice(0, 12);
  return `{${keys.map((k) => `${k}: ${shape(v[k], depth + 1)}`).join(', ')}}`;
}

async function main() {
  await new Promise((r) => setTimeout(r, 3000)); // 引擎启动

  console.log('\n=== 1) session/create + 从未注册的任意目录 ===');
  const r1 = await request('session/create', {
    workspace: { workspaceKey: 'probe-arbitrary-key', workspacePath: WS_DIR },
  });
  if (r1.__timeout) {
    console.log('RESULT: timeout（可能被 materialization 反向请求卡住，见上方日志）');
  } else if (r1.error) {
    console.log('RESULT: error', JSON.stringify(r1.error).slice(0, 500));
  } else {
    console.log('RESULT: ok');
    console.log('session:', shape(r1.result?.session));
    console.log('workspace echo:', JSON.stringify(r1.result?.session?.workspace));
    console.log('projection:', shape(r1.result?.projection));
    const sid1 = r1.result?.session?.sessionId;
    const rl = await request('session/list', {});
    const hit = (rl.result?.sessions || []).find((s) => s.sessionId === sid1);
    console.log('session/list workspace:', JSON.stringify(hit?.workspace));
    if (sid1) await request('session/close', { sessionId: sid1 });
  }

  console.log('\n=== 2) session/create + 不存在的路径 ===');
  const r2 = await request('session/create', {
    workspace: { workspaceKey: 'probe-missing-path', workspacePath: WS_MISSING },
  });
  if (r2.__timeout) console.log('RESULT: timeout');
  else if (r2.error) console.log('RESULT: error code=', r2.error.code, 'message=', String(r2.error.message).slice(0, 200));
  else {
    console.log('RESULT: ok（引擎自动建目录？）');
    console.log('workspace echo:', JSON.stringify(r2.result?.session?.workspace));
    const sid2 = r2.result?.session?.sessionId;
    if (sid2) await request('session/close', { sessionId: sid2 });
    console.log('dir created on disk:', fs.existsSync(WS_MISSING));
  }

  console.log('\n=== 3) workspace/* 方法存在性（抽查） ===');
  for (const m of ['workspace/list', 'workspace/info', 'workspace/create']) {
    const r = await request(m, {});
    console.log(m, '→', r.error ? `error ${r.error.code}` : 'ok');
  }
}

main()
  .catch((e) => console.log('probe-fail:', e.message))
  .finally(async () => {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(ENGINE_CWD, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WS_DIR, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
