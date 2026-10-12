// probe-personal-plan.js — 终极方案验证：在个人 provider 配置副本中追加
// builtin:bigmodel-coding-plan 条目（personalModelIds=API 实时列表，
// access=zhipu-coding-plan-api-key），以 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
// 指向副本起隔离引擎，验证目录物化 + setModel 可选中。
// 纪律：token/原始配置不打印；不改真实个人配置文件。
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

(async () => {
  // 1. API 实时模型列表
  const res = await fetch('https://open.bigmodel.cn/api/anthropic/v1/models', {
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000),
  });
  const ids = (await res.json()).data.map((m) => m.id).filter(Boolean);
  console.log(`API 模型 (${ids.length}): ${ids.join(', ')}`);

  let child = null;
  let buf = '';
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve) => {
    const id = `pp-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 25000).unref();
    try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
  });
  const brief = (r) => r.error
    ? `${r.error.code}: ${String(r.error.message).replace(/\s+/g, ' ').slice(0, 300)}`
    : `OK`;

  // 3. 三个变体逐一测试（每个都要重启引擎）
  const srcPath = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  if (!srcPath) { console.log('无 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'); process.exit(1); }
  const variants = [
    ['克隆-仅改id', 'custom:bigmodel-plan', null],
    ['克隆-换API模型', 'custom:bigmodel-plan2', null],
    ['克隆-换套餐key', 'custom:bigmodel-plan3', null],
  ];
  for (const [name, PROVIDER_ID, access] of variants) {
    const overlay = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    overlay.config = overlay.config && typeof overlay.config === 'object' ? overlay.config : {};
    const pcr = overlay.config.providerConfigRules = overlay.config.providerConfigRules && typeof overlay.config.providerConfigRules === 'object'
      ? overlay.config.providerConfigRules : {};
    pcr.providerRules = Array.isArray(pcr.providerRules) ? pcr.providerRules : [];
    let entry;
    if (access === null) {
      // 克隆 imported:claude 整条规则；三个变体逐步换血定位差异
      const src = pcr.providerRules.find((r) => r.providerId === 'imported:claude:1e90246348f6');
      entry = JSON.parse(JSON.stringify(src));
      entry.providerId = PROVIDER_ID;
      if (/2$/.test(PROVIDER_ID) || /3$/.test(PROVIDER_ID)) {
        entry.config.personalModelIds = [...ids];
        entry.config.modelOrder = [...ids];
      }
      if (/3$/.test(PROVIDER_ID)) {
        entry.config.access = { type: 'zhipu-coding-plan-api-key', apiKey: token };
      }
    } else {
      entry = {
        providerId: PROVIDER_ID,
        enabled: true,
        config: {
          group: 'standard-personal',
          personalModelIds: ids,
          modelOrder: ids,
          access,
        },
      };
    }
    pcr.providerRules = pcr.providerRules.filter((r) => r.providerId !== PROVIDER_ID);
    pcr.providerRules.push(entry);
    // 模型定义条目（克隆体用 claude 自己的；新构造用 API id）
    const mcr = overlay.config.modelConfigRules = overlay.config.modelConfigRules && typeof overlay.config.modelConfigRules === 'object'
      ? overlay.config.modelConfigRules : {};
    mcr.providerModelRules = Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : [];
    mcr.providerModelRules = mcr.providerModelRules.filter((r) => r.providerId !== PROVIDER_ID);
    const modelIds = (entry.config.personalModelIds || []);
    for (const mid of modelIds) {
      mcr.providerModelRules.push({ providerId: PROVIDER_ID, modelId: mid, config: { properties: {} } });
    }
    const overlayPath = path.join(os.tmpdir(), `zcode-personal-plan-${process.pid}.json`);
    fs.writeFileSync(overlayPath, JSON.stringify(overlay));
    if (child) child.kill();
    await new Promise((r) => setTimeout(r, 800));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-pp-'));
    child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
      cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: runtimeProcessEnv(resolved, {
        ...process.env, ANTHROPIC_API_KEY: token,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: overlayPath,
      }),
    });
    buf = ''; pending.clear();
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
    await new Promise((r) => setTimeout(r, 5000));
    const cr = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-pp', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    if (cr.error) { console.log(`[${name}] session/create ${brief(cr)}`); continue; }
    const model = cr.result.settings ? cr.result.settings.model : {};
    const available = Array.isArray(model.available) ? model.available : [];
    const mine = available.filter((m) => m.ref && m.ref.providerId === PROVIDER_ID);
    console.log(`[${name}] 目录总数=${available.length}，本 provider=${mine.length}${mine.length ? '：' + mine.map((m) => m.ref.modelId).join(', ') : ''}`);
    if (mine.length) {
      const sid = cr.result.session.sessionId;
      const flash = mine.find((m) => /flash/i.test(m.ref.modelId)) || mine[0];
      console.log(`   [flash 条目] ${JSON.stringify(flash).slice(0, 400)}`);
      let sm = await rpc('session/setModel', { sessionId: sid, model: { providerId: flash.ref.providerId, modelId: flash.ref.modelId, options: { reasoningLevel: 'high' } } });
      if (sm.error && sm.error.code === -32602) {
        sm = await rpc('session/setModel', { sessionId: sid, model: { providerId: flash.ref.providerId, modelId: flash.ref.modelId }, reasoningLevel: 'high' });
      }
      console.log(`   [setModel ${flash.ref.modelId}] ${brief(sm)}`);
      if (!sm.error) {
        const after = await rpc('session/create', {
          workspace: { workspaceKey: `probe-pp-after-${Math.random().toString(36).slice(2, 6)}`, workspacePath: tmp },
          persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
        });
        const cur = after.result?.settings?.model?.current;
        console.log(`   [新会话 current] ${cur ? `${cur.providerId}/${cur.modelId}` : '无'}`);
        break;
      }
    }
  }
  child.kill();
  setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(overlayPath, { force: true }); process.exit(0); }, 1500).unref();
})().catch((e) => { console.log(`失败: ${e.message}`); process.exit(1); });
