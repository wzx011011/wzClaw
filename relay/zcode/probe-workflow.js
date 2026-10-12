'use strict';

// probe-workflow — workflow 渲染数据源实测：让引擎在临时工作区 inline 编排
// 一个最小 dynamic workflow（单子代理、report 交回），全量捕获三条通道
// （session/event、state.updated、v4/telemetry/event）里 workflow 相关帧的
// 原文形状，并实调 workflows/list、workflows/runs，回答：
//   1) CreateWorkflow 工具调用在事件流/权威消息里长什么样（display 挂在哪）；
//   2) run 进行中/结束后 state.updated 的 workflowRuns 投影形状；
//   3) workflows/runs 实调返回什么；
//   4) 后台任务 kind=workflow 条目形状。
//
// 安全约束（同 probe-toolturn）：
// - cwd 一律 mkdtemp 临时目录，绝不在真实仓库里跑；
// - 子代理任务为「回复 ok」级，无真实工具副作用；
// - 结束后 session/close + 子进程退出，临时目录清理。
//
// 用法: node probe-workflow.js [--timeout 秒]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const TURN_TIMEOUT_MS = (parseInt(flag('--timeout', '420'), 10) || 420) * 1000;
// v2 config 的 provider 键（2026-10-11 实测：coding-plan token 对 glm-5.3 /
// glm-5.3-flash 裸 API 均 200，但必须连 ANTHROPIC_BASE_URL 一起显式注入——
// CLI 默认端点与套餐不符时 403「No active subscription found for this group」；
// start-plan 端点（zcode.z.ai）路径布局不同且裸 CLI 不可服务，弃用）
const PROVIDER = flag('--provider', 'builtin:bigmodel-coding-plan');

