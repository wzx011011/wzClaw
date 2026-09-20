'use strict';

// probe-subagentflow — 子智能体全链路实测（2026-09-21）
//
// 回答四个问题（全部只观测，不猜测）：
//   Q1 父会话事件流里是否出现子智能体自身的 delta（混流与否的根本）？
//   Q2 父会话 session/messages 里子智能体相关消息的形状（info.agent 归属、
//      part 类型：subagent/agent/text？）
//   Q3 session/subagents 响应形状（childSessionId 关联）
//   Q4 子会话自身的 session/messages 形状
//
// 方法：真实触发一次最小 Agent 调用（子任务=只回复 ok），全程抓事件。
// 成本：主回合一次 + 子智能体一次小生成，token 极少。
// 用法: node probe-subagentflow.js [--cwd <目录>]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', fs.mkdtempSync(path.join(os.tmpdir(), 'probe-subflow-')));

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const child = spawn(defaultZcodeCommand().command, [...defaultZcodeCommand().args, 'app-server', '--cwd', CWD], {
  cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1;
const pending = new Map();
let buffer = '';
const events = []; // 全量事件流水
let sessionId = null;
let done = false;

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, timeoutMs).unref();
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
      const resolve = pending.get(f.id);
      if (resolve) { pending.delete(f.id); resolve(f); }
      continue;
    }
    // 通知：反向请求代答 + 事件采集
    if (f.method && f.id != null) {
      const answers = {
        'session/requestRuntimePreferences': { nativeSearchEnhancementsEnabled: false },
        'startup/storageState': {},
        'process/mcpTelemetry': {},
      };
      if (answers[f.method] !== undefined) send({ id: f.id, result: answers[f.method] });
      continue;
    }
    if (f.method === 'session/event') {
      const p = f.params || {};
      const payload = p.payload || {};
      events.push({
        seq: p.seq, eventId: p.eventId, type: p.type || payload.kind,
        turnId: p.turnId, kind: payload.kind,
        assistantMessageId: payload.assistantMessageId,
        toolCallId: payload.toolCallId,
        deltaHead: typeof payload.delta === 'string' ? payload.delta.slice(0, 24) : undefined,
        keys: Object.keys(p).join(','),
      });
      if (p.type === 'turn.completed' || p.type === 'turn.abort' || p.type === 'error') done = true;
    }
  }
});
child.stderr.on('data', () => {});

(async () => {
  await sleep(1500);
  const report = { cwd: CWD, events: [], findings: {} };

  const create = await request('session/create', {
    workspace: { workspaceKey: 'probe-subflow', workspacePath: CWD },
  });
  sessionId = create?.result?.session?.sessionId;
  if (!sessionId) { report.error = 'create failed'; console.log(JSON.stringify(report)); child.kill(); return; }
  report.sessionId = sessionId;

  const sub = await request('session/subscribe', {
    sessionId, deliveryKind: 'web-remote-replayable',
  });
  report.subscribeOk = !sub.error;
  // 订阅快照里可能自带回放事件
  if (sub.result && Array.isArray(sub.result.events)) {
    for (const ev of sub.result.events) {
      events.push({ replay: true, seq: ev.seq, eventId: ev.eventId, type: ev.type || (ev.payload || {}).kind });
    }
  }

  const PROMPT = '用 Agent 工具派一个 general-purpose 子智能体，任务只需回复两个字母：ok。等子智能体结束后，把它回复的原话告诉我。不要做其他任何事。';
  const sent = await request('session/send', { sessionId, content: PROMPT });
  report.sendAccepted = !(sent && sent.error);

  // 等回合结束（最长 180s）
  for (let i = 0; i < 180 && !done; i++) await sleep(1000);
  report.turnDone = done;

  // Q3: session/subagents
  const suba = await request('session/subagents', { sessionId });
  report.findings.subagents = suba.result ?? suba.error;

  // Q2: 父会话 messages
  const msgs = await request('session/messages', { sessionId, limit: 50 });
  const out = [];
  for (const m of (msgs.result?.messages || [])) {
    const info = m.info || {};
    for (const p of m.parts || []) {
      out.push({
        role: info.role, agent: info.agent ?? null, msgId: (info.id || '').slice(-10),
        type: p.type, tool: p.type === 'tool' ? p.tool : undefined,
        toolStatus: p.type === 'tool' ? (p.state || {}).status : undefined,
        textHead: p.type === 'text' ? (p.text || '').slice(0, 40) : undefined,
      });
    }
  }
  report.findings.parentMessages = out;

  // Q4: 子会话 messages
  const childSid = (() => {
    try {
      const s = suba.result;
      const arr = (s && s.running && s.running.length ? s.running : []) .concat((s && s.ended && s.ended.items) || []);
      return arr.map((x) => x.childSessionId).find(Boolean);
    } catch { return null; }
  })();
  if (childSid) {
    const cm = await request('session/messages', { sessionId: childSid, limit: 20 });
    const cout = [];
    for (const m of (cm.result?.messages || [])) {
      const info = m.info || {};
      for (const p of m.parts || []) {
        cout.push({
          role: info.role, agent: info.agent ?? null,
          type: p.type, textHead: p.type === 'text' ? (p.text || '').slice(0, 40) : undefined,
        });
      }
    }
    report.findings.childSessionId = childSid;
    report.findings.childMessages = cout;
  }

  // Q1: 事件流水摘要（子智能体运行期间父流里有什么）
  report.events = events;

  console.log(JSON.stringify(report, null, 1));
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('probe-fatal', e); try { child.kill(); } catch {} process.exit(1); });
