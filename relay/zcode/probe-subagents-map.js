'use strict';

// probe-subagents-map — 钉死父子会话映射（批次4 前置）：
//   Q1 找一个 childSessionIds 非空的会话（引擎存储与本机桌面共享，
//      今天的会话有子智能体活动）
//   Q2 ended.items[] 元素完整形状
//   Q3 父会话消息里，派发子智能体的 tool part 长什么样（有无 childSessionId
//      / agentId 元数据字段——TurnAgentData 进子会话面板的钥匙）
//   Q4 子会话 session/messages 是否可读（手机端面板的数据源）
// 直连真 app-server stdio（同 probe-sync3 家族）。只读：不建会话不发回合，
// 只 list + subagents + messages。文本一律截断，不落全文。
// 用法: node probe-subagents-map.js [--cwd <工作区>] [--max-scan N]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', process.cwd());
const MAX_SCAN = Number(flag('--max-scan', '40'));

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
        send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
      }
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c.toString().slice(0, 150)}`));

const trunc = (v, n = 60) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? null : (s.length > n ? s.slice(0, n) + '…' : s);
};

(async () => {
  const report = { scanned: [], hit: null };
  try {
    await new Promise((r) => setTimeout(r, 600));
    const list = await request('session/list');
    const sessions = list?.result?.sessions ?? [];
    console.log('total sessions:', sessions.length);
    const ids = sessions.map((s) => s?.id ?? s?.sessionId).filter(Boolean).slice(-MAX_SCAN);

    // Q1 找有子会话的会话（从最新的往回扫）
    for (const sid of ids.reverse()) {
      const sub = await request('session/subagents', { sessionId: sid });
      if (sub?.__timeout || sub?.error) { report.scanned.push({ sid, error: trunc(sub?.error, 80) }); continue; }
      const r0 = sub.result ?? {};
      const n = (r0.childSessionIds ?? []).length;
      report.scanned.push({ sid, children: n, running: (r0.running ?? []).length });
      if (n > 0) {
        report.hit = { sid, subagentsRaw: r0 };
        console.log('HIT', sid, 'children:', n);
        break;
      }
    }

    if (report.hit) {
      const parentSid = report.hit.sid;
      const childSid = report.hit.subagentsRaw.childSessionIds[0];

      // Q2 ended.items[0] 形状（若有）
      const endedItems = report.hit.subagentsRaw.ended?.items ?? [];
      if (endedItems.length) report.endedItemShape = trunc(endedItems[0], 400);

      // Q3 父会话消息里派发子智能体的 tool part 原样（截断文本）
      const msgs = await request('session/messages', { sessionId: parentSid, limit: 1000 });
      const agentParts = [];
      for (const m of msgs?.result?.messages ?? []) {
        for (const p of m?.parts ?? []) {
          if (p?.type !== 'tool') continue;
          const meta = JSON.stringify(p);
          if (/agent/i.test(meta)) {
            const clone = JSON.parse(JSON.stringify(p));
            if (typeof clone.state?.input === 'object' && clone.state?.input) {
              for (const k of Object.keys(clone.state.input)) {
                if (typeof clone.state.input[k] === 'string') clone.state.input[k] = trunc(clone.state.input[k], 40);
              }
            }
            if (typeof clone.state?.output === 'string') clone.state.output = trunc(clone.state.output, 40);
            agentParts.push(clone);
          }
        }
      }
      report.parentAgentToolParts = agentParts.slice(-3).map((p) => trunc(p, 700));

      // Q4 子会话可读性 + 首尾消息
      const childMsgs = await request('session/messages', { sessionId: childSid, limit: 1000 });
      if (childMsgs?.error) {
        report.childReadable = { error: trunc(childMsgs.error, 120) };
      } else {
        const cm = childMsgs?.result?.messages ?? [];
        report.childReadable = {
          ok: true,
          count: cm.length,
          roles: cm.map((m) => m?.info?.role),
          firstTextHead: trunc(cm.find((m) => m?.parts?.some?.((p) => p?.type === 'text'))?.parts?.find?.((p) => p?.type === 'text')?.text, 60),
        };
      }
    } else {
      report.note = '扫描范围内未发现 childSessionIds 非空的会话';
    }
  } catch (e) {
    report.fatal = String(e);
  }
  fs.writeFileSync(path.join(__dirname, 'probe-subagents-map-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ hit: !!report.hit, childReadable: report.childReadable ?? null, note: report.note ?? null }, null, 2));
  child.kill();
  process.exit(0);
})();
