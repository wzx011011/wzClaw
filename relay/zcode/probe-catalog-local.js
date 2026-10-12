// probe-catalog-local.js — 独立 runtime 本地探针：不依赖桌面 App / companion / relay。
// 直接 spawn 本机 zcode.cjs app-server，创建 deferred 会话读取真实模型目录
// （settings.model.available），随后 session/close 释放。不发消息、不产生计费。
// 用法：
//   node probe-catalog-local.js                     # 自动解析本机 runtime
//   ZCODE_BIN=C:\path\to\zcode.cjs node probe-catalog-local.js   # 指定构建
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const hardTimer = setTimeout(() => { console.log('RESULT: 全局超时 60s'); process.exit(1); }, 60000).unref();

// 1. 解析 runtime（与 companion 预检同一套 resolver）
const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') {
  console.log(`RESULT: runtime 未解析（${resolved.category}）`);
  process.exit(1);
}
console.log(`runtime: source=${resolved.source}`);
console.log(`host:    ${resolved.command}`);
console.log(`script:  ${resolved.args.join(' ') || '(PATH CLI)'}`);

// 2. 读桌面登录态（只用于注入子进程环境，不打印）
let token;
try { token = readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')); }
catch (error) { console.log(`RESULT: 登录态不可读（${error.code}）`); process.exit(1); }

// 3. 起隔离 app-server：cwd 用空临时目录，不碰真实工作区
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-catalog-'));
const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: token }),
});
child.on('error', (error) => { console.log(`RESULT: spawn 失败 ${error.code}`); process.exit(1); });
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => { /* 只排空，不外显（可能含配置路径） */ });

// 4. NDJSON 帧 + 反向请求代答（companion 同款语义）
let buf = '';
const pending = new Map();
let nextId = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim(); buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.id != null && pending.has(frame.id)) {
      const settle = pending.get(frame.id); pending.delete(frame.id); settle(frame);
    } else if (frame.method === 'session/requestRuntimePreferences') {
      child.stdin.write(`${JSON.stringify({ id: frame.id, result: { nativeSearchEnhancementsEnabled: false } })}\n`);
    } else if (frame.method) {
      console.log(`[反向请求] ${frame.method}${frame.params?.scope ? ` scope=${frame.params.scope}` : ''}`);
    }
  }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `probe-${++nextId}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时 25s`)); } }, 25000).unref();
    child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
  });
}

(async () => {
  // 5. 创建 deferred 会话（不落库、不进会话列表），读模型目录
  const created = await rpc('session/create', {
    workspace: { workspaceKey: 'probe-catalog', workspacePath: tmp },
    persistence: 'deferred',
    titleGenerationEnabled: false,
    mcpServers: [],
  });
  if (created.error) {
    console.log(`RESULT: session/create 失败 ${created.error.code}: ${String(created.error.message).slice(0, 300)}`);
    process.exit(1);
  }
  const sessionId = created.result?.session?.sessionId;
  const model = created.result?.settings?.model || {};
  const available = Array.isArray(model.available) ? model.available : [];
  console.log(`\n可用目录（settings.model.available，共 ${available.length} 条）:`);
  for (const entry of available) {
    const ref = entry.ref || {};
    const ctx = entry.contextWindow ? ` ctx=${entry.contextWindow}` : '';
    const disabled = entry.disabledReason ? ` [禁用:${entry.disabledReason}]` : '';
    console.log(`  - ${ref.providerId}/${ref.modelId}${ctx}${disabled}`);
  }
  if (model.current) {
    console.log(`当前选中: ${model.current.providerId}/${model.current.modelId}`);
  }
  // 6. 释放 deferred 会话并退场
  if (sessionId) {
    const closed = await rpc('session/close', { sessionId, expectedPersistence: 'deferred' });
    if (closed.error) console.log(`[warn] session/close: ${closed.error.code}`);
  }
  clearTimeout(hardTimer);
  child.kill();
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000).unref(); });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('RESULT: ok');
  process.exit(0);
})().catch((error) => { console.log(`RESULT: ${error.message}`); child.kill(); process.exit(1); });
