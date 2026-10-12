'use strict';

// probe-silent-snapshot — 验证无头 runtime（app-server 模式，companion 同款
// 启动方式）是否会在真实回合前后静默打包工作区快照（~/.zcode/v2/checkpoints）。
//
// 背景：2026-09-18 博客核实确认 ZCode 桌面壳（app.asar）内含 RepoSnapshotSidecar
// ——每次 prompt 前 captureBeforePrompt 打 tar.gz + AES-256-CTR + RSA-OAEP 加密
// 上传 zcode.z.ai，无 UI 开关。runtime 侧 zcode.cjs 字符串探针未发现上传实现，
// 但 schema 共享库存在（repo_snapshot_* 构造器），需行为级实验定案。
//
// 方法：一次性临时工作区 + 一个最小真实回合，对比 checkpoints 目录前后差异，
// 按 workspaceKey 精确归因（避免桌面端并发捕获干扰）。
//
// 用法: node probe-silent-snapshot.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelAuth } = require('./companion');

const CHECKPOINTS_DIR = path.join(os.homedir(), '.zcode', 'v2', 'checkpoints');
const RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';
const RUNTIME_PREFERENCES_RESULT = { nativeSearchEnhancementsEnabled: false };

const listCheckpointDirs = () => {
  try { return fs.readdirSync(CHECKPOINTS_DIR); } catch { return []; }
};
const findWorkspaceKeyDirs = (needle) => {
  const hits = [];
  const listJsonFiles = (base) => {
    try { return fs.readdirSync(base, { recursive: true }).filter((f) => f.endsWith('.json')); } catch { return []; }
  };
  for (const dir of listCheckpointDirs()) {
    const base = path.join(CHECKPOINTS_DIR, dir);
    // 新代目录有 state.json+manifests/，老代（eca4dfbef091 之类）是散装 json，统一递归扫
    for (const f of listJsonFiles(base)) {
      try {
        if (fs.readFileSync(path.join(base, f), 'utf8').includes(needle)) { hits.push(dir); break; }
      } catch { /* 跳过不可读文件 */ }
    }
  }
  return hits;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-snap-probe-'));
fs.writeFileSync(path.join(TMP, 'hello.txt'), 'wzxclaw silent-snapshot probe\n');
fs.writeFileSync(path.join(TMP, 'note.md'), '# probe\n临时探针工作区，可随时删除。\n');
console.log('tmp workspace:', TMP);

const beforeDirs = listCheckpointDirs();
console.log('checkpoints before:', beforeDirs.length, 'dirs');

function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

const zc = defaultZcodeCommand();
console.log('runtime:', zc.command, zc.args.join(' '));
const child = spawn(zc.command, [...zc.args, 'app-server', '--cwd', TMP], {
  cwd: TMP, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANTHROPIC_API_KEY: readModelAuth(path.join(os.homedir(), '.zcode/v2/config.json')) },
});

let nextId = 1;
const pending = new Map();
const pushed = [];
const stderrLines = [];
let buffer = '';
const waitForExit = new Promise((r) => child.on('exit', r));

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrLines.push(...c.split('\n')));
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (f.method) pushed.push(f);
    if (f.method && f.id != null) {
      const response = f.method === RUNTIME_PREFERENCES_METHOD
        ? { id: f.id, result: RUNTIME_PREFERENCES_RESULT }
        : { id: f.id, error: { code: -32601, message: 'probe: unhandled reverse request' } };
      try { child.stdin.write(`${JSON.stringify(response)}\n`); } catch { /* 进程已退出 */ }
    } else if (f.id != null && pending.has(f.id)) {
      pending.get(f.id)(f); pending.delete(f.id);
    }
  }
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const request = (method, params, timeoutMs = 20000) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, ...(params ? { params } : {}) });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { code: 'TIMEOUT' } }); } }, timeoutMs);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const create = await request('session/create', { workspace: { workspaceKey: TMP, workspacePath: TMP } });
  const sid = create?.result?.session?.sessionId;
  if (!sid) throw new Error(`session/create 失败: ${JSON.stringify(create).slice(0, 400)}`);
  console.log('session:', sid);
  await request('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });

  console.log('>> 发送最小回合（prompt 前=桌面壳的捕获时机）');
  const t0 = Date.now();
  await request('session/send', { sessionId: sid, content: '只回复两个字母：ok。不要执行任何工具，不要读任何文件。' });

  // 等 turn.completed（经订阅推送帧）
  let completed = false;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !completed) {
    await sleep(2000);
    completed = pushed.some((f) => f.method === 'session/event' && f.params?.type === 'turn.completed'
      && f.params?.sessionId === sid);
    if (completed) break;
    const st = await request('session/read', { sessionId: sid }, 8000).catch(() => null);
    const status = st?.result?.session?.status ?? st?.result?.status;
    if (status && !['running', 'pending'].includes(String(status))) { completed = true; break; }
  }
  console.log(`turn done=${completed} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 留异步打包窗口
  await sleep(20000);
  try { child.kill(); } catch { /* 已退出 */ }
  await Promise.race([waitForExit, sleep(5000)]);

  const afterDirs = listCheckpointDirs();
  const newDirs = afterDirs.filter((d) => !beforeDirs.includes(d));
  const byWorkspaceKey = findWorkspaceKeyDirs(TMP);
  const beforeKeyed = byWorkspaceKey.filter((d) => beforeDirs.includes(d));

  console.log('\n=== 结果 ===');
  console.log('checkpoints after:', afterDirs.length, 'dirs; 新增目录:', newDirs.length ? newDirs.join(',') : '无');
  console.log('workspaceKey 命中临时工作区的目录:', (byWorkspaceKey.length ? byWorkspaceKey.join(',') : '无'));
  if (byWorkspaceKey.length && !beforeKeyed.length) {
    console.log('VERDICT: 无头 runtime 也会静默捕获快照（新目录即证据）');
    for (const d of byWorkspaceKey) {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, d, 'state.json'), 'utf8'));
        console.log(`  ${d} state.json 摘要:`, JSON.stringify({
          workspaceKey: st.workspaceKey, failureCount: st.failureCount,
          hasActiveUpload: !!st.activeUpload, hasPendingUpload: !!st.pendingUpload,
        }));
      } catch { /* 状态文件可能未生成 */ }
    }
  } else if (byWorkspaceKey.length) {
    console.log('VERDICT: 目录为实验前已存在（桌面端所为），实验无新增');
  } else {
    console.log('VERDICT: 无头 runtime 未产生快照捕获（至少本回合内未触发）');
  }
  const errTail = stderrLines.filter(Boolean).slice(-5);
  if (errTail.length) console.log('stderr tail:', errTail.join(' | ').slice(0, 500));
  process.exit(0);
})().catch((e) => {
  console.error('PROBE FAILED:', e.message);
  try { child.kill(); } catch { /* 已退出 */ }
  process.exit(1);
});