// 探针本地读认证（不走 companion 的 readModelAuth——那家硬编码 coding-plan），
// 只取 token/baseURL，不打印；形状与 companion 同源：provider[<key>].options
function readProbeAuth(v2ConfigPath) {
  const parsed = JSON.parse(fs.readFileSync(v2ConfigPath, 'utf8'));
  const entry = parsed?.provider?.[PROVIDER]?.options;
  if (typeof entry?.apiKey !== 'string' || entry.apiKey.length === 0) {
    throw new Error(`provider ${PROVIDER} 无 apiKey（~/.zcode/v2/config.json）`);
  }
  return { apiKey: entry.apiKey, baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : null };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-workflow-'));
console.log('tmp cwd:', TMP);

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
// 认证（2026-10-11 定案）：裸 env key/baseURL 会被 CLI 自身登录态无视——
// 起模型请求仍打登录账号的端点然后 403「No active subscription found」。
// 唯一实证可服务通道 = companion 同款 plan overlay：ZCODE_PERSONAL_PROVIDER_
// CONFIG_FILE 注入 provider 配置副本（配方逐字对齐 plan-overlay.js：
// providerRules 条目不带 enabled、api.{type,baseUrl} 必填、每模型一条
// providerModelRules；非 account: provider 才允许 access.api-key 注入）。
// token 只进 0600 临时文件，跑完即删，不打印。
const probeAuth = readProbeAuth(path.join(os.homedir(), '.zcode/v2/config.json'));
const PROBE_PROVIDER_ID = 'custom:probe-bigmodel-plan';
const OVERLAY_MODELS = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'];
function writeProbeOverlay() {
  // 以真实 provider_config.json 为底克隆（probe-personal-plan.js 验证过的
  // 形状：custom provider + access{zhipu-coding-plan-api-key}；空骨架底本
  // 2026-10-11 实测被整份拒绝）。token 只进 0600 副本，跑完即删。
  const basePath = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
  let overlay;
  try { overlay = JSON.parse(fs.readFileSync(basePath, 'utf8')); } catch { overlay = null; }
  if (!overlay || typeof overlay !== 'object') overlay = { schemaVersion: 1, config: {} };
  overlay.schemaVersion = 1;
  overlay.config = overlay.config && typeof overlay.config === 'object' ? overlay.config : {};
  const pcr = overlay.config.providerConfigRules
    && typeof overlay.config.providerConfigRules === 'object'
    ? overlay.config.providerConfigRules : {};
  pcr.providerRules = (Array.isArray(pcr.providerRules) ? pcr.providerRules : [])
    .filter((r) => r && r.providerId !== PROBE_PROVIDER_ID);
  pcr.providerRules.push({
    providerId: PROBE_PROVIDER_ID,
    config: {
      group: 'standard-personal',
      personalModelIds: [...OVERLAY_MODELS],
      modelOrder: [...OVERLAY_MODELS],
      api: { type: 'anthropic-messages', baseUrl: probeAuth.baseURL },
      access: { type: 'zhipu-coding-plan-api-key', apiKey: probeAuth.apiKey },
    },
  });
  overlay.config.providerConfigRules = pcr;
  const mcr = overlay.config.modelConfigRules
    && typeof overlay.config.modelConfigRules === 'object'
    ? overlay.config.modelConfigRules : {};
  mcr.providerModelRules = (Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : [])
    .filter((r) => r && r.providerId !== PROBE_PROVIDER_ID);
  for (const modelId of OVERLAY_MODELS) {
    mcr.providerModelRules.push({ providerId: PROBE_PROVIDER_ID, modelId, config: { properties: {} } });
  }
  overlay.config.modelConfigRules = mcr;
  const out = path.join(os.tmpdir(), `probe-plan-overlay-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(overlay), { mode: 0o600 });
  return out;
}
const overlayFile = writeProbeOverlay();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: probeAuth.apiKey,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: overlayFile,
  },
});

let nextId = 1;
const pending = new Map();
const pushed = [];          // 全部通知/事件帧原文
const stderrLines = [];
let buffer = '';

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, 30000).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f && f.id != null && (f.result !== undefined || f.error !== undefined) && !f.method) {
      const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); }
      continue;
    }
    pushed.push(f);
    if (f.method && f.id != null) {
      // 反向请求：runtime prefs 代答；权限请求捕获后放行（yolo 下不应出现，
      // 出现说明模式未生效——放行避免工作流卡死，params 已完整留痕）；
      // 其余（userInput 等）记录原文后拒绝，不让 run 无限等。
      if (f.method === 'session/requestRuntimePreferences') {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        continue;
      }
      console.log(`!! 反向请求: ${f.method} ${JSON.stringify(f.params).slice(0, 300)}`);
      if (f.method === 'interaction/requestPermission') {
        send({ id: f.id, result: { decision: 'allow', reason: 'probe workflow: temp dir, allow' } });
        continue;
      }
      send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
    }
  }
});
child.stderr.on('data', (c) => {
  for (const l of c.toString().split('\n')) if (l.trim()) stderrLines.push(l);
});

async function waitTurnDone(sid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = pushed.some((f) => f.method === 'session/event'
      && f.params?.type === 'turn.completed' && f.params?.sessionId === sid);
    if (done) return true;
    await sleep(500);
  }
  return false;
}

const WF_PROMPT = [
  '请立即用 dynamic workflow 编排执行一个最小工作流（调用 CreateWorkflow 工具，script 内联，不要询问我）：',
  '脚本里：1) 用 phase(\'smoke\') 标记阶段；2) agent("smoke-worker") 询问子代理「只回复两个字符：ok」；',
  '3) 用 log() 输出一条进度；4) 把子代理答案经 report() 交回；5) return 一个含答案的汇总字符串。',
  '不要做任何文件读写或命令执行。',
].join('\n');

(async () => {
  const report = { tmpCwd: TMP, zcode: zc.args.join(' ') || zc.command };
  try {
    await sleep(800);
    // 先开 workflow 灰度门（dynamic-workflow-policy.ts 实测语义：只影响之后
    // 创建/恢复的 record——create 之后再开对本会话无效）
    const pol = await request('workspace/updateDynamicWorkflowPolicy', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
      enabled: true,
    });
    report.policy = { ok: !pol?.error, error: pol?.error ?? null, result: pol?.result ?? null };
    console.log('policy:', JSON.stringify(report.policy).slice(0, 200));

    const create = await request('session/create', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    report.create = { ok: !!sid, error: create?.error ?? null };
    console.log('created', sid);
    if (!sid) throw new Error('create failed');

    const sub = await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    report.subscribe = { ok: !sub?.error, eventSeq: sub?.result?.eventSeq };

    // 模型钉档（2026-10-11 实测）：start-plan 订阅只覆盖 Flash 组，CLI 默认
    // 模型 glm-5.3 的 group 403「No active subscription found」——建会后从
    // create 快照 settings.model.available 选 flash 档 setModel 再发
    const avail = create?.result?.settings?.model?.available;
    report.modelCatalog = Array.isArray(avail)
      ? { count: avail.length, first3: JSON.parse(JSON.stringify(avail.slice(0, 3))) }
      : String(avail).slice(0, 200);
    const flash = Array.isArray(avail)
      && avail.find((m) => m?.ref?.providerId === PROBE_PROVIDER_ID
        && m?.ref?.modelId === 'glm-5.3-flash');
    if (flash) {
      // setModel 正形（APP-SERVER.md + 手机端实测契约）：model 为
      // {providerId, modelId, options?{reasoningLevel}}——推理档位嵌在
      // model.options 里（顶层传 -32602），档位取目录 reasoning.levels
      const ref = flash?.ref ?? {};
      const levels = Array.isArray(flash?.reasoning?.levels)
        ? flash.reasoning.levels.map((l) => l?.value).filter(Boolean) : [];
      const def = flash?.reasoning?.defaultLevel;
      const level = def && levels.includes(def) ? def : levels.first ?? null;
      const picked = {
        providerId: ref.providerId ?? PROBE_PROVIDER_ID,
        modelId: ref.modelId ?? 'glm-5.3-flash',
        ...(level ? { options: { reasoningLevel: level } } : {}),
      };
      const sm = await request('session/setModel', { sessionId: sid, model: picked });
      report.setModel = { ok: !sm?.error, picked, error: sm?.error ?? null };
      console.log('setModel →', picked.providerId, picked.modelId, level);
    } else {
      report.setModel = { ok: false, note: 'catalog 无 flash 档，裸默认模型发（可能 403）' };
    }

    // yolo：临时目录零副作用前提下免权限停顿（子代理任务为纯回复）
    const mode = await request('session/setMode', { sessionId: sid, mode: 'yolo' });
    report.setMode = { ok: !mode?.error, error: mode?.error ?? null };

    // workflow 方法面实调（只读）
    const wfList = await request('workflows/list', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
    });
    report.workflowsList = { ok: !wfList?.error, error: wfList?.error ?? null, result: wfList?.result ?? null };

    const sendRes = await request('session/send', { sessionId: sid, content: WF_PROMPT });
    report.send = { ok: !sendRes?.error, error: sendRes?.error ?? null };
    const turnId = sendRes?.result?.turnId ?? null;
    console.log('sent, turnId:', turnId);

    const done = await waitTurnDone(sid, TURN_TIMEOUT_MS);
    report.turnCompleted = done;
    console.log('turn completed:', done);

    // run 稳定后再取快照（run-settled 与 turn.completed 可能有时差）
    await sleep(2000);

    // 1) session/read 全量键 + projection 内的 workflow 投影
    const read = await request('session/read', { sessionId: sid });
    if (read?.result) {
      const proj = read.result.projection ?? null;
      report.read = {
        topLevelKeys: Object.keys(read.result),
        projectionKeys: proj && typeof proj === 'object' ? Object.keys(proj) : null,
        projectionWorkflowRuns: proj?.workflowRuns ?? null,
        projectionBackgroundJobs: proj?.backgroundJobs ?? null,
        projectionBackgroundWorks: proj?.backgroundWorks ?? null,
      };
    } else {
      report.read = { error: read?.error ?? '__timeout' };
    }

    // 2) workflows/runs 实调（APP-SERVER.md 记「变更型未真调」——本次补上）
    const runs = await request('workflows/runs', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
      limit: 5,
    });
    report.workflowsRuns = { ok: !runs?.error, error: runs?.error ?? null, result: runs?.result ?? null };

    // 3) 权威消息里的 workflow 工具 part 全文
    const msgs = await request('session/messages', { sessionId: sid, limit: 40 });
    const wfToolParts = [];
    const messageInfos = [];
    if (msgs?.result?.messages) {
      for (const m of msgs.result.messages) {
        messageInfos.push(m.info ?? null);
        for (const p of (m.parts ?? [])) {
          const name = p?.tool ?? p?.name;
          if (p?.type === 'tool' && /workflow/i.test(String(name))) {
            wfToolParts.push(p);
          }
        }
      }
    }
    report.wfToolParts = wfToolParts;
    report.messageInfos = messageInfos;

    // 4) 事件流里 workflow 相关帧全量（CreateWorkflow 工具事件 + 未知类型留痕）
    report.wfEvents = pushed
      .filter((f) => f.method === 'session/event' && f.params?.sessionId === sid
        && JSON.stringify(f.params).includes('orkflow'))
      .map((f) => f.params);
    // 夹具补全：发起回合的全帧（turn.started + tool_input_* 流 + tool.updated），
    // 手机端 live 路径的工具行 name/输入累积契约以真帧锚定
    const launchTurn = pushed.find((f) => f.method === 'session/event'
      && f.params?.sessionId === sid && f.params?.type === 'turn.started');
    report.launchTurnFrames = launchTurn == null ? [] : (() => {
      const seq = [];
      const startIdx = pushed.indexOf(launchTurn);
      for (let i = startIdx; i < pushed.length; i++) {
        const f = pushed[i];
        if (f.method !== 'session/event' || f.params?.sessionId !== sid) continue;
        const t = f.params?.type ?? '';
        if (['turn.started', 'tool.updated', 'tool_input_start',
          'tool_input_delta', 'tool_input_end', 'tool_call',
          'turn.completed'].includes(t)) {
          seq.push({ method: f.method, params: f.params });
        }
        if (t === 'turn.completed') break;
      }
      return seq;
    })();
    // workflow.lifecycle 遥测全量（run 进度的候选数据源，手机已订阅此通道）
    report.wfLifecycleTelemetry = pushed
      .filter((f) => f.method === 'v4/telemetry/event'
        && (f.params?.kind === 'workflow.lifecycle' || /workflow/i.test(f.params?.kind ?? '')))
      .map((f) => f.params);
    report.statePatchesWithWorkflow = pushed
      .filter((f) => f.method === 'state.updated' && f.params?.patch?.workflowRuns !== undefined)
      .map((f) => ({ reason: f.params?.reason ?? null, workflowRuns: f.params.patch.workflowRuns }));
    report.bgJobEntries = pushed
      .filter((f) => f.method === 'state.updated' && f.params?.patch?.backgroundJobs !== undefined)
      .map((f) => f.params.patch.backgroundJobs).pop() ?? null;

    // 5) 事件类型 / telemetry kind / patch 键 面统计（发现未知新类型）
    const evTypes = {};
    for (const f of pushed) {
      if (f.method !== 'session/event' || f.params?.sessionId !== sid) continue;
      const t = f.params?.type ?? '?';
      evTypes[t] = (evTypes[t] ?? 0) + 1;
    }
    report.eventTypes = evTypes;
    const telKinds = {};
    for (const f of pushed) {
      if (f.method !== 'v4/telemetry/event') continue;
      const k = f.params?.kind ?? '?';
      telKinds[k] = (telKinds[k] ?? 0) + 1;
    }
    report.telemetryKinds = telKinds;
    const patchKeys = new Set();
    for (const f of pushed) {
      if (f.method === 'state.updated' && f.params?.patch) {
        for (const k of Object.keys(f.params.patch)) patchKeys.add(k);
      }
    }
    report.statePatchKeys = [...patchKeys].sort();

    // 最终 assistant 文本（报告收尾用）
    if (msgs?.result?.messages) {
      const lastText = [...msgs.result.messages].reverse()
        .flatMap((m) => m.parts ?? [])
        .find((p) => p?.type === 'text');
      report.finalAssistantText = lastText?.text?.slice(0, 1500) ?? null;
    }

    await request('session/close', { sessionId: sid });
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  } finally {
    report.stderrTail = stderrLines.slice(-20);
    const out = path.join(__dirname, 'probe-workflow.out.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    console.log('report →', out);
    // 清理临时目录与 overlay（均无真实工具落地；overlay 含 token，必删）
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(overlayFile, { force: true }); } catch {}
    child.kill('SIGKILL');
    setTimeout(() => process.exit(0), 300).unref();
  }
})();
