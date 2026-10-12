// probe-acschema2.js — 迭代钉死 provider/updateAccountConfig 内层 schema，
// 并当场验证：推送后 session/create 目录里是否出现 builtin 套餐模型。
// 载荷素材全部来自本机 ~/.zcode/v2/config.json 的物化数据（不打印 key）。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const home = os.homedir();
const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') { console.log('runtime 未解析'); process.exit(1); }
let token;
try { token = readModelAuth(path.join(home, '.zcode/v2/config.json')); }
catch (error) { console.log(`登录态不可读 ${error.code}`); process.exit(1); }
const v2 = JSON.parse(fs.readFileSync(path.join(home, '.zcode/v2/config.json'), 'utf8'));
const v2Entry = v2.provider['builtin:bigmodel-coding-plan'];
const modelIds = Object.keys(v2Entry.models || {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ac2-'));
const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: token }),
});
let buf = ''; const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk; let index;
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim(); buf = buf.slice(index + 1);
    if (!line) continue;
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.id != null && pending.has(frame.id)) { const s = pending.get(frame.id); pending.delete(frame.id); s(frame); }
    else if (frame.method === 'session/requestRuntimePreferences') {
      try { child.stdin.write(`${JSON.stringify({ id: frame.id, result: { nativeSearchEnhancementsEnabled: false } })}\n`); } catch { /* 退出 */ }
    } else if (frame.method === 'startup/storageState') {
      console.log(`[反向请求] startup/storageState（不代答，观察是否阻塞）`);
    }
  }
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = `ac2-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(id, resolve);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 20000).unref();
  try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
});
const brief = (r) => r.error
  ? `${r.error.code}: ${String(r.error.message).replace(/\s+/g, ' ').slice(0, 260)}`
  : `OK ${JSON.stringify(r.result).slice(0, 120)}`;

(async () => {
  const ladder = [
    ['最小合法类型', { revision: 'probe-1', basedOnZCodeBuiltinRevision: '28', providers: {}, states: {} }],
    ['providers 空条目', { revision: 'probe-2', basedOnZCodeBuiltinRevision: '28', providers: { 'builtin:bigmodel-coding-plan': {} }, states: {} }],
    ['providers 带 models 空对象', { revision: 'probe-3', basedOnZCodeBuiltinRevision: '28', providers: { 'builtin:bigmodel-coding-plan': { models: {} } }, states: {} }],
    ['providers 带真实 models 结构', { revision: 'probe-4', basedOnZCodeBuiltinRevision: '28', providers: { 'builtin:bigmodel-coding-plan': { models: JSON.parse(JSON.stringify(v2Entry.models)) } }, states: {} }],
  ];
  for (const [name, params] of ladder) {
    const r = await rpc('provider/updateAccountConfig', params);
    console.log(`[${name}] ${brief(r)}`);
    if (r.error) continue;
    // 每次成功都验证目录（后面的成功覆盖前面的）
    const created = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-ac2', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    const model = created.result && created.result.settings ? created.result.settings.model : {};
    const available = Array.isArray(model.available) ? model.available : [];
    const builtin = available.filter((m) => m.ref && String(m.ref.providerId).startsWith('builtin:'));
    console.log(`   ↳ 目录总数=${available.length}，builtin=${builtin.length}${builtin.length ? '：' + builtin.map((m) => m.ref.modelId).join(', ') : ''}`);
  }
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }, 1500).unref();
})();
