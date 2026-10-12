// probe-plan-models.js — 两条路验证套餐模型如何进入独立 runtime 目录。
// A) 用 key 调服务端模型列表 API（anthropic 兼容 + paas v4 两个端点都试）；
// B) 把 v2 config 已物化的 models 塞进个人 provider 配置副本，
//    用 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 指向副本起隔离引擎，看目录。
// 纪律：token/文件内容不打印，只打印模型 ID 与状态。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const home = os.homedir();
let token;
try { token = readModelAuth(path.join(home, '.zcode/v2/config.json')); }
catch (error) { console.log(`登录态不可读 ${error.code}`); process.exit(1); }

// ---- A) API 直查 ----
async function tryApi(name, url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let ids = [];
    try {
      const json = JSON.parse(text);
      const arr = json.data || json.models || [];
      ids = arr.map((m) => m.id || m.model || m.name).filter(Boolean);
      if (!ids.length) ids = [`(无列表) keys=${Object.keys(json).join(',')}`];
    } catch { ids = [`(非JSON ${res.status}) ${text.slice(0, 80)}`]; }
    console.log(`[${name}] http=${res.status} 模型数=${ids.length}`);
    for (const id of ids.slice(0, 30)) console.log(`   ${id}`);
  } catch (e) { console.log(`[${name}] 失败: ${e.message}`); }
}
(async () => {
  await tryApi('anthropic兼容 /v1/models', 'https://open.bigmodel.cn/api/anthropic/v1/models',
    { 'x-api-key': token, 'anthropic-version': '2023-06-01' });
  await tryApi('paas v4 /models', 'https://open.bigmodel.cn/api/paas/v4/models',
    { Authorization: `Bearer ${token}` });
})();

// ---- B) 个人配置物化 → 独立引擎目录 ----
const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') { console.log('runtime 未解析'); process.exit(1); }
const srcPath = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  || path.join(home, '.zcode/cli/config.json');
try {
  const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(path.join(home, '.zcode/v2/config.json'), 'utf8'));
  const v2Entry = v2.provider && v2.provider['builtin:bigmodel-coding-plan'];
  const test = JSON.parse(JSON.stringify(src));
  test.provider = test.provider && typeof test.provider === 'object' ? test.provider : {};
  const entry = test.provider['builtin:bigmodel-coding-plan'] && typeof test.provider['builtin:bigmodel-coding-plan'] === 'object'
    ? test.provider['builtin:bigmodel-coding-plan'] : {};
  entry.kind = entry.kind || 'anthropic';
  entry.models = v2Entry && v2Entry.models ? JSON.parse(JSON.stringify(v2Entry.models)) : {};
  test.provider['builtin:bigmodel-coding-plan'] = entry;
  const testPath = path.join(os.tmpdir(), `zcode-personal-test-${process.pid}.json`);
  fs.writeFileSync(testPath, JSON.stringify(test));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-planb-'));
  const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
    cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: runtimeProcessEnv(resolved, {
      ...process.env,
      ANTHROPIC_API_KEY: token,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: testPath,
    }),
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
      else if (frame.method === 'session/requestRuntimePreferences' || frame.method === 'startup/storageState') {
        try { child.stdin.write(`${JSON.stringify({ id: frame.id, error: { code: -32022, message: 'probe' } })}\n`); } catch { /* 退出 */ }
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = `pb-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 20000).unref();
    try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
  });
  setTimeout(async () => {
    const created = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-planb', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    const model = created.result && created.result.settings ? created.result.settings.model : {};
    const available = Array.isArray(model.available) ? model.available : [];
    const builtin = available.filter((m) => m.ref && String(m.ref.providerId).startsWith('builtin:'));
    console.log(`\n[B方案] 目录总数=${available.length}，其中 builtin=${builtin.length}`);
    for (const m of builtin) console.log(`   ${m.ref.providerId}/${m.ref.modelId}`);
    child.kill();
    setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(testPath, { force: true }); process.exit(0); }, 1500).unref();
  }, 6000).unref();
} catch (error) { console.log(`[B方案] 失败: ${error.message}`); process.exit(1); }
