// probe-surface-0169.js — zcode 0.16.9 全量接口面探测（一次跑完核心链路回归 + 70 方法 schema 发现）。
// 方法全集来自对 zcode.cjs 内 RPC 注册表常量对象的静态提取（probe 时 0.16.9）。
// 策略（沿用 probe-methods.js 既定方法论）：
//   A. 核心链路回归：隔离 app-server 上 session/create → list → read → close，
//      验证升级后 runtime 与既有契约仍然生效。
//   B. 全量空参数 {} 探测：有必填字段时回 -32602 ZodError（完整字段路径与类型），
//      零副作用拿 schema；对名字上只读的方法（*/list、*/read、usage/stats 等）
//      允许按 ZodError 揭示的字段补 sessionId 真调一次。
//   C. 变更型方法（create/update/delete/install/reset/set…）只做 schema 探测，
//      绝不真调。防 plugins/resetConfig 这类可能接受空参数的方法误伤用户配置：
//      探测前备份 ~/.zcode/config.json，结束后比对，漂移即恢复并报告。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveZcodeRuntime, runtimeProcessEnv, readModelAuth } = require('./companion');

const ZCODE_CJS = 'C:/Users/67376/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs';

// 0.16.9 RPC 注册表（静态提取自 zcode.cjs `va` 常量对象，2026-09-19）
const METHODS = [
  'automation/checkTaskBinding', 'automation/create', 'automation/delete', 'automation/list', 'automation/update',
  'computer-use/operation-event',
  'interaction/browserExecute', 'interaction/browserList', 'interaction/requestOfficialMcpAuthHeaders',
  'interaction/requestPermission', 'interaction/requestProviderRuntimeHeaders', 'interaction/requestUserInput',
  'mcp/list',
  'offPeak/create', 'offPeak/list',
  'plugins/cancelOperation', 'plugins/configure', 'plugins/describe', 'plugins/install', 'plugins/list',
  'plugins/overview', 'plugins/referenceCatalog', 'plugins/referenceCatalogWithCategory', 'plugins/resetConfig',
  'plugins/resolveSuggestedReference', 'plugins/restoreBuiltin', 'plugins/setEnabled', 'plugins/uninstall',
  'plugins/update', 'plugins/validate',
  'process/childProcesses',
  'provider/testModelConnectivity', 'provider/updateAccountConfig',
  'runtime/capabilities',
  'session/cancelBackgroundTask', 'session/close', 'session/compact', 'session/create', 'session/debug',
  'session/events', 'session/fork', 'session/goal', 'session/list', 'session/messages', 'session/read',
  'session/requestRuntimePreferences', 'session/resume', 'session/send', 'session/setMode', 'session/setModel',
  'session/setThoughtLevel', 'session/stop', 'session/subagents', 'session/subscribe', 'session/usage',
  'skills/referenceCatalog',
  'usage/stats',
  'workflows/delete', 'workflows/get', 'workflows/list', 'workflows/move', 'workflows/runs', 'workflows/updateMeta',
  'workspace/cancelGenerateText', 'workspace/generateText', 'workspace/readPresentation',
  'workspace/updateDynamicWorkflowPolicy', 'workspace/updateInteractionPreferences',
  'workspace/updateModelIoPreferences', 'workspace/updateOffPeakToolPolicy',
];
// 名字上只读、允许真调一次的方法（补 sessionId 等已知安全参数）
const READ_ONLY = new Set([
  'automation/list', 'interaction/browserList', 'mcp/list', 'offPeak/list',
  'plugins/list', 'plugins/overview', 'plugins/referenceCatalog', 'plugins/referenceCatalogWithCategory',
  'process/childProcesses', 'runtime/capabilities',
  'session/goal', 'session/list', 'session/messages', 'session/read', 'session/subagents', 'session/usage',
  'skills/referenceCatalog', 'usage/stats',
  'workflows/get', 'workflows/list', 'workflows/runs',
]);
// 明确变更型（哪怕 {} 有 result 也只记录为红旗，不重复调用）
const MUTATING = new Set(METHODS.filter((m) => !READ_ONLY.has(m)));

const hardTimer = setTimeout(() => { console.log('RESULT: 全局超时 900s'); process.exit(1); }, 900000).unref();

// 1. 解析 runtime（与 companion 预检同一套 resolver）
const resolved = resolveZcodeRuntime();
if (resolved.category !== 'resolved') {
  console.log(`RESULT: runtime 未解析（${resolved.category}）`);
  process.exit(1);
}
console.log(`runtime: source=${resolved.source} command=${resolved.command} ${resolved.args.join(' ')}`);

// 2. 备份用户级 config.json（plugins/setEnabled、resetConfig 等的漂移防护）
const userConfig = path.join(os.homedir(), '.zcode', 'config.json');
const configBackup = fs.existsSync(userConfig) ? fs.readFileSync(userConfig, 'utf8') : null;

// 3. 隔离 app-server
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-surface-'));
let token = null;
try { token = readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')); } catch { /* 匿名也能探 schema */ }
const child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', tmp], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  env: runtimeProcessEnv(resolved, token ? { ...process.env, ANTHROPIC_API_KEY: token } : { ...process.env }),
});
child.on('error', (error) => { console.log(`RESULT: spawn 失败 ${error.code}`); process.exit(1); });
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => { /* 只排空 */ });

