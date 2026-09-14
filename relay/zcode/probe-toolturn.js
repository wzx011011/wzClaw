'use strict';

// probe-toolturn — U2.B 工具回合形状实测：捕获 tool.* 事件序列与权限确认
// 反向请求的完整 params，并对权限请求做「先捕获后拒绝 / 畸形 result 应答」
// 实验，读 zod 校验错误反推可接受的 result schema。
//
// 安全约束：
// - cwd 一律 mkdtemp 临时目录，绝不在真实仓库里跑工具；
// - 权限请求先捕获完整 params 再回 error 帧（拒绝），正常路径零执行；
// - 若模型在无权限请求的情况下直接执行工具（如 yolo 模式），立即
//   session/stop 止损（echo/test.txt 级副作用也被压制）；
// - 直连 app-server stdio（probe-sync2 模式），无配对 URL，日志不入敏感信息。
//
// 用法: node probe-toolturn.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
// 权限模式（session/setMode，合法值 plan|build|edit|yolo|auto，第一轮实测枚举）：
// edit/build 期望触发权限确认反向请求；yolo/auto 全自动放行（第一轮已证实）。
const MODE = flag('--mode', 'edit');
const RUN_TAG = flag('--tag', 'run');
const ONLY = flag('--only', null); // 只跑指定 label 的实验（新会话重测某变体）
const PROMPT_OVERRIDE = flag('--prompt', null); // 覆盖实验提示（如 lifecycle 观察用 echo）
// 禁用安全止损（仅用于 echo 级无副作用命令的 lifecycle 完整相位观察）
const NO_STOP = args.includes('--no-stop');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-toolturn-'));
console.log('tmp cwd:', TMP, 'mode:', MODE);

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1;
const pending = new Map();
const pushed = [];          // 全部通知/事件帧原文
const stderrLines = [];     // stderr 全量按行（zod 报错可能打在这里）
const reverseLog = [];      // 反向请求完整记录 {turn, phase, id, method, params, replied, reply, followups}
let reverseHandler = null;  // 当前回合的反向请求处理策略（主流程按阶段装配）
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
      // 反向请求：runtime prefs 代答；权限/确认类交给当前策略；其余记录后回绝
      if (f.method === 'session/requestRuntimePreferences') {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        continue;
      }
      const entry = { at: Date.now(), id: f.id, method: f.method, params: f.params, replied: null, followups: [] };
      reverseLog.push(entry);
      if (reverseHandler) {
        reverseHandler(entry);
      } else {
        console.log(`!! 无策略时的反向请求（回绝）: ${f.method}`);
        send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
        entry.replied = { error: { code: -32601 } };
      }
    }
  }
});
child.stderr.on('data', (c) => {
  for (const l of c.toString().split('\n')) if (l.trim()) stderrLines.push(l);
});

// 等待某回合结束（session/event type=turn.completed 且 turnId 匹配，或超时）；
// abort 谓词为真时提前返回 'aborted'
async function waitTurnDone(sid, turnId, timeoutMs, abort) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const done = pushed.some((f) => f.method === 'session/event'
      && f.params?.type === 'turn.completed' && f.params?.sessionId === sid
      && (turnId == null || f.params?.turnId === turnId));
    if (done) return true;
    if (abort && abort()) return 'aborted';
    await sleep(400);
  }
  return false;
}

// 等待任意一条满足谓词的推送帧（或超时）
async function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = pushed.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

// 会话事件按 type 分组统计 + 每 type 首帧原文（裁剪）
function summarizeEvents(sid) {
  const byType = {};
  for (const f of pushed) {
    if (f.method !== 'session/event' || f.params?.sessionId !== sid) continue;
    const t = f.params?.type ?? '?';
    if (!byType[t]) byType[t] = { count: 0, firstRaw: JSON.stringify(f).slice(0, 900) };
    byType[t].count++;
  }
  return byType;
}

// telemetry kind 统计 + tool 相关首帧原文
function summarizeTelemetry(sid) {
  const byKind = {};
  for (const f of pushed) {
    if (f.method !== 'v4/telemetry/event' || f.params?.sessionId !== sid) continue;
    const k = f.params?.kind ?? '?';
    if (!byKind[k]) byKind[k] = { count: 0, firstRaw: JSON.stringify(f).slice(0, 600) };
    byKind[k].count++;
  }
  return byKind;
}

// state.updated patch 键轨迹（mode/permission/activeToolCalls 原文）
function summarizeStatePatches(sid) {
  return pushed
    .filter((f) => f.method === 'state.updated' && (f.params?.sessionId === sid || !f.params?.sessionId))
    .map((f) => ({ reason: f.params?.reason ?? null, patchKeys: Object.keys(f.params?.patch || {}),
      status: f.params?.patch?.status ?? null,
      modeRaw: f.params?.patch?.mode !== undefined ? JSON.stringify(f.params.patch.mode).slice(0, 300) : null,
      permissionRaw: f.params?.patch?.permission !== undefined ? JSON.stringify(f.params.patch.permission).slice(0, 600) : null,
      hasActiveToolCalls: f.params?.patch?.activeToolCalls !== undefined,
      activeToolCallsRaw: f.params?.patch?.activeToolCalls !== undefined
        ? JSON.stringify(f.params.patch.activeToolCalls).slice(0, 600) : null, }));
}

