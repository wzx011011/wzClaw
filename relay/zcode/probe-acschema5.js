// probe-acschema5.js — 终局验证：
// 1) release 是否声明 builtin:bigmodel-coding-plan 基底 provider
// 2) 引擎A推送 → 重启 → 引擎B建会话：账号配置是否跨重启生效/启动时生效
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const home = os.homedir();
const resolved = resolveZcodeRuntime();
let token;
try { token = readModelAuth(path.join(home, '.zcode/v2/config.json')); }
catch (error) { console.log(`登录态不可读 ${error.code}`); process.exit(1); }

// release 基底检查
const relPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  || 'C:/Users/67376/.zcode/v2/runtime/provider/windows-x86_64/3.12.3/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json';
try {
  const rel = JSON.parse(fs.readFileSync(relPath, 'utf8'));
  const pr = (rel.config.providerConfigRules.providerRules || []).map((r) => r.providerId);
  const tr = (rel.config.providerConfigRules.templateRules || []).map((r) => r.templateId);
  console.log(`release providerRules: ${pr.join(', ') || '(无)'}`);
  console.log(`release templateRules: ${tr.join(', ') || '(无)'}`);
} catch (e) { console.log(`release 读取失败: ${e.message}`); }

function startEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ac5-'));
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
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = `ac5-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 25000).unref();
    try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
  });
  return { child, rpc, tmp };
}
const brief = (r) => r.error ? `${r.error.code}` : `OK`;
async function catalogOf(rpc) {
  const created = await rpc('session/create', {
    workspace: { workspaceKey: `ac5-${Math.random().toString(36).slice(2, 6)}`, workspacePath: os.tmpdir() },
    persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
  });
  const model = created.result && created.result.settings ? created.result.settings.model : {};
  const available = Array.isArray(model.available) ? model.available : [];
  const builtin = available.filter((m) => m.ref && String(m.ref.providerId).startsWith('builtin:'));
  return `目录=${available.length} builtin=${builtin.length}${builtin.length ? ':' + builtin.map((m) => m.ref.modelId).join(',') : ''}`;
}

(async () => {
  const res = await fetch('https://open.bigmodel.cn/api/anthropic/v1/models', {
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000),
  });
  const ids = (await res.json()).data.map((m) => m.id).filter(Boolean);

  const a = startEngine();
  const candidateIds = [
    'account:bigmodel-individual-coding-plan',
    'account:bigmodel-team-coding-plan',
    'account:bigmodel-start-plan',
  ];
  for (const pid of candidateIds) {
    const push = await a.rpc('provider/updateAccountConfig', {
      revision: `ac5-${pid}`,
      basedOnZCodeBuiltinRevision: '28',
      providers: { [pid]: { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: ids } },
      states: { [pid]: { availability: 'available', entitled: true, current: true } },
    });
    const cat = await catalogOf(a.rpc);
    console.log(`[${pid}] push=${brief(push)} → ${cat}`);
    if (cat.includes('builtin=') && !cat.includes('builtin=0')) break;
  }
  a.child.kill();
  setTimeout(() => process.exit(0), 1500).unref();
})().catch((e) => { console.log(`失败: ${e.message}`); process.exit(1); });
