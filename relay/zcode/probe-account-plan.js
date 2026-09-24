// probe-account-plan.js — 钉死「account: 固定 provider 能否在独立引擎服务」。
// 【结论（2026-09-24，引擎 0.16.9 实测）】：不可服务——
//   1. 个人配置里的 account:bigmodel-individual-coding-plan 规则（带/不带
//      group+api、大写 GLM-5.3* 或小写 glm-5.3*）均被引擎接受（同文件里的
//      custom: 对照 provider 照常物化，整份配置不拒），但 settings.model.
//      available 里 account: 条目恒为 0；
//   2. session/setModel 直指 account:/{GLM-5.3,glm-5.3} 均 -32603
//      「Provider Registry 中不存在 Model」——引擎压根没把 account: provider
//      注册进 registry（与 2026-09-18「provider/updateAccountConfig 对独立
//      引擎不物化，桌面专用路径」的实测互证）；
//   3. env 直指真机桌面 provider_config.json（恒等测试）同样 0 条 account
//      模型——排除了 fixture 形状因素。
// 因此 companion 套餐注入保留 custom: + access 内联路径（token 落盘问题
// 需另行方案，见 U4 批次记录），本探针入库作回归锚 + 结论证据。
// 夹具坑（本探针踩出，provisioning schema .strict()）：个人配置副本的
// modelConfigRules 缺 manualProviderModelRules 字段 → 目录整体归零
// （连合法 custom: provider 也不物化）。构造最小 fixture 必须带全。
// 判定标准（U4 任务书）：配置不被拒 + available 出现对应模型；setModel
// 成功作加强信号。token/原始配置不打印。
// 用法：node probe-account-plan.js
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const ACCOUNT_PROVIDER_ID = 'account:bigmodel-individual-coding-plan';
// 对照 provider 用 custom: 前缀（唯一经生产证实可凭空构造的前缀）
const CONTROL_PROVIDER_ID = 'custom:probe-seam-control';
const PLAN_API = { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' };
const UPPER = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flashx'];
const LOWER = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'];

const home = os.homedir();
const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') { console.log('runtime 未解析'); process.exit(1); }
let token;
try { token = readModelAuth(path.join(home, '.zcode/v2/config.json')); }
catch (error) { console.log(`登录态不可读 ${error.code}`); process.exit(1); }

// 最小 fixture：一条带 access 的 imported 对照 provider（整份配置被拒时它会
// 一起消失——对照信号）+ 空模型规则区。形状逐项照抄真机桌面物化的
// imported 规则（group/access/api/personalModelIds/modelOrder）。
// 不读真机 provider_config.json。
const BASE_FIXTURE = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [
      { providerId: CONTROL_PROVIDER_ID, providerName: 'ProbeControl',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'probe-control-key' },
            api: { ...PLAN_API },
            personalModelIds: ['probe-control-model'], modelOrder: ['probe-control-model'],
          } },
    ] },
    modelConfigRules: { providerModelRules: [
      { providerId: CONTROL_PROVIDER_ID, modelId: 'probe-control-model',
        config: { properties: {} } },
    ], manualProviderModelRules: [] },
  },
});

// 追加 account: 规则。withApi=false 时用桌面同款形状（无 group/api，
// 仅 personalModelIds/modelOrder——真机桌面物化形状实测如此）。
function buildOverlay(modelIds, { withApi }) {
  const overlay = JSON.parse(BASE_FIXTURE);
  if (modelIds) {
    const config = {
      personalModelIds: [...modelIds],
      modelOrder: [...modelIds],
    };
    if (withApi) {
      config.group = 'standard-personal';
      config.api = { ...PLAN_API };
    }
    // account: 固定 provider 禁带 access（superRefine 硬约束，违规整份被拒）
    overlay.config.providerConfigRules.providerRules.push({ providerId: ACCOUNT_PROVIDER_ID, config });
    for (const modelId of modelIds) {
      overlay.config.modelConfigRules.providerModelRules.push(
        { providerId: ACCOUNT_PROVIDER_ID, modelId, config: { properties: {} } });
    }
  }
  return overlay;
}