// 全部 tool.updated 的 payload（按 kind 分组收集形状；权限确认实验的关键序列）
function summarizeToolUpdated(sid) {
  return pushed
    .filter((f) => f.method === 'session/event' && f.params?.type === 'tool.updated' && f.params?.sessionId === sid)
    .map((f) => ({ turnId: f.params?.turnId, payload: f.params?.payload }));
}

// 全部 tool.lifecycle telemetry（phase 序列：scheduled → … → completed）
function summarizeToolLifecycle(sid) {
  return pushed
    .filter((f) => f.method === 'v4/telemetry/event' && f.params?.kind === 'tool.lifecycle'
      && (f.params?.sessionId === sid || !f.params?.sessionId))
    .map((f) => f.params);
}

(async () => {
  const report = { tmpCwd: TMP, mode: MODE };
  try {
    await sleep(800);
    // 1) 建会话（临时工作区）
    const create = await request('session/create', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    report.create = { ok: !!sid, session: create?.result?.session };
    console.log('created', sid);
    if (!sid) throw new Error('create failed: ' + JSON.stringify(create?.error));

    // 2) 订阅推送（事件序列捕获通道）
    const sub = await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    report.subscribe = { ok: !sub?.error, eventSeq: sub?.result?.eventSeq };

    // 2b) 设权限模式（第一轮实测枚举 plan|build|edit|yolo|auto；默认继承工作区
    //     配置对本临时目录表现为自动放行，必须显式设 edit/build 才可能触发
    //     权限确认反向请求；'none' 跳过 setMode，观察默认行为）
    if (MODE !== 'none') {
      const setMode = await request('session/setMode', { sessionId: sid, mode: MODE });
      report.setMode = { ok: !setMode?.error && !setMode?.__timeout, resp: setMode?.error ?? setMode?.result };
      console.log(`setMode(${MODE}):`, JSON.stringify(report.setMode).slice(0, 300));
    }
    await sleep(800);

    // ── 实验回合序列（每回合一个应答策略）──
    // 前两轮实测结论：edit 模式下 echo（低风险）自动放行；printf > 文件
    // （高风险）触发 interaction/requestPermission；畸形 result 会被服务端
    // 静默判为 deny（reason="Permission request failed"），无 zod 回显。
    // 本轮补齐：error 帧拒绝 / 空 result / 合法 deny（验证 result schema——
    // 合法应答的 permission.resolved.reason 应体现我们的 reason 而非失败标记）。
    const EXPERIMENTS = [
      {
        label: 'reject-error-frame',
        prompt: "用 Bash 工具执行命令：printf 'A' > probe-a.txt（必须调用工具）。",
        reply: () => ({ error: { code: -32000, message: 'probe: rejected (capture-only)' } }),
      },
      {
        label: 'result-empty-object',
        prompt: "用 Bash 工具执行命令：printf 'B' > probe-b.txt（必须调用工具）。",
        reply: () => ({ result: {} }),
      },
      {
        label: 'result-wrong-type',
        prompt: "用 Bash 工具执行命令：printf 'C' > probe-c.txt（必须调用工具）。",
        reply: () => ({ result: { approved: 'yes' } }),
      },
      {
        label: 'result-valid-deny',
        prompt: "用 Bash 工具执行命令：printf 'D' > probe-d.txt（必须调用工具）。",
        reply: () => ({ result: { decision: 'deny', reason: 'probe denied on purpose' } }),
      },
    ];
    let phase = 'idle';
    reverseHandler = (entry) => {
      entry.phase = phase;
      console.log(`\n>> 反向请求 [${entry.method}]（${phase}）params=`, JSON.stringify(entry.params).slice(0, 1200));
      const exp = EXPERIMENTS.find((e) => `exp-${e.label}` === phase);
      if (exp) {
        const frame = exp.reply();
        send({ id: entry.id, ...frame });
        entry.replied = frame;
      } else {
        send({ id: entry.id, error: { code: -32601, message: 'probe: unexpected phase' } });
        entry.replied = { error: { code: -32601 } };
      }
    };
    report.experiments = [];
    for (const exp of ONLY ? EXPERIMENTS.filter((e) => e.label === ONLY) : EXPERIMENTS) {
      phase = `exp-${exp.label}`;
      const markN = pushed.length;
      const stderrMark = stderrLines.length;
      const sendN = await request('session/send', { sessionId: sid, content: PROMPT_OVERRIDE ?? exp.prompt });
      const turnStarted = await waitFor((f) => f.method === 'session/event' && f.params?.type === 'turn.started'
        && f.params?.sessionId === sid, 15000);
      const turnNId = turnStarted?.params?.turnId ?? null;
      // 安全止损：工具真在执行（running）却无本回合权限请求 → stop。
      const startedExecuting = () => pushed.slice(markN).some((f) => f.method === 'session/event'
        && f.params?.type === 'tool.updated'
        && ['running', 'started', 'executing'].includes(String(f.params?.payload?.kind ?? ''))
        && !reverseLog.some((e) => e.phase === phase));
      const doneN = await waitTurnDone(sid, turnNId, 100000, NO_STOP ? null : startedExecuting);
      let stopped = false;
      if (doneN === 'aborted') {
        console.log('!! 未出现权限请求但工具开始执行 —— session/stop 止损');
        await request('session/stop', { sessionId: sid });
        stopped = true;
        await sleep(2500);
      }
      await sleep(1500); // 给迟到的 permission.resolved 留窗口
      const entry = reverseLog.filter((e) => e.phase === phase).pop();
      if (entry) {
        entry.followups = pushed.filter((f) => f.id === entry.id).map((f) => JSON.stringify(f).slice(0, 500));
      }
      // 本回合相关的 permission.requested / resolved 事件（按 requestId 关联）
      const reqId = entry?.params?.requestId ?? null;
      const permEvents = pushed.filter((f) => f.method === 'session/event'
        && ['permission.requested', 'permission.resolved'].includes(f.params?.type)
        && (!reqId || f.params?.payload?.requestId === reqId))
        .map((f) => JSON.stringify(f.params?.payload).slice(0, 700));
      report.experiments.push({
        label: exp.label, turnId: turnNId, done: doneN === true, stoppedForSafety: stopped,
        sendResp: sendN?.error ?? (typeof sendN?.result === 'string' ? sendN.result : sendN?.result?.accepted ?? sendN?.result),
        sawReverseRequest: !!entry,
        permissionEvents: permEvents,
        turnCompletedPayload: (pushed.filter((f) => f.method === 'session/event' && f.params?.type === 'turn.completed'
          && f.params?.turnId === turnNId).map((f) => JSON.stringify(f.params?.payload).slice(0, 400)))[0] ?? null,
        stderrNew: stderrLines.slice(stderrMark).slice(0, 20),
        eventsThisTurn: pushed.slice(markN).filter((f) => f.method === 'session/event')
          .map((f) => f.params?.type).filter((t, i, a) => a.indexOf(t) === i),
      });
      console.log(`experiment ${exp.label}: reverse=${!!entry} done=${doneN === true} stopped=${stopped}`);
    }

    await sleep(1500);

    // ── 汇总捕获 ──
    report.reverseRequests = reverseLog;
    report.eventByType = summarizeEvents(sid);
    report.telemetryByKind = summarizeTelemetry(sid);
    report.statePatches = summarizeStatePatches(sid);
    report.toolUpdatedAll = summarizeToolUpdated(sid);
    report.toolLifecycleAll = summarizeToolLifecycle(sid);
    // 畸形应答后 stderr 里的 zod 反馈单独摘出（可能在任意阶段出现）
    report.stderrZodHints = stderrLines.filter((l) => /zod|invalid|expected|validation/i.test(l)).slice(0, 40);

    // 工具回合的权威消息形状（tool part 的真实字段）
    const msgs = await request('session/messages', { sessionId: sid, limit: 50 });
    const raw = msgs?.result?.messages ?? [];
    report.authoritativeMessages = raw.map((m) => ({
      role: m?.info?.role,
      id: m?.info?.id,
      partTypes: (m?.parts ?? []).map((p) => p?.type),
      toolPartRaw: (m?.parts ?? []).filter((p) => p?.type === 'tool').map((p) => JSON.stringify(p).slice(0, 900)),
      textHead: String((m?.parts ?? []).find((p) => p?.type === 'text')?.text ?? '').slice(0, 80),
    }));
    // 临时目录残留检查（安全约束的自证）
    report.tmpDirLeftovers = fs.readdirSync(TMP);

    await request('session/close', { sessionId: sid });
    fs.writeFileSync(path.join(__dirname, `probe-toolturn-report${RUN_TAG ? `-${RUN_TAG}` : ''}.json`), JSON.stringify(report, null, 2));
    console.log(`\n=== REPORT SAVED probe-toolturn-report${RUN_TAG ? `-${RUN_TAG}` : ''}.json ===`);
    console.log('reverse requests:', reverseLog.map((e) => `${e.method}(${e.phase})`).join('; ') || 'NONE');
    console.log('event types:', Object.keys(report.eventByType).join(', '));
  } finally {
    child.removeAllListeners('exit');
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 保留供人工检查 */ }
      process.exit(0);
    }, 2500);
  }
})();
