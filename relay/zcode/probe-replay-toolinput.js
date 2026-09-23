'use strict';

// probe-replay-toolinput — 钉死「回合进行中才订阅（= 手机断线重连）时，
// 回放内容里工具输入是否可达」。流程：
//   1) 起会话、发多工具 prompt，但【先不订阅】（模拟手机不在场）；
//   2) 回合进行中（约 20s）才 session/subscribe——拿 result.events 回放；
//   3) 统计回放里 model.streaming tool_input_* 与 tool.updated scheduled
//      的数量与形状，并继续抓订阅后的活流直到回合完成。
// 判定：若回放只给 lifecycle（inputOmitted）不给 tool_input delta，
// 则重连手机必然重放出「输入未捕获」行。
// 用法: node probe-replay-toolinput.js [--delay 20] [--observe 150]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const DELAY = Number(flag('--delay', '20'));
const OBSERVE = Number(flag('--observe', '150'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-rp-'));
console.log('tmp cwd:', TMP);

const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1; const pending = new Map(); let buf = '';
const live = []; // 订阅后收到的活流帧
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
    if (subscribed && f.method) live.push({ t: Date.now(), frame: f });
    if (f.method && f.id != null) {
      const result = f.method === 'session/requestRuntimePreferences'
        ? { nativeSearchEnhancementsEnabled: false }
        : {};
      send({ id: f.id, result });
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[engine] ' + c));

let subscribed = false;

function summarizeEventList(label, events) {
  const stat = { modelStreamingToolInput: 0, modelStreamingOther: 0, toolUpdatedScheduled: 0, toolUpdatedOther: 0, other: 0 };
  for (const ev of events) {
    const t = ev.type;
    const p = ev.payload || {};
    if (t === 'model.streaming' && String(p.kind || '').startsWith('tool_')) stat.modelStreamingToolInput++;
    else if (t === 'model.streaming') stat.modelStreamingOther++;
    else if (t === 'tool.updated' && p.kind === 'scheduled') stat.toolUpdatedScheduled++;
    else if (t === 'tool.updated') stat.toolUpdatedOther++;
    else stat.other++;
  }
  console.log(label, JSON.stringify(stat));
  return stat;
}

async function main() {
  await sleep(1000);
  const created = await request('session/create', {
    workspace: { workspaceKey: 'probe', workspacePath: TMP },
  });
  const sid = created?.result?.session?.sessionId;
  console.log('session:', sid);
  await request('session/resume', { sessionId: sid });

  // 1) 不订阅直接发起回合（手机不在场）
  const prompt = '请依次完成三件事，每件事之间用一句话中文说明：'
    + '1) 用 Bash 执行 echo replay-check；'
    + '2) 用 Read 读取 package.json（不存在先 Bash 写入）；'
    + '3) 用 TodoWrite 写两条待办并标记完成。';
  request('session/send', { sessionId: sid, content: prompt }, OBSERVE * 1000);
  console.log('sent, waiting', DELAY, 's before mid-turn subscribe...');
  await sleep(DELAY * 1000);

  // 2) 回合进行中才订阅 = 手机断线重连
  subscribed = true;
  const sub = await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
  const replay = (sub?.result?.events || []);
  console.log('subscribe ok, eventSeq=', sub?.result?.eventSeq, 'replay events:', replay.length);
  summarizeEventList('replay composition:', replay);
  // 回放里 tool.updated scheduled 是否带 input
  let schedWithInput = 0, schedTotal = 0;
  for (const ev of replay) {
    if (ev.type === 'tool.updated' && (ev.payload || {}).kind === 'scheduled') {
      schedTotal++;
      if ('input' in (ev.payload || {})) schedWithInput++;
    }
  }
  console.log('replay tool.updated/scheduled total=', schedTotal, 'withInput=', schedWithInput);

  // 3) 抓订阅后的活流直到回合完成
  const t0 = Date.now();
  while (Date.now() - t0 < OBSERVE * 1000) {
    await sleep(2000);
    const done = live.some((e) => {
      const p = e.frame.params || {};
      const ev = (p.event && typeof p.event === 'object') ? p.event : p;
      return p.method === 'session/event' && (ev.type === 'turn.completed' || ev.type === 'turn.terminal');
    });
    if (done) break;
  }
  const stat = { modelStreamingToolInput: 0, toolUpdatedScheduled: 0, toolUpdatedResult: 0 };
  for (const e of live) {
    const p = e.frame.params || {};
    if (p.method !== 'session/event') continue;
    const ev = (p.event && typeof p.event === 'object') ? p.event : p;
    const ep = ev.payload || {};
    if (ev.type === 'model.streaming' && String(ep.kind || '').startsWith('tool_')) stat.modelStreamingToolInput++;
    if (ev.type === 'tool.updated' && ep.kind === 'scheduled') stat.toolUpdatedScheduled++;
    if (ev.type === 'tool.updated' && ep.kind === 'result') stat.toolUpdatedResult++;
  }
  console.log('post-subscribe live composition:', JSON.stringify(stat));

  const out = path.join(os.tmpdir(), 'replay-toolinput.json');
  fs.writeFileSync(out, JSON.stringify({ replay, live }, null, 1));
  console.log('dump ->', out);
  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); child.kill(); process.exit(1); });