let buf = '';
const pending = new Map();
let nextId = 0;
const reverseSeen = new Set();
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
    } else if (frame.method) {
      // 反向请求：只记录不代答（本轮不构造任何会话活动，理论上不应出现）
      reverseSeen.add(frame.method);
    }
  }
});
function rpc(method, params, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const id = `probe-${++nextId}`;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, timeoutMs).unref();
    child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
  });
}
// 从 -32602 ZodError 里抽取「顶层必填字段 + 期望类型」摘要
function zodSummary(error) {
  const issues = error?.data?.issues || error?.data;
  if (!Array.isArray(issues)) return String(JSON.stringify(error?.data ?? error?.message ?? error)).slice(0, 400);
  return issues.map((i) => {
    const p = Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? '');
    return `${p || '(root)'}: ${i.message}`;
  }).join('; ').slice(0, 500);
}

(async () => {
  const report = { version: null, coreChain: {}, surface: {}, reverseRequests: [] };

  // ---- A. 核心链路回归 ----
  const created = await rpc('session/create', {
    workspace: { workspaceKey: 'probe-surface', workspacePath: tmp },
    persistence: 'deferred',
    titleGenerationEnabled: false,
    mcpServers: [],
  });
  if (created.error) {
    console.log(`RESULT: session/create 失败 ${created.error.code}: ${String(created.error.message).slice(0, 300)}`);
    process.exit(1);
  }
  const sessionId = created.result?.session?.sessionId;
  const modelCount = (created.result?.settings?.model?.available || []).length;
  report.coreChain = {
    sessionCreate: 'ok',
    sessionId: Boolean(sessionId),
    modelCatalogSize: modelCount,
    list: null, read: null, close: null,
  };
  console.log(`[A] session/create ok sessionId=${sessionId ? 'yes' : 'NO'} 模型目录=${modelCount}`);

  const listed = await rpc('session/list', {});
  report.coreChain.list = listed.error ? `err ${listed.error.code}` : `ok sessions=${(listed.result?.sessions || []).length}`;
  console.log(`[A] session/list -> ${report.coreChain.list}`);

  const read = await rpc('session/read', { sessionId });
  report.coreChain.read = read.error ? `err ${read.error.code}` : `ok keys=${Object.keys(read.result || {}).join(',')}`;
  console.log(`[A] session/read -> ${report.coreChain.read}`);

  // ---- B. 全量空参数 schema 探测 ----
  for (const method of METHODS) {
    const r = await rpc(method, {});
    let entry;
    if (r.__timeout) {
      entry = { status: 'timeout' };
    } else if (r.error) {
      entry = {
        status: 'zod',
        code: r.error.code,
        schema: zodSummary(r.error),
      };
      // 空参数被受理（非校验错误）——变更型方法在这里是红旗
      if (r.error.code !== -32602) entry.status = 'empty-params-error';
    } else {
      entry = { status: 'ok-empty', result: JSON.stringify(r.result).slice(0, 800) };
    }
    // 只读方法且空参数被拒：按 ZodError 提示补 sessionId 重试一次
    if (READ_ONLY.has(method) && entry.status === 'zod' && sessionId && entry.schema.includes('sessionId')) {
      const r2 = await rpc(method, { sessionId });
      if (!r2.__timeout && !r2.error) {
        entry = { status: 'ok-with-session', result: JSON.stringify(r2.result).slice(0, 1200) };
      } else if (!r2.__timeout && r2.error) {
        entry.retrySchema = zodSummary(r2.error);
      }
    }
    report.surface[method] = entry;
    const tag = entry.status === 'zod' ? `zod ${entry.code}` : entry.status;
    console.log(`[B] ${method} -> ${tag}${entry.schema ? ` | ${entry.schema.slice(0, 160)}` : ''}`);
  }

  // ---- A 收尾：close + 配置漂移校验 ----
  const closed = await rpc('session/close', { sessionId, expectedPersistence: 'deferred' });
  report.coreChain.close = closed.error ? `err ${closed.error.code}` : 'ok';
  console.log(`[A] session/close -> ${report.coreChain.close}`);

  report.reverseRequests = [...reverseSeen];
  if (report.reverseRequests.length) console.log(`[!] 意外反向请求: ${report.reverseRequests.join(', ')}`);

  const configNow = fs.existsSync(userConfig) ? fs.readFileSync(userConfig, 'utf8') : null;
  if (configBackup !== configNow) {
    console.log('[!] 检测到 ~/.zcode/config.json 漂移，恢复备份');
    if (configBackup !== null) fs.writeFileSync(userConfig, configBackup);
    report.configDrift = 'restored';
  } else {
    report.configDrift = 'none';
  }

  fs.writeFileSync(path.join(__dirname, 'probe-surface-report.json'), JSON.stringify(report, null, 1));
  clearTimeout(hardTimer);
  child.kill();
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000).unref(); });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('RESULT: ok（报告 probe-surface-report.json）');
  process.exit(0);
})().catch((error) => {
  console.log(`RESULT: ${error.message}`);
  child.kill();
  process.exit(1);
});
