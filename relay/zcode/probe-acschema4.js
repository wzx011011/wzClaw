// probe-acschema4.js — 完整 ProviderConfig 形状推送：api + access + group +
// builtinModelIds（API 实时列表），states entitled。成功后 setModel 实测选中。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ac4-'));
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
  const id = `ac4-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(id, resolve);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 25000).unref();
  try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
});
const brief = (r) => r.error
  ? `${r.error.code}: ${String(r.error.message).replace(/\s+/g, ' ').slice(0, 320)}`
  : `OK ${JSON.stringify(r.result).slice(0, 150)}`;

(async () => {
  const res = await fetch('https://open.bigmodel.cn/api/anthropic/v1/models', {
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000),
  });
  const ids = (await res.json()).data.map((m) => m.id).filter(Boolean);
  console.log(`API 模型 (${ids.length}): ${ids.join(', ')}`);

  const mkAccess = (mode) => ({ type: 'zhipu-account', accountType: 'bigmodel', mode, entitled: true });
  const variants = [
    ['mode=individual', { access: mkAccess('individual-coding-plan'), builtinModelIds: ids }],
    ['mode=team', { access: mkAccess('team-coding-plan'), builtinModelIds: ids }],
  ];
  let out = null;
  for (const [name, entry] of variants) {
    const params = {
      revision: `probe-ac4-${name}`,
      basedOnZCodeBuiltinRevision: '28',
      providers: { 'builtin:bigmodel-coding-plan': entry },
      states: { 'builtin:bigmodel-coding-plan': { availability: 'available', entitled: true, current: true } },
    };
    const r = await rpc('provider/updateAccountConfig', params);
    console.log(`[${name}] ${brief(r)}`);
    if (r.error) continue;
    const created = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-ac4', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    const model = created.result && created.result.settings ? created.result.settings.model : {};
    const available = Array.isArray(model.available) ? model.available : [];
    const builtin = available.filter((m) => m.ref && String(m.ref.providerId).startsWith('builtin:'));
    console.log(`   ↳ 目录总数=${available.length}，builtin=${builtin.length}${builtin.length ? '：' + builtin.map((m) => m.ref.modelId).join(', ') : ''}`);
    if (builtin.length) { out = { created, builtin }; break; }
  }

  if (out) {
    const sid = out.created.result.session.sessionId;
    const flash = out.builtin.find((m) => /flash/i.test(m.ref.modelId)) || out.builtin[0];
    const sm = await rpc('session/setModel', { sessionId: sid, model: { providerId: flash.ref.providerId, modelId: flash.ref.modelId } });
    console.log(`[setModel ${flash.ref.modelId}] ${brief(sm)}`);
    // 选中后回读目录确认 current
    const after = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-ac4b', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    const cur = after.result?.settings?.model?.current;
    console.log(`[回读 current] ${cur ? `${cur.providerId}/${cur.modelId}` : JSON.stringify(cur)}`);
  } else {
    console.log('RESULT: 所有变体都未能让 builtin 模型进入目录');
  }
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }, 1500).unref();
})().catch((e) => { console.log(`失败: ${e.message}`); child.kill(); process.exit(1); });
