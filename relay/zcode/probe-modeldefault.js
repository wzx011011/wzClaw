'use strict';

// probe-modeldefault — 新会话默认模型行为实测（2026-09-20）
//
// 背景：手机端「节点默认模型」只落盘 companion（model-default.json），
// 注释声称「新会话由手机端建会后先 setModel 应用」，但建会话流程没有
// 这一步。本探针钉死引擎侧行为：
//   Q1 session/create 出来的会话初始模型是什么（engine 怎么定默认）？
//   Q2 对会话 A setModel 后，新建会话 B 是否继承？
//   Q3 引擎进程重启后，新会话是否继承上一进程的模型选择（持久化 vs 内存）？
// 全程不产生推理（create/setModel 不调 LLM），token 成本为零。
// 写法沿用 probe-sync3：直连 app-server stdio，代答 runtime 反向请求
// （不代答 create 会 -32022，APP-SERVER.md 实测）。
// 用法: node probe-modeldefault.js [--cwd <临时目录>]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const report = { steps: [] };
let child = null;
let nextId = 1;
const pending = new Map();
let buffer = '';

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params, timeoutMs = 25000) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, timeoutMs).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleLine(line) {
  let f; try { f = JSON.parse(line); } catch { return; }
  if (f && f.id != null && (f.result !== undefined || f.error !== undefined) && !f.method) {
    const resolve = pending.get(f.id);
    if (resolve) { pending.delete(f.id); resolve(f); }
    return;
  }
  // 反向请求：companion 同款代答（不代答 create -32022）
  if (f && f.method && f.id != null) {
    const answers = {
      'session/requestRuntimePreferences': { nativeSearchEnhancementsEnabled: false },
      'startup/storageState': {},
      'process/mcpTelemetry': {},
    };
    if (answers[f.method] !== undefined) send({ id: f.id, result: answers[f.method] });
    return;
  }
}

function startEngine(cwd) {
  const zc = defaultZcodeCommand();
  // --overlay <path>：带上 companion 的套餐注入 env（复现 companion spawn）
  const overlay = flag('--overlay', null);
  const extra = overlay ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: overlay } : {};
  child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', cwd], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')), ...extra },
  });
  buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', () => {});
  return sleep(1500);
}

async function stopEngine() {
  if (!child) return;
  const c = child; child = null;
  pending.clear();
  c.kill();
  await sleep(600);
}

function modelOf(createResult) {
  const s = createResult && createResult.session;
  const current = createResult && createResult.settings && createResult.settings.model
    ? createResult.settings.model.current : null;
  return {
    sessionModel: s && s.model ? `${s.model.providerId}/${s.modelId ?? s.model.modelId}` : null,
    settingsCurrent: current && current.providerId ? `${current.providerId}/${current.modelId}` : null,
  };
}

async function createSession(cwd, label) {
  const r = await request('session/create', {
    workspace: { workspaceKey: 'probe-default', workspacePath: cwd },
  });
  if (!r || r.error || !r.result) {
    report.steps.push({ step: label, ok: false, error: r && r.error });
    return null;
  }
  const info = modelOf(r.result);
  const available = r.result.settings && r.result.settings.model
    ? r.result.settings.model.available : [];
  // 按 provider 聚合打印目录构成（诊断注入是否生效）
  const byProvider = {};
  for (const m of available) {
    const ref = m && m.ref; if (!ref) continue;
    (byProvider[ref.providerId] ??= []).push(ref.modelId);
  }
  report.steps.push({
    step: label, ok: true, availableCount: available.length,
    byProvider, ...info,
  });
  return {
    sessionId: r.result.session.sessionId, available, ...info,
  };
}

(async () => {
  const cwd = flag('--cwd', fs.mkdtempSync(path.join(os.tmpdir(), 'probe-mdefault-')));
  report.cwd = cwd;

  // 进程 1
  await startEngine(cwd);
  const s1 = await createSession(cwd, 'P1.create#1（全新进程首会话）');
  if (!s1) { console.log(JSON.stringify(report, null, 2)); await stopEngine(); return; }

  // 选一个与当前不同的模型做 setModel（有档位则按契约带 options）
  const currentRef = s1.settingsCurrent || s1.sessionModel;
  const pick = s1.available.find((m) => {
    const ref = m && m.ref; if (!ref) return false;
    return `${ref.providerId}/${ref.modelId}` !== currentRef;
  });
  if (!pick) report.steps.push({ step: 'P1.pick', ok: false, note: '目录只有当前模型，跳过 setModel' });
  if (pick) {
    const reasoning = pick.reasoning && Array.isArray(pick.reasoning.levels) ? pick.reasoning : null;
    let level = null;
    if (reasoning) {
      const levels = reasoning.levels.map((e) => (e && typeof e === 'object' ? e.value : e)).filter(Boolean);
      const def = reasoning.defaultLevel;
      level = def && levels.includes(def) ? def : levels[0];
    }
    const sm = await request('session/setModel', {
      sessionId: s1.sessionId,
      model: {
        providerId: pick.ref.providerId, modelId: pick.ref.modelId,
        ...(level ? { options: { reasoningLevel: level } } : {}),
      },
    });
    report.steps.push({
      step: 'P1.setModel', ok: !sm.error,
      target: `${pick.ref.providerId}/${pick.ref.modelId}`, level,
      error: sm.error || null,
    });

    const s2 = await createSession(cwd, 'P1.create#2（setModel 之后新建，看是否继承）');
    report.inheritAfterSetModel = s2 ? s2.settingsCurrent || s2.sessionModel : null;
  }

  // 进程重启
  await stopEngine();
  await startEngine(cwd);
  const s3 = await createSession(cwd, 'P2.create#3（引擎重启后新建，看是否持久化）');
  report.inheritAfterRestart = s3 ? s3.settingsCurrent || s3.sessionModel : null;
  await stopEngine();

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('probe-fatal', e); process.exit(1); });
