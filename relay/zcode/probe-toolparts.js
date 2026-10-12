'use strict';

// probe-toolparts — 诊断「终端展开空详情 / TodoWrite·TaskOutput 裸渲染」：
// 拉真实会话消息，把 assistant 工具 part 的实际形状（tool 名、state.input
// 键与命令值、output 有无、status、metadata 键）打出来。只读。
// 用法: node probe-toolparts.js [--cwd <目录>] [--session <sessionId>] [--limit N]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', 'E:\\ai\\wzxClaw');
const SESSION = flag('--session', null);
const LIMIT = Number(flag('--limit', '6'));

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', CWD], {
  cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

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
      return;
    }
    if (f && f.method && f.id != null) {
      const answers = {
        'session/requestRuntimePreferences': { nativeSearchEnhancementsEnabled: false },
        'startup/storageState': {},
        'process/mcpTelemetry': {},
      };
      if (answers[f.method] !== undefined) send({ id: f.id, result: answers[f.method] });
    }
  }
});
child.stderr.on('data', () => {});

function toolBrief(p) {
  const state = p.state && typeof p.state === 'object' ? p.state : {};
  const input = state.input;
  return {
    tool: typeof p.tool === 'string' ? p.tool : (p.tool && p.tool.name) || JSON.stringify(p.tool),
    status: state.status,
    inputType: input === undefined ? 'undefined' : input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input,
    inputKeys: input && typeof input === 'object' ? Object.keys(input) : null,
    command: input && typeof input === 'object' ? (input.command ?? input.cmd ?? null) : (typeof input === 'string' ? input.slice(0, 60) : null),
    outputType: state.output === undefined ? 'undefined' : typeof state.output,
    outputLen: typeof state.output === 'string' ? state.output.length : null,
    error: state.error ? String(state.error).slice(0, 60) : null,
    metadataKeys: state.metadata && typeof state.metadata === 'object' ? Object.keys(state.metadata) : null,
    title: state.title ?? null,
    stateKeys: Object.keys(state),
  };
}

(async () => {
  await sleep(1500);
  const list = await request('session/list', {});
  const sessions = (list.result && list.result.sessions) || [];
  console.log('sessions:', sessions.map((s) => `${s.sessionId} ${JSON.stringify(s.title || '')}`).join('\n  '));
  const target = SESSION || (sessions[0] && sessions[0].sessionId);
  if (!target) { console.log('no session'); child.kill(); return; }
  const r = await request('session/messages', { sessionId: target, limit: LIMIT });
  const msgs = (r.result && r.result.messages) || [];
  console.log(`\n== session ${target} last ${msgs.length} messages ==`);
  for (const m of msgs) {
    const info = m.info || {};
    const parts = m.parts || [];
    const tools = parts.filter((p) => p.type === 'tool');
    if (!tools.length) continue;
    console.log(`\n-- ${info.role} ${info.id || ''} (${tools.length} tools)`);
    for (const p of tools) console.log('  ', JSON.stringify(toolBrief(p)));
  }
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('probe-fatal', e); process.exit(1); });
