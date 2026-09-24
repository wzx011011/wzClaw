'use strict';

// probe-reasoning-part — 钉死权威消息里 reasoning part 的完整形状：
//   Q1 reasoning part 有哪些字段（有无 time{start,end} / partId？）
//   Q2 text part 同查（思考耗时历史化 + 一致性等价测试的前置）
//   Q3 session/subagents 在无子会话会话上的响应形状
// 写法沿用 probe-sync3：直连真 app-server stdio（不经 relay）。建一个测试
// 会话连发 1 个最小回合（"只回复 1"），token 成本可忽略。只读协议形状，
// 不触碰任何用户会话。
// 用法: node probe-reasoning-part.js [--cwd <工作区>]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', process.cwd());
const PROMPT = flag('--prompt', '探针回合：请只回复数字 1');

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
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
const pushed = [];
let buffer = '';

function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true }); }, 20000).unref();
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
    } else if (f.method && f.id != null) {
      if (f.method === 'session/requestRuntimePreferences') {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
      } else {
        console.log(`!! 未预期的反向请求: ${f.method}`);
        send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
      }
    } else {
      pushed.push(f);
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c.toString().slice(0, 200)}`));

const partShape = (p) => ({
  type: p?.type ?? null,
  keys: p && typeof p === 'object' ? Object.keys(p).sort() : null,
  time: p?.time ?? p?.state?.time ?? null,
  id: p?.id ?? p?.partId ?? null,
  textLen: typeof p?.text === 'string' ? p.text.length : null,
});

(async () => {
  const report = {};
  try {
    await sleep(600);
    const create = await request('session/create', {
      workspace: { workspaceKey: CWD.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: CWD },
    });
    const sid = create?.result?.session?.sessionId;
    report.create = { ok: !!sid, sessionId: sid };
    console.log('created', sid);
    if (!sid) throw new Error('create failed');

    const send1 = await request('session/send', { sessionId: sid, content: PROMPT });
    if (send1?.error || typeof send1?.result === 'string') {
      report.send = { error: send1?.error ?? send1?.result };
      throw new Error('send failed');
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && !pushed.some((f) => f.params?.type === 'turn.completed' && f.params?.sessionId === sid)) await sleep(500);
    await sleep(1500);
    console.log('turn done');

    // 权威消息完整 parts 原样落盘（reasoning/text 形状是本题）
    const msgs = await request('session/messages', { sessionId: sid, limit: 1000 });
    const rawMessages = msgs?.result?.messages ?? [];
    report.messages = rawMessages.map((m) => ({
      role: m?.info?.role ?? null,
      infoKeys: m?.info ? Object.keys(m.info).sort() : null,
      parts: (m?.parts ?? []).map(partShape),
    }));
    // reasoning/text part 原文（脱字段落盘：text 截前 40 字符）
    report.rawAssistantParts = rawMessages
      .filter((m) => m?.info?.role === 'assistant')
      .flatMap((m) => m.parts ?? [])
      .map((p) => {
        const clone = JSON.parse(JSON.stringify(p));
        if (typeof clone.text === 'string' && clone.text.length > 40) clone.text = clone.text.slice(0, 40) + '…';
        return clone;
      });

    // session/subagents 形状（无子会话的会话）
    const sub = await request('session/subagents', { sessionId: sid });
    report.subagentsNoChildren = sub?.error
      ? { error: { code: sub.error.code, msg: String(sub.error.message).slice(0, 200) } }
      : { resultKeys: Object.keys(sub?.result ?? {}), raw: sub?.result };

    report.verdict = {
      reasoningHasTime: report.rawAssistantParts.some((p) => p.type === 'reasoning' && p.time),
      reasoningKeys: [...new Set(report.rawAssistantParts.filter((p) => p.type === 'reasoning').flatMap((p) => p.keys))],
      textHasTime: report.rawAssistantParts.some((p) => p.type === 'text' && p.time),
      textKeys: [...new Set(report.rawAssistantParts.filter((p) => p.type === 'text').flatMap((p) => p.keys))],
    };
  } catch (e) {
    report.fatal = String(e);
  }
  fs.writeFileSync(path.join(__dirname, 'probe-reasoning-part-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.verdict ?? report.fatal, null, 2));
  child.kill();
  process.exit(0);
})();
