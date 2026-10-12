// probe-acschema3.js — 决定性实验：API 拉套餐模型列表 → provider/updateAccountConfig
// 推送 builtinModelIds + entitled → 验证目录出现 builtin 模型 → setModel 实测可选中。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ac3-'));
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
  const id = `ac3-${Math.random().toString(36).slice(2, 8)}`;
  pending.set(id, resolve);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 25000).unref();
  try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
});
const brief = (r) => r.error
  ? `${r.error.code}: ${String(r.error.message).replace(/\s+/g, ' ').slice(0, 300)}`
  : `OK ${JSON.stringify(r.result).slice(0, 150)}`;

(async () => {
  // 1. API 拉实时套餐列表
  const res = await fetch('https://open.bigmodel.cn/api/anthropic/v1/models', {
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000),
  });
  const list = (await res.json()).data.map((m) => m.id).filter(Boolean);
  console.log(`API 模型列表 (${list.length}): ${list.join(', ')}`);

  async function checkCatalog(tag) {
    const created = await rpc('session/create', {
      workspace: { workspaceKey: `probe-ac3-${tag}`, workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    const model = created.result && created.result.settings ? created.result.settings.model : {};
    const available = Array.isArray(model.available) ? model.available : [];
    const builtin = available.filter((m) => m.ref && String(m.ref.providerId).startsWith('builtin:'));
    console.log(`   [${tag}] 目录总数=${available.length}，builtin=${builtin.length}${builtin.length ? '：' + builtin.map((m) => m.ref.modelId).join(', ') : ''}`);
    return { created, builtin, available };
  }

  // 2. 推送账号配置（小写 API id）
  const payload = (ids) => ({
    revision: `probe-ac3-${ids.length}`,
    basedOnZCodeBuiltinRevision: '28',
    providers: { 'builtin:bigmodel-coding-plan': { builtinModelIds: ids } },
    states: { 'builtin:bigmodel-coding-plan': { availability: 'available', entitled: true } },
  });
  let r = await rpc('provider/updateAccountConfig', payload(list));
  console.log(`[推送 小写 id] ${brief(r)}`);
  let out = await checkCatalog('小写');
  let flash = out.builtin.find((m) => /flash/i.test(m.ref.modelId));

  // 3. 若小写没生效，试发布配置的大写形态
  if (!flash) {
    r = await rpc('provider/updateAccountConfig', payload(['GLM-5.3', 'GLM-5.3-Flash']));
    console.log(`[推送 大写 id] ${brief(r)}`);
    out = await checkCatalog('大写');
    flash = out.builtin.find((m) => /flash/i.test(m.ref.modelId));
  }

  // 4. setModel 实测能否选中 flash
  if (out.created.result && out.created.result.session) {
    const sid = out.created.result.session.sessionId;
    const target = flash ? `${flash.ref.providerId}/${flash.ref.modelId}` : 'builtin:bigmodel-coding-plan/glm-5.3-flash';
    const sm = await rpc('session/setModel', { model: target });
    console.log(`[setModel ${target}] ${brief(sm)}`);
    if (sm.error && String(sm.error.code) === '-32602') {
      const sm2 = await rpc('session/setModel', { modelId: flash ? flash.ref.modelId : 'glm-5.3-flash', providerId: 'builtin:bigmodel-coding-plan' });
      console.log(`[setModel 对象形] ${brief(sm2)}`);
    }
  }
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }, 1500).unref();
})().catch((e) => { console.log(`失败: ${e.message}`); child.kill(); process.exit(1); });
