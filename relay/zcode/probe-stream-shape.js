'use strict';

// probe-stream-shape — 翻译层词表校准探针：一次性会话里跑一个
// 「思考 + Bash + 读文件 + 总结」回合，按 (params.type, payload.kind)
// 统计 session/event 推送的全谱形状。只记录键名集合与 delta 长度，
// 绝不落正文内容（探针纪律）。
// 用法: node probe-stream-shape.js [--observe 90]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const OBSERVE = Number(flag('--observe', '120'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-probe-shape-'));
console.log('tmp cwd:', TMP);

const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
const child = spawn(process.execPath, [local, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1; const pending = new Map(); let buf = '';
const pushed = [];
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
    pushed.push(f);
    if (f.method && f.id != null) {
      // 反向请求一律拒绝：本探针模式 auto 不应出现权限请求，出现即记录形状
      console.log('!! reverse:', f.method, 'keys:', Object.keys(f.params || {}).join(','));
      send({ id: f.id, error: { code: -32601, message: 'probe-shape: denied' } });
    }
  }
});
child.stderr.on('data', () => {});

(async () => {
  try {
    await sleep(800);
    const create = await request('session/create', {
      workspace: { workspaceKey: TMP.replaceAll('\\', '/').replaceAll('/', '_'), workspacePath: TMP },
    });
    const sid = create?.result?.session?.sessionId;
    console.log('created', sid ? sid.slice(0, 13) : '(fail)');
    if (!sid) throw new Error('create failed');
    await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    await request('session/setMode', { sessionId: sid, mode: 'auto' });
    await sleep(500);

    fs.writeFileSync(path.join(TMP, 'shape-probe.txt'), 'hello-from-probe\n');
    await request('session/send', { sessionId: sid,
      content: '请依次：1) 用 Bash 工具执行 echo shape-probe；2) 用 Read 工具读取 shape-probe.txt；3) 一句话总结两个结果。' });

    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE * 1000) {
      const done = pushed.some((f) => f.method === 'session/event' && f.params?.type === 'turn.completed'
        && f.params?.sessionId === sid);
      if (done) break;
      await sleep(400);
    }
    await sleep(800);

    // (type, kind) 全谱：count + 键名 + delta 长度样本（无正文）
    const shapes = new Map();
    for (const f of pushed) {
      if (f.method !== 'session/event' || f.params?.sessionId !== sid) continue;
      const p = f.params || {}; const pl = p.payload || {};
      const key = `${p.type ?? '?'} / ${pl.kind ?? '(nokind)'}`;
      if (!shapes.has(key)) shapes.set(key, { count: 0, payloadKeys: Object.keys(pl).join(','), deltaLens: [] });
      const s = shapes.get(key); s.count++;
      if (typeof pl.delta === 'string' && pl.delta) s.deltaLens.push(pl.delta.length);
    }
    console.log('\n=== session/event (type / payload.kind) 全谱 ===');
    for (const [k, s] of shapes) {
      console.log(`${k}  count=${s.count}`);
      console.log(`   keys: ${s.payloadKeys}`);
      if (s.deltaLens.length) console.log(`   deltaLens: n=${s.deltaLens.length} first=${s.deltaLens[0]} max=${Math.max(...s.deltaLens)}`);
    }
    // tool.updated 各 kind 的 toolCallId/state 关键键
    const toolKinds = new Map();
    for (const f of pushed) {
      if (f.method !== 'session/event' || f.params?.type !== 'tool.updated') continue;
      const pl = f.params.payload || {};
      const k = pl.kind ?? '(nokind)';
      if (!toolKinds.has(k)) toolKinds.set(k, { n: 0, keys: Object.keys(pl).join(','), hasInput: pl.input !== undefined, status: pl.status });
      toolKinds.get(k).n++;
    }
    console.log('\n=== tool.updated kinds ===');
    for (const [k, s] of toolKinds) console.log(`${k} n=${s.n} status=${s.status} hasInput=${s.hasInput}\n   keys: ${s.keys}`);
  } catch (e) {
    console.error('probe error:', e.message);
  } finally {
    child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
})();
