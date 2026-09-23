'use strict';

// probe-toolinput-stream — 钉死「父会话回合里每个工具的输入是否都经
// model.streaming tool_input_* 推送」。手机端「输入未捕获」行的根因定位：
// 若某类工具（Bash/Read/TodoWrite）的 tool_input_start/delta/end 不推送
// 或缺失，流式投影就只能靠 tool.updated scheduled（inputOmitted）造出
// 无输入行。逐帧记录 (source, type/kind, tool, hasInput, assistantId)，
// 不落正文内容（探针纪律：只记键名与长度）。
// 用法: node probe-toolinput-stream.js [--observe 120]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const OBSERVE = Number(flag('--observe', '150'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-ti-'));
console.log('tmp cwd:', TMP);

const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1; const pending = new Map(); let buf = '';
const frames = [];
function send(f) { child.stdin.write(JSON.stringify(f) + '\n'); }
function request(m, p, ms = 30000) {
  const id = nextId++;
  return new Promise((r) => { pending.set(id, r); send({ id, method: m, params: p });
    setTimeout(() => { if (pending.delete(id)) r({ __timeout: true }); }, ms).unref(); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child.stdout.on('data', (c) => {
  buf += c.toString(); let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f && f.id != null && !f.method) { const p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); } continue; }
    frames.push({ t: Date.now(), frame: f });
    if (f.method && f.id != null) {
      // 反向请求代答：runtimePreferences 按官方钉形，其余空 result
      const result = f.method === 'session/requestRuntimePreferences'
        ? { nativeSearchEnhancementsEnabled: false }
        : {};
      send({ id: f.id, result });
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[engine] ' + c));

function describe(f) {
  const m = f.method || '';
  const p = f.params || {};
  if (m === 'session/event') {
    const ev = (p.event && typeof p.event === 'object') ? p.event : p;
    const ep = ev.payload || {};
    const t = ev.type;
    if (t === 'model.streaming') {
      const kind = ep.kind || '-';
      const isTool = kind.startsWith('tool_');
      return ['mstream', kind, ep.toolName || '-', isTool ? ('input' in ep) : '-',
        (ep.assistantMessageId || '').slice(-6), (ep.delta || '').length];
    }
    if (t === 'tool.updated') {
      return ['sevent', 'tool.updated/' + (ep.kind || '-'), ep.toolName || '-',
        'input' in ep, (ep.assistantMessageId || '').slice(-6), '-'];
    }
    return ['sevent', t, '-', '-', '-', '-'];
  }
  if (m === 'v4/telemetry/event') {
    if (p.kind === 'tool.lifecycle') {
      return ['tel', p.phase, p.toolName || '-', 'input' in p, (p.assistantMessageId || '').slice(-6), '-'];
    }
    return ['tel', p.kind || '-', '-', '-', '-', '-'];
  }
  return [m || 'notify', '-', '-', '-', '-', '-'];
}

async function main() {
  await sleep(1000);
  const created = await request('session/create', {
    workspace: { workspaceKey: 'probe', workspacePath: TMP },
  });
  const sid = created?.result?.session?.sessionId;
  console.log('session:', sid);
  await request('session/resume', { sessionId: sid });
  const sub = await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
  console.log('subscribed, snapshot events:', (sub?.result?.events || []).length);
  frames.length = 0;

  const prompt = '请依次完成三件事，每件事之间用一句话中文说明：'
    + '1) 用 Bash 执行 echo hello-toolinput；'
    + '2) 用 Read 读取 package.json 的前 3 行（若不存在则用 Bash 写入一个）；'
    + '3) 用 TodoWrite 写入两条待办（读取、汇报）并标记完成。';
  request('session/send', { sessionId: sid, content: prompt }, OBSERVE * 1000);

  const t0 = Date.now();
  while (Date.now() - t0 < OBSERVE * 1000) {
    await sleep(2000);
    const done = frames.some((e) => {
      const p = e.frame.params || {};
      const ev = (p.event && typeof p.event === 'object') ? p.event : p;
      return (p.method === 'session/event' || p.type === 'session/event') &&
        (ev.type === 'turn.completed' || ev.type === 'turn.terminal');
    });
    if (done) break;
  }

  console.log('\n=== frame timeline (tool-relevant + boundary) ===');
  for (const e of frames) {
    const d = describe(e.frame);
    const interesting = d[1].includes('tool') || d[0] === 'mstream' ||
      d[1].includes('turn.') || d[1] === 'tool.updated';
    if (!interesting) continue;
    console.log(
      String(e.t - t0).padStart(6) + 'ms',
      d[0].padEnd(7), String(d[1]).padEnd(28), 'tool=' + String(d[2]).padEnd(10),
      'hasInput=' + String(d[3]).padEnd(5), 'asst=…' + d[4], 'deltaLen=' + d[5]);
  }

  const out = path.join(os.tmpdir(), 'toolinput-stream.json');
  fs.writeFileSync(out, JSON.stringify(frames, null, 1));
  console.log('\nfull dump ->', out);
  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); child.kill(); process.exit(1); });
