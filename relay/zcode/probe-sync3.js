'use strict';

// probe-sync3 — U2.A 分页契约实测（第三轮）：钉死 session/messages 的
//   Q1 {limit:N} 返回方向（升序旧→新 还是 降序新→旧）
//   Q2 {afterMessageId, limit} 窗口语义（cursor-forward 还是 newest-N）
//   Q3 time.created 时间戳粒度（毫秒/秒/同秒平局概率）
//   Q4 混合参数（既 afterMessageId 又 limit）行为
// 写法沿用 probe-sync2：直连真 app-server stdio（不经 relay——探测的是
// app-server 协议事实，companion 转发层不改变形状）。会建一个测试会话并
// 连发 3 个最小回合（"只回复 N"），token 成本可忽略。
// 用法: node probe-sync3.js [--cwd <工作区>] [--turns N]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const CWD = flag('--cwd', process.cwd());
const TURNS = Number(flag('--turns', '3'));

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
    } else {
      pushed.push(f);
      if (f.method && f.id != null) {
        // 反向请求：runtime prefs 代答，其余记下并回绝（本探针不触发工具）
        if (f.method === 'session/requestRuntimePreferences') {
          send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
        } else {
          console.log(`!! 未预期的反向请求: ${f.method} params=${JSON.stringify(f.params).slice(0, 300)}`);
          send({ id: f.id, error: { code: -32601, message: 'probe: unsupported' } });
        }
      }
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c.toString().slice(0, 300)}`));

// ── session/messages 响应 → 精简视图（id/role/created/createdRaw） ──
function briefMessages(resp) {
  if (!resp || resp.__timeout) return { timeout: true };
  if (resp.error) return { error: { code: resp.error.code, msg: String(resp.error.message).slice(0, 200) } };
  const raw = resp.result?.messages;
  if (!Array.isArray(raw)) return { resultKeys: Object.keys(resp.result || {}), messagesNotArray: true };
  return {
    count: raw.length,
    respKeys: Object.keys(resp.result || {}),
    items: raw.map((m) => ({
      id: m?.info?.id ?? null,
      role: m?.info?.role ?? null,
      created: m?.info?.time?.created ?? null,
      textHead: String(m?.parts?.find?.((p) => p?.type === 'text')?.text ?? '').slice(0, 12),
    })),
  };
}

const idsOf = (b) => (b.items || []).map((x) => x.id);

(async () => {
  const report = {};
  try {
    await sleep(600);
    // 新建测试会话
    const create = await request('session/create', {
      workspace: { workspaceKey: CWD.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: CWD },
    });
    const sid = create?.result?.session?.sessionId;
    report.create = { ok: !!sid };
    console.log('created', sid);
    if (!sid) throw new Error('create failed: ' + JSON.stringify(create?.error));

    // 连发最小回合，制造多条消息
    for (var t = 1; t <= TURNS; t++) {
      const send1 = await request('session/send', { sessionId: sid, content: `分页测试第 ${t} 条：请只回复数字 ${t}` });
      if (send1?.error || typeof send1?.result === 'string') {
        report[`send${t}`] = { error: send1?.error ?? send1?.result };
        throw new Error('send failed');
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 60000 && !pushed.some((f) => f.params?.type === 'turn.completed' && f.params?.sessionId === sid)) await sleep(500);
      console.log(`turn ${t} done (${Date.now() - t0}ms)`);
    }
    await sleep(1500);

    // Q0 基准：全量（limit 给大）
    const g0 = briefMessages(await request('session/messages', { sessionId: sid, limit: 1000 }));
    report.groundTruth = g0;
    console.log('G0 all:', g0.count, JSON.stringify(g0.items?.map((x) => `${x.role}:${x.id}:${x.created}:${x.textHead}`)));
    const all = g0.items || [];

    // Q1 方向判定：页内 created 相邻比较
    let asc = 0, desc = 0, tie = 0;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1].created, b = all[i].created;
      if (b > a) asc++; else if (b < a) desc++; else tie++;
    }
    report.q1_pageOrder = { ascendingPairs: asc, descendingPairs: desc, ties: tie,
      verdict: desc > asc ? 'descending(new→old)' : asc > desc ? 'ascending(old→new)' : 'unknown/equal-timestamps' };

    // Q3 时间戳粒度（G0 样本）
    const createdValues = all.map((x) => x.created).filter((v) => v != null);
    report.q3_timestamp = {
      samples: createdValues,
      maxDigits: Math.max(...createdValues.map((v) => String(v).length)),
      granularity: Math.max(...createdValues.map((v) => String(v).length)) >= 12 ? 'milliseconds' : 'seconds-or-less',
      distinctCount: new Set(createdValues).size, total: createdValues.length,
      tiePairs: tie,
    };

    // Q1b limit 截断方向：limit=2 拿到的是头 2 条（最旧）还是尾 2 条（最新）？
    const g1 = briefMessages(await request('session/messages', { sessionId: sid, limit: 2 }));
    report.q1_limit2 = g1;
    const g1ids = idsOf(g1), allIds = idsOf(g0);
    const headIds = allIds.slice(0, g1ids.length).join(), tailIds = allIds.slice(-g1ids.length).join();
    report.q1_limitWindow = {
      limit2Ids: g1ids,
      matchesOldestN: g1ids.join() === headIds,
      matchesNewestN: g1ids.join() === tailIds,
      verdict: g1ids.join() === headIds ? 'oldest-N(first page from start)' : g1ids.join() === tailIds ? 'newest-N(tail)' : 'neither',
    };

    // Q2 窗口语义：afterMessageId=首条，limit 大 → 是"游标之后全部"还是" newest-N"？
    const firstId = allIds[0], midId = allIds[Math.floor(allIds.length / 2)], lastId = allIds[allIds.length - 1];
    const g2 = briefMessages(await request('session/messages', { sessionId: sid, afterMessageId: firstId, limit: 1000 }));
    report.q2_afterFirst = g2;
    report.q2_verdict = {
      afterIds: idsOf(g2),
      equalsAllAfterCursor: idsOf(g2).join() === allIds.slice(1).join(),
      equalsNewestN: g2.count === g0.count,
      verdict: idsOf(g2).join() === allIds.slice(1).join() ? 'cursor-forward(从游标向后取)' : g2.count === g0.count ? 'newest-N(忽略游标)' : 'other',
    };

    // Q4 混合参数：afterMessageId + limit=2 → 游标后前 2 条？还是最新 2 条？
    const g3 = briefMessages(await request('session/messages', { sessionId: sid, afterMessageId: firstId, limit: 2 }));
    report.q4_afterFirstLimit2 = g3;
    const afterIds = allIds.slice(1);
    report.q4_verdict = {
      ids: idsOf(g3),
      equalsFirst2AfterCursor: idsOf(g3).join() === afterIds.slice(0, 2).join(),
      equalsNewest2: idsOf(g3).join() === allIds.slice(-2).join(),
      verdict: idsOf(g3).join() === afterIds.slice(0, 2).join() ? 'cursor-forward+limit(游标后取 limit 条)'
        : idsOf(g3).join() === allIds.slice(-2).join() ? 'newest-N(limit 生效于尾部,游标被忽略/仅过滤)' : 'other',
    };

    // Q2b 游标在中间 + limit 超过剩余量：返回全部剩余还是回卷？
    const g4 = briefMessages(await request('session/messages', { sessionId: sid, afterMessageId: midId, limit: 1000 }));
    report.q2b_afterMid = g4;
    report.q2b_verdict = {
      midId, ids: idsOf(g4),
      equalsRemainder: idsOf(g4).join() === allIds.slice(allIds.indexOf(midId) + 1).join(),
    };

    // Q2c 游标=最后一条：应无新增
    const g5 = briefMessages(await request('session/messages', { sessionId: sid, afterMessageId: lastId, limit: 1000 }));
    report.q2c_afterLast = g5;

    // Q5 边界：不存在的 afterMessageId（Dart 水位失效兜底需要知道行为）
    const g6 = briefMessages(await request('session/messages', { sessionId: sid, afterMessageId: 'msg_nonexistent_zzz', limit: 5 }));
    report.q5_unknownCursor = g6;

    // 收尾：关闭测试会话（close ≠ delete，但状态干净）
    await request('session/close', { sessionId: sid });

    fs.writeFileSync(path.join(__dirname, 'probe-sync3-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== REPORT SAVED probe-sync3-report.json ===');
    console.log('VERDICT q1 order:', JSON.stringify(report.q1_pageOrder), 'limitWindow:', JSON.stringify(report.q1_limitWindow));
    console.log('VERDICT q2:', JSON.stringify(report.q2_verdict));
    console.log('VERDICT q4:', JSON.stringify(report.q4_verdict));
    console.log('VERDICT q3:', JSON.stringify(report.q3_timestamp));
  } finally {
    child.removeAllListeners('exit');
    try { child.stdin.destroy(); } catch {}
    setTimeout(() => child.kill(), 50);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 2500);
  }
})();
