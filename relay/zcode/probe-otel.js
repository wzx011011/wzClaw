'use strict';

// probe-otel — 验证 zcode app-server 的原生 OTel LLM 埋点：
//   本地起一个假 OTLP/HTTP 接收端（记录全部 POST 体），带 OTEL_EXPORTER_OTLP_*
//   环境变量 spawn `zcode app-server`，驱动一个最小回合（"只回复 ok"），
//   检查 /v1/traces 是否收到 protobuf（含 gen_ai.* 属性字符串）。
//   结论用于判断"zcode → Langfuse OTLP 接入"是否零改动可行。
// 用法: node probe-otel.js [--observe <秒>]（回合结束后额外等待导出的时间）

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const OBSERVE_SEC = Number(flag('--observe', '10'));
const SINK_PORT = Number(flag('--port', '4319'));

// ── 假 OTLP 接收端 ────────────────────────────────────
const captured = []; // { path, headers, size, body }
const sink = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    captured.push({ path: req.url, auth: req.headers.authorization || '', size: body.length, body });
    console.log(`[sink] POST ${req.url} bytes=${body.length} content-type=${req.headers['content-type'] || ''}`);
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end(Buffer.alloc(0)); // ExportTraceServiceResponse（空消息）
  });
});

// ── app-server 子进程 ─────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-otel-'));
const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const zc = fs.existsSync(local)
  ? { command: process.execPath, args: [local] }
  : { command: 'zcode', args: [] };

const otelEnv = {
  ...(args.includes('--explicit-traces') ? {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${SINK_PORT}/v1/traces`,
  } : {}),
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${SINK_PORT}`,
  OTEL_SERVICE_NAME: 'zcode-otel-probe',
  OTEL_BSP_SCHEDULE_DELAY: '500', // 导出批间隔压到 0.5s，缩短探测等待
  OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '4', // 小批量：span 一结束就能凑满一批发出去
  ...(args.includes('--debug') ? { OTEL_LOG_LEVEL: 'debug' } : {}),
  ...(args.includes('--model-otel') ? { ZCODE_MODEL_TELEMETRY_ENABLED: 'true' } : {}),
  NO_PROXY: '127.0.0.1,localhost',
};

const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')),
    ...otelEnv,
  },
});
console.log('tmp cwd:', TMP);
console.log('otel env:', JSON.stringify(otelEnv));

let nextId = 1;
const pending = new Map();
let buffer = '';
const events = [];

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
  setTimeout(() => { if (pending.delete(id)) resolve({ __timeout: true, method }); }, 30000).unref();
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f.id != null && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); }
    if (f.method === 'session/event') events.push(f.params?.type);
    if (f.method && f.id != null) {
      // 反向请求：运行时偏好代答，其余一概拒绝（纯文本回合不应出现权限请求）
      if (f.method === 'session/requestRuntimePreferences') {
        send({ id: f.id, result: { nativeSearchEnhancementsEnabled: false } });
      } else {
        send({ id: f.id, error: { code: -32000, message: 'probe: capture-only' } });
      }
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => { const s = c.trim(); if (s) console.log('[stderr]', s.slice(0, 300)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (pred, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const i = events.findIndex(pred);
    if (i !== -1) return resolve(i);
    if (Date.now() - t0 > ms) return resolve(-1);
    setTimeout(tick, 200);
  };
  tick();
});

(async () => {
  const report = { otelEnv, captured: [] };
  try {
    sink.listen(SINK_PORT, '127.0.0.1');
    await sleep(3000); // 等遥测运行时初始化（device mid 异步解析）

    const create = await request('session/create', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    if (!sid) throw new Error('create failed: ' + JSON.stringify(create?.error || create));
    await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    console.log('session:', sid);

    console.log('sending minimal turn…');
    await request('session/send', { sessionId: sid, content: '协议探测：请只回复 ok' });
    const doneIdx = await waitFor((t) => t === 'turn.completed', 180000);
    report.turn = doneIdx !== -1 ? 'completed' : 'timeout';
    console.log('turn:', report.turn, 'events:', events.join(','));

    // 等 BSP 批量导出
    console.log(`waiting ${OBSERVE_SEC}s for batch export…`);
    await sleep(OBSERVE_SEC * 1000);
    await request('session/close', { sessionId: sid });
    await sleep(15000); // close 后 span 级联结束，再等一轮导出

    // 从 protobuf 体里抠可读字符串（span 名 / gen_ai.* 属性键都在明文区；
    // body 可能 gzip 压缩——先解压再抠）。原始体落盘供离线分析。
    const zlib = require('node:zlib');
    const strings = new Set();
    captured.forEach((cap, i) => {
      fs.writeFileSync(path.join(os.tmpdir(), `zcode-probe-otel-${i}.bin`), cap.body);
      let body = cap.body;
      if (cap.body[0] === 0x1f && cap.body[1] === 0x8b) {
        try { body = zlib.gunzipSync(cap.body); cap.gzipped = true; } catch { /* 保留原体 */ }
      }
      const s = body.toString('latin1').match(/[\x20-\x7e]{6,}/g) || [];
      for (const x of s) strings.add(x);
    });
    report.captured = captured.map((c) => ({ path: c.path, authHeader: c.auth ? '(present)' : '(none)', size: c.size }));
    report.strings = [...strings].filter((x) =>
      /gen_ai|zcode|session|turn|chat|model|token|prompt|completion|tool|agent/i.test(x)).slice(0, 60);
    fs.writeFileSync(path.join(__dirname, 'probe-otel-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== 结论 ===');
    console.log('OTLP 请求数:', captured.length);
    console.log('可读字符串样本:', JSON.stringify(report.strings, null, 2));
  } finally {
    child.kill();
    // sink 多开 5s：接住 SDK 关停时的 flush
    await sleep(5000);
    sink.close();
    setTimeout(() => process.exit(0), 500);
  }
})().catch((e) => { console.error('probe failed:', e.message); child.kill(); sink.close(); setTimeout(() => process.exit(1), 500); });
