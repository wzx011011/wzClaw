// probe-0169-readonly.js — 0.16.9 核心链路完整回归 + 只读新方法真调。
// 前置结论（probe-storagestate.js）：代答 runtimePreferences 即可让 create 完整；
// startup/storageState 未答不影响。本脚本按 B 模式代答，走全核心链路并对
// 名字只读的方法按 ZodError 揭示的字段补 workspace/sessionId 真调一次。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const resolved = resolveZcodeRuntime();
const token = readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-0169-'));
const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: token }),
});
let buf = '';
const pending = new Map();
let nextId = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f.id != null && pending.has(f.id)) { const s = pending.get(f.id); pending.delete(f.id); s(f); }
    else if (f.method === 'session/requestRuntimePreferences') {
      child.stdin.write(JSON.stringify({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } }) + '\n');
    } else if (f.method) {
      console.log(`[反向未代答] ${f.method}`);
    }
  }
});
const rpc = (method, params, tmo = 20000) => new Promise((res) => {
  const id = 'p' + (++nextId);
  pending.set(id, res);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __timeout: true }); } }, tmo).unref();
  child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
});
const brief = (v) => JSON.stringify(v).slice(0, 500);

(async () => {
  const ws = { workspaceKey: 'probe-0169', workspacePath: tmp };
  // 1. 核心链路
  const created = await rpc('session/create', { workspace: ws, persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [] });
  if (created.error || created.__timeout) { console.log(`FATAL create: ${brief(created.error || created)}`); process.exit(1); }
  const sessionId = created.result?.session?.sessionId;
  console.log(`[1] create ok  sessionId=${sessionId}`);
  console.log(`    result keys=${Object.keys(created.result).join(',')}`);

  const listed = await rpc('session/list', {});
  console.log(`[2] list ok  sessions=${(listed.result?.sessions || []).length}  首条 keys=${Object.keys(listed.result?.sessions?.[0] || {}).join(',')}`);

  const read = await rpc('session/read', { sessionId });
  console.log(`[3] read ${read.error ? 'err ' + read.error.code : 'ok  keys=' + Object.keys(read.result || {}).join(',')}`);

  const sub = await rpc('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
  console.log(`[4] subscribe ${sub.error ? 'err ' + JSON.stringify(sub.error).slice(0, 200) : 'ok  ' + brief(sub.result)}`);

  const usage = await rpc('session/usage', { sessionId });
  console.log(`[5] usage ${usage.error ? 'err ' + usage.error.code : 'ok  ' + brief(usage.result)}`);

  const goal = await rpc('session/goal', { sessionId });
  console.log(`[6] goal ${goal.error ? 'err ' + goal.error.code : 'ok  ' + brief(goal.result)}`);

  // 2. 只读新方法真调（workspace 参数从各自 ZodError 形状推）
  const workspaceArg = () => ({ workspace: ws });
  const ro = [
    ['runtime/capabilities', {}],
    ['process/childProcesses', {}],
    ['usage/stats', { range: 'all' }],
    ['mcp/list', workspaceArg()],
    ['plugins/list', workspaceArg()],
    ['plugins/overview', workspaceArg()],
    ['plugins/referenceCatalog', workspaceArg()],
    ['plugins/referenceCatalogWithCategory', workspaceArg()],
    ['skills/referenceCatalog', workspaceArg()],
    ['workflows/list', workspaceArg()],
    ['workflows/get', { ...workspaceArg(), id: 'nonexistent-probe' }],
    ['workflows/runs', workspaceArg()],
    ['session/debug', { sessionId }],
    ['session/requestRuntimePreferences', { sessionId }],
  ];
  const roReport = {};
  for (const [method, params] of ro) {
    const r = await rpc(method, params);
    if (r.__timeout) { console.log(`[R] ${method} -> timeout`); roReport[method] = { status: 'timeout' }; continue; }
    if (r.error) {
      console.log(`[R] ${method} -> err ${r.error.code} ${String(r.error.message).slice(0, 180)}`);
      roReport[method] = { status: 'error', code: r.error.code, message: String(r.error.message).slice(0, 400) };
      continue;
    }
    const resultKeys = r.result && typeof r.result === 'object' ? Object.keys(r.result) : [];
    console.log(`[R] ${method} -> ok keys=[${resultKeys.join(',')}]`);
    console.log(`    ${brief(r.result)}`);
    roReport[method] = { status: 'ok', result: r.result };
  }

  // 3. 收尾 close
  const closed = await rpc('session/close', { sessionId, expectedPersistence: 'deferred' });
  console.log(`[7] close ${closed.error ? 'err ' + closed.error.code : 'ok  ' + brief(closed.result)}`);

  fs.writeFileSync(path.join(__dirname, 'probe-0169-readonly-report.json'), JSON.stringify({ roReport }, null, 1));
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }, 1500).unref();
})().catch((e) => { console.log('FATAL ' + (e.stack || e)); child.kill(); process.exit(1); });