(async () => {
  const variants = [
    ['基线-仅对照provider(无account规则)', null, {}],
    [`大写+api(${UPPER.join('/')})`, UPPER, { withApi: true }],
    [`大写-桌面形状(${UPPER.join('/')})`, UPPER, { withApi: false }],
    [`小写+api(${LOWER.join('/')})`, LOWER, { withApi: true }],
  ];
  let child = null;
  const tmpDirs = [];
  const overlayPaths = [];
  for (const [name, modelIds, opts] of variants) {
    const overlayPath = path.join(os.tmpdir(), `zcode-account-plan-${process.pid}-${overlayPaths.length}.json`);
    fs.writeFileSync(overlayPath, JSON.stringify(buildOverlay(modelIds, opts)));
    overlayPaths.push(overlayPath);
    if (child) child.kill();
    await new Promise((r) => setTimeout(r, 800));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ap-'));
    tmpDirs.push(tmp);
    child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
      cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: runtimeProcessEnv(resolved, {
        ...process.env, ANTHROPIC_API_KEY: token,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: overlayPath,
      }),
    });
    let buf = '';
    const pending = new Map();
    const stderrTail = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) stderrTail.push(line.trim());
        if (stderrTail.length > 12) stderrTail.shift();
      }
    });
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
      const id = `ap-${Math.random().toString(36).slice(2, 8)}`;
      pending.set(id, resolve);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, 25000).unref();
      try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { resolve({ error: { code: 'WRITE' } }); }
    });

    await new Promise((r) => setTimeout(r, 5000));
    const cr = await rpc('session/create', {
      workspace: { workspaceKey: 'probe-ap', workspacePath: tmp },
      persistence: 'deferred', titleGenerationEnabled: false, mcpServers: [],
    });
    if (cr.error) {
      console.log(`[${name}] session/create 失败 ${cr.error.code}: ${String(cr.error.message).replace(/\s+/g, ' ').slice(0, 200)}`);
      if (stderrTail.length) console.log(`   [stderr 尾部] ${stderrTail.slice(-4).join(' | ').slice(0, 500)}`);
      continue;
    }
    const available = Array.isArray(cr.result.settings?.model?.available) ? cr.result.settings.model.available : [];
    const mine = available.filter((m) => m.ref && m.ref.providerId === ACCOUNT_PROVIDER_ID);
    const control = available.filter((m) => m.ref && m.ref.providerId === CONTROL_PROVIDER_ID);
    const expected = new Set((modelIds || []).map((s) => s.toLowerCase()));
    const hit = mine.filter((m) => expected.has(String(m.ref.modelId).toLowerCase()))
      .map((m) => m.ref.modelId);
    console.log(`[${name}] 目录总数=${available.length} 对照provider=${control.length ? '在(配置未被拒)' : '消失(整份被拒!)'}`
      + ` account条目=${mine.length ? mine.map((m) => m.ref.modelId).join(', ') : '无'}`
      + ` 命中期望=${hit.length ? hit.join(', ') : '无'}`);
    if (mine.length) {
      const sid = cr.result.session.sessionId;
      const first = mine[0];
      let sm = await rpc('session/setModel', { sessionId: sid,
        model: { providerId: first.ref.providerId, modelId: first.ref.modelId, options: { reasoningLevel: 'high' } } });
      if (sm.error && sm.error.code === -32602) {
        sm = await rpc('session/setModel', { sessionId: sid,
          model: { providerId: first.ref.providerId, modelId: first.ref.modelId }, reasoningLevel: 'high' });
      }
      console.log(`   [setModel ${first.ref.modelId}] ${sm.error ? `${sm.error.code}: ${String(sm.error.message).replace(/\s+/g, ' ').slice(0, 200)}` : 'OK（可选中）'}`);
    }
    if (!available.length || (!mine.length && modelIds)) {
      if (stderrTail.length) console.log(`   [stderr 尾部] ${stderrTail.slice(-4).join(' | ').slice(0, 500)}`);
    }
  }
  if (child) child.kill();
  // Windows：引擎子进程持 cwd 锁，必须先 kill 后清理（现有测试 :282-288 惯例）
  setTimeout(() => {
    for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 退出即释 */ } }
    for (const p of overlayPaths) { try { fs.rmSync(p, { force: true }); } catch { /* 同上 */ } }
    process.exit(0);
  }, 1500).unref();
})().catch((e) => { console.log(`失败: ${e.message}`); process.exit(1); });
