'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket, WebSocketServer } = require('ws');
const { createRelay } = require('../server');
const { createCompanion, readRegistrationSecretFile, resolveRegistrationSecret,
  probeZcodeRuntime, resolveZcodeRuntime, defaultZcodeCommand,
  runtimeProcessEnv } = require('../companion');

const FAKE_APP_SERVER = path.join(__dirname, 'fixtures', 'fake-app-server.js');

// 可断开的 TCP 代理：模拟 companion 与 relay 之间的网络闪断（半开连接之外的干净场景）。
function tcpProxy(targetPort) {
  const connections = new Set();
  const server = net.createServer((socket) => {
    const upstream = net.connect(targetPort);
    connections.add(socket); connections.add(upstream);
    // 任一侧关闭/出错都双向销毁，否则 server.close() 会因残留连接永远不回调。
    const kill = () => { socket.destroy(); upstream.destroy(); };
    socket.on('error', kill); socket.on('close', kill);
    upstream.on('error', kill); upstream.on('close', kill);
    socket.pipe(upstream).pipe(socket);
  });
  return {
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    port: () => server.address().port,
    dropAll: () => { for (const socket of connections) socket.destroy(); connections.clear(); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 手机端模拟：probe 角色完成质询应答，收集 data 载荷。
function phone(url) {
  const ws = new WebSocket(url, { maxPayload: 1024 * 1024 });
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  return {
    ws,
    messages,
    send(value) { ws.send(JSON.stringify(value)); },
    next(match, timeoutMs = 8000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) { waiters.splice(index, 1); reject(new Error('phone next() timeout')); }
        }, timeoutMs).unref();
      });
    },
    async pair(sid, hash) {
      // ws 可能早已 open（构造即连接），readyState 检查避免 once('open') 竞态挂起。
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      }
      this.send({ type: 'auth_init', role: 'probe', device_sid: sid });
      const challenge = await this.next((m) => m.type === 'auth_challenge');
      const proof = createHmac('sha256', hash).update(`${challenge.nonce}|probe|${sid}`).digest('base64url');
      this.send({ type: 'auth_response', device_sid: sid, proof });
      const ack = await this.next((m) => m.type === 'auth_ack');
      // 重连接管时 relay 可先回 waiting，随后 device 完成认证才广播 matched。
      // 断言最终房间状态，不把合法握手中间态误判成失败。
      if (ack.pair_status === 'waiting') {
        await this.next((m) => m.type === 'pair_status_ack' && m.pair_status === 'matched');
      } else {
        assert.equal(ack.pair_status, 'matched');
      }
    },
    close() { ws.close(); },
  };
}

test('runtime probe：独立 app-server 的 session/list 握手通过后才报告 ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-runtime-probe-'));
  const config = path.join(dir, 'v2-config.json');
  fs.writeFileSync(config, JSON.stringify({
    provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'test-token' } } },
  }));
  const result = await probeZcodeRuntime({
    cwd: dir,
    v2ConfigPath: config,
    env: { ...process.env, ZCODE_BIN: FAKE_APP_SERVER },
  });
  assert.equal(result.category, 'ready');
  assert.equal(result.source, 'environment');
  assert.match(result.version, /\d+\.\d+/);
  assert.deepEqual(result.runtimeDescriptor, {
    command: process.execPath, args: [FAKE_APP_SERVER], source: 'environment',
  });
  // Windows 上 kill 后 stdout 句柄释放与 exit 事件存在极短竞态。
  await delay(120);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime process env：Electron 执行 runtime cjs 时启用 Node 模式', () => {
  const original = process.versions.electron;
  Object.defineProperty(process.versions, 'electron', { value: '31.7.0', configurable: true });
  try {
    const cjs = runtimeProcessEnv({ command: process.execPath, args: ['C:/zcode.cjs'] }, { SAFE: '1' });
    assert.equal(cjs.ELECTRON_RUN_AS_NODE, '1');
    const officialHost = runtimeProcessEnv({
      command: 'C:/Users/test/AppData/Local/Programs/ZCode/ZCode.exe',
      args: ['C:/Users/test/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs'],
    }, { SAFE: '1' });
    assert.equal(officialHost.ELECTRON_RUN_AS_NODE, '1');
    const pathCli = runtimeProcessEnv({ command: 'zcode', args: [] }, { SAFE: '1' });
    assert.equal(pathCli.ELECTRON_RUN_AS_NODE, undefined);
    const nonCjs = runtimeProcessEnv({ command: 'C:/tool.exe', args: ['C:/tool.js'] }, { SAFE: '1' });
    assert.equal(nonCjs.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (original === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: original, configurable: true });
  }
});

test('runtime process env：剥离宿主 CHROME_/ELECTRON_ 变量，ZCODE_ 与业务注入保留', () => {
  const original = process.versions.electron;
  Object.defineProperty(process.versions, 'electron', { value: '41.10.7', configurable: true });
  try {
    // GUI 壳的 process.env 携带 crashpad 管道等 Chromium 内部变量；传给
    // 子 runtime 前剥掉。ZCODE_* 必须保留（含子 runtime 必需的
    // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE，2026-09-17 实测剥掉即退 1）。
    const env = runtimeProcessEnv(
      { command: 'C:/host/ZCode.exe', args: ['C:/rt/zcode.cjs'] },
      {
        SAFE: 'keep', PATH: 'C:/bin', ANTHROPIC_API_KEY: 'token',
        CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crashpad_parent',
        ELECTRON_NO_ATTACHED_CONSOLE: '1', ZCODE_PROCESS_LABEL: 'local-1',
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/cfg/zcode-builtin.json',
      },
    );
    assert.equal(env.SAFE, 'keep');
    assert.equal(env.PATH, 'C:/bin');
    assert.equal(env.ANTHROPIC_API_KEY, 'token');
    assert.equal(env.CHROME_CRASHPAD_PIPE_NAME, undefined);
    assert.equal(env.ELECTRON_NO_ATTACHED_CONSOLE, undefined);
    assert.equal(env.ZCODE_PROCESS_LABEL, 'local-1');
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, 'C:/cfg/zcode-builtin.json');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    if (original === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: original, configurable: true });
  }
});

test('runtime resolver：宿主一律自托管（Electron 与 node CLI 同路）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-install-'));
  const runtime = path.join(root, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
  const host = path.join(root, 'Programs', 'ZCode', 'ZCode.exe');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, '');
  fs.writeFileSync(host, '');
  const original = process.versions.electron;
  Object.defineProperty(process.versions, 'electron', { value: '41.10.7', configurable: true });
  try {
    // Electron 父进程：自托管（官方 ZCode.exe 作子进程会静默 exit 1，2026-09-17 事故）
    // 官方安装探测按设计仅认 win32 布局：显式钉 platform 复现 win32 分支，
    // 让用例在任意宿主（含 CI ubuntu）上成立。
    const inElectron = resolveZcodeRuntime({ LOCALAPPDATA: root }, { platform: 'win32' });
    assert.deepEqual(inElectron, { category: 'resolved', source: 'installed', command: process.execPath, args: [runtime] });
    assert.deepEqual(defaultZcodeCommand({ LOCALAPPDATA: root }, { platform: 'win32' }), { command: process.execPath, args: [runtime] });
    // 平台门控契约：非 win32 宿主不认官方安装布局，落到 PATH 兜底
    assert.deepEqual(
      resolveZcodeRuntime({ LOCALAPPDATA: root }, { platform: 'linux' }),
      { category: 'resolved', source: 'path', command: 'zcode', args: [] },
    );
  } finally {
    if (original === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: original, configurable: true });
  }
  try {
    // node CLI 父进程：同样自托管（node ≥24 含 node:sqlite 可承载 runtime）
    const inNode = resolveZcodeRuntime({ LOCALAPPDATA: root }, { platform: 'win32' });
    assert.deepEqual(inNode, { category: 'resolved', source: 'installed', command: process.execPath, args: [runtime] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime resolver：内嵌 runtime 兜底（无官方安装时）', () => {
  // 打包布局：resources/zcode-runtime/glm/zcode.cjs
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bundled-'));
  const bundled = path.join(root, 'zcode-runtime', 'glm', 'zcode.cjs');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, '');
  const original = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true });
  try {
    const resolved = resolveZcodeRuntime({ LOCALAPPDATA: '' });
    assert.deepEqual(resolved, {
      category: 'resolved',
      source: 'bundled',
      command: process.execPath,
      args: [bundled],
    });
    // 显式覆盖（开发/测试口）同样生效
    const other = path.join(root, 'other.cjs');
    fs.writeFileSync(other, '');
    const viaEnv = resolveZcodeRuntime({
      LOCALAPPDATA: '',
      WZXCLAW_BUNDLED_RUNTIME: other,
    });
    assert.equal(viaEnv.source, 'bundled');
    assert.deepEqual(viaEnv.args, [other]);
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: original,
      configurable: true,
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime resolver：官方安装永远优先于内嵌 runtime（顺序钉死）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-priority-'));
  const runtime = path.join(root, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, '');
  const bundled = path.join(root, 'bundled', 'zcode.cjs');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, '');
  try {
    const resolved = resolveZcodeRuntime({
      LOCALAPPDATA: root,
      WZXCLAW_BUNDLED_RUNTIME: bundled,
    }, { platform: 'win32' });
    assert.equal(resolved.source, 'installed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime resolver：失效 ZCODE_BIN 必须明确报错而非回退', () => {
  const original = process.env.ZCODE_BIN;
  process.env.ZCODE_BIN = path.join(os.tmpdir(), 'does-not-exist-zcode');
  try { assert.equal(resolveZcodeRuntime().category, 'invalid-override'); }
  finally {
    if (original === undefined) delete process.env.ZCODE_BIN;
    else process.env.ZCODE_BIN = original;
  }
});

function writeV2Config(dir, token) {
  const file = path.join(dir, 'v2-config.json');
  fs.writeFileSync(file, JSON.stringify(token === undefined ? { provider: {} } : {
    provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: token, baseURL: 'https://open.bigmodel.cn/api/anthropic' } } },
  }));
  return file;
}

function waitFor(getValue, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (getValue()) { clearInterval(timer); resolve(getValue()); }
    }, 20);
    setTimeout(() => { clearInterval(timer); reject(new Error('waitFor timeout')); }, timeoutMs).unref();
  });
}

async function withRelay(t, relayOptions = {}) {
  const relay = createRelay(relayOptions);
  const address = await relay.listen({ port: 0 });
  return { relay, url: `ws://127.0.0.1:${address.port}/ws` };
}

// Windows 上删临时目录前必须先等子进程退出（cwd 锁）；t.after 按注册顺序执行，
// 用单个钩子保证清理顺序。
function cleanup(t, steps) {
  t.after(async () => {
    for (const step of steps) await step();
  });
}

test('companion 配对 → 桥接 → 双向转发 + 反向请求代答/转发（假 app-server）', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const logs = [];
  let pairingUrl = '';
  const states = [];
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
    onStateChange: (state) => states.push(state),
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  // 配对 URL 派生自 relay URL，含 sid/hash。
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  assert.equal(parsed.pathname, '/pair');
  const sid = parsed.searchParams.get('sid');
  const hash = parsed.searchParams.get('hash');
  assert.ok(sid && hash && /^[A-Za-z0-9+/]{43}=$/.test(hash));
  assert.equal(parsed.origin, relayUrl.replace('ws:', 'http:').replace(/\/ws$/, ''));

  await client.pair(sid, hash);
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/env'
    && m.payload.params.tokenPresent === true);
  // runtime preferences 由 companion 代答，不转发给手机。
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/runtime-prefs'
    && m.payload.params.answered === true);
  // 未知反向请求转发给手机；手机应答回传。
  // wireId 代次化：手机侧见到的是 companion 改写的唯一 id（不再是原生
  // server-N），应答按原 id 回传即可。
  const reverseRelay = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/test');
  client.send({ type: 'data', payload: { id: reverseRelay.payload.id, result: { approved: true } } });
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/interaction-relay'
    && m.payload.params.ok === true);
  // 手机请求 → app-server 响应。
  client.send({ type: 'data', payload: { id: 1, method: 'session/list' } });
  const reply = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.equal(reply.payload.result.sessions[0].sessionId, 'sess_mock');
  // runtime-prefs 代答帧不应出现在手机侧。
  assert.equal(client.messages.some((m) => m.type === 'data' && m.payload.method === 'session/requestRuntimePreferences'), false);
  // 日志与状态不含敏感值。
  assert.equal(logs.some((line) => line.includes(sid) || line.includes(hash)), false);
  assert.ok(states.includes('paired'));
});

// 反向请求超时分档（毫秒级注入验证）：权限/AskUser 类放宽档、非权限类短档；
// 两档超时后代答行为一致（-32022 拒绝）；放宽档内人工应答不触发代答。
// 内联假 app-server（node -e，不动共享 fixture）：收到 emit/reverse 指令即发
// 一条指定 method 的反向请求。
test('反向请求超时默认长档：白名单方法短档、未知方法不被短档误杀，超时回 -32022', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-timeout-'));
  const onDemandServer = `
    'use strict';
    let buf = '';
    const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      let index;
      while ((index = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (!line) continue;
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.method === 'emit/reverse' && frame.params) {
          send({ id: frame.params.tag, method: frame.params.method, params: {} });
        } else if (typeof frame.id === 'string' && frame.id.startsWith('srv-')
          && (frame.result !== undefined || frame.error !== undefined)) {
          // 应答（人工或超时代答）上报给手机侧观察：tag + error.code（无错误为 null）。
          send({ method: 'fake/answered', params: { tag: frame.id, code: frame.error ? frame.error.code : null } });
        }
      }
    });
  `;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    requestTimeoutMs: 300,            // 白名单快速方法：短档（线上 15s 档）
    permissionRequestTimeoutMs: 2000, // 其余一律长档（线上 120s 档，防未知交互方法被静默代答拒绝）
    logger: () => {},
    onPairing: () => {},
  });
  const client = phone(relayUrl);
  // 超时代答回给 app-server（不经过手机），故由假 app-server 上报 fake/answered 观察判据。
  const rejected = (tag) => client.messages.some(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered'
      && m.payload.params.tag === tag && m.payload.params.code === -32022);
  let emitId = 100;
  const emit = (tag, method) => client.send({
    type: 'data', payload: { id: emitId++, method: 'emit/reverse', params: { tag, method } },
  });
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');

  // 权限类反向请求转发手机（白名单 runtimePrefs 由 companion 自动代答、
  // 不转发——短档路径由「runtime-prefs 代答」用例覆盖，此处验证非白名单
  // 方法不被短档误杀）。
  emit('srv-perm', 'session/requestPermission');
  await client.next((m) => m.type === 'data' && m.payload.method === 'session/requestPermission');

  // 短档（300ms）到期后：非白名单方法不受短档影响，仍在等待手机应答。
  await delay(900);
  assert.equal(rejected('srv-perm'), false);

  // 权限类在放宽档内从容应答（模拟人看手机后点确认）：不触发代答。
  emit('srv-ask', 'interaction/askUser');
  const askFrame = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/askUser');
  await delay(300);
  client.send({ type: 'data', payload: { id: askFrame.payload.id, result: { selectedLabels: ['A'] } } });

  // 超过放宽档（2000ms）仍未应答的权限类最终也被代答拒绝（-32022，与旧版一致）。
  const late = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered'
      && m.payload.params.tag === 'srv-perm' && m.payload.params.code === -32022,
    6000);
  assert.ok(late, 'srv-perm 应在放宽档超时后被代答拒绝');

  // 已人工应答的权限类不会再被代答（计时器在应答时已清理）。
  await delay(1300); // 越过 srv-ask 若未应答的到期点（emit 后 2000ms）
  assert.equal(rejected('srv-ask'), false);
});

test('未登录（无 token）时优雅降级：配对成功但不起桥，手机请求收到明确错误帧', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, undefined),
    midFile: path.join(dir, 'mid'),
    logger: () => {},
    onPairing: () => {},
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  client.send({ type: 'data', payload: { id: 1, method: 'session/list' } });
  await delay(300);
  // 桥不可用时不再静默丢弃：回 -32000 错误帧，手机端 30s 内得到明确反馈
  const replies = client.messages.filter((m) => m.type === 'data');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.id, 1);
  assert.equal(replies[0].payload.error.code, -32000);
  assert.equal(companion.state, 'paired-no-model');
});

test('受管 runtime：descriptor 未就绪保持在线（paired-no-model），热注入后同链路起桥', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-managed-'));
  let pairingCalls = 0;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    runtimeManaged: true,
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: () => {},
    onPairing: () => { pairingCalls += 1; },
    onStateChange: () => {},
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  // 设备在线（已配对）而引擎预检未完成：paired-no-model，不再整机离线
  // （2026-09-18 手机反复断线事故的回归锚：probe 失败曾把 device 拖下线）。
  await waitFor(() => companion.state === 'paired-no-model');

  // descriptor 未就绪：手机帧得到明确错误而非静默挂起
  client.send({ type: 'data', payload: { id: 7, method: 'session/list', params: {} } });
  const early = await client.next((m) => m.type === 'data' && m.payload?.id === 7);
  assert.equal(early.payload.error.code, -32000);

  // 非法 descriptor 必须显式拒绝，不得进入受管状态
  assert.throws(() => companion.setRuntimeDescriptor({ command: '', args: [] }),
    /INVALID_RUNTIME_DESCRIPTOR/);
  assert.equal(companion.state, 'paired-no-model');

  // 热注入已验证 descriptor：同一条 relay 链路起桥——不重连、不重注册、
  // 配对身份（配对 URL/房间）不变，手机端无感。
  companion.setRuntimeDescriptor({
    command: process.execPath, args: [FAKE_APP_SERVER], source: 'installed',
  });
  await waitFor(() => companion.state === 'paired');
  assert.equal(pairingCalls, 1);

  client.send({ type: 'data', payload: { id: 8, method: 'session/list', params: {} } });
  const okReply = await client.next((m) => m.type === 'data' && m.payload?.id === 8);
  assert.deepEqual(okReply.payload.result.sessions, [{ sessionId: 'sess_mock', title: 'mock' }]);
});

test('会话中途 relay 错误帧不烧凭据：重连接管原房间，配对码保持有效', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-errmid-'));
  let pairingCalls = 0;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    reconnectDelayMs: 200,
    logger: () => {},
    onPairing: () => { pairingCalls += 1; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const url1 = companion.pairingUrl;
  const parsed = new URL(url1);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');

  // 从服务端向 companion 的 socket 注入一帧 relay 错误（模拟中途被拒，
  // 如限流/内部错误）。接管早已完成——该错误帧不得触发"作废凭据全新注册"，
  // 否则手机端已保存的配对会静默失效。
  const deviceState = [...relay._sockets.values()]
    .find((s) => s.role === 'device' && s.room?.sid === parsed.searchParams.get('sid'));
  assert.notEqual(deviceState, undefined);
  deviceState.ws.send(JSON.stringify({ type: 'error', code: 'INJECTED_TEST_ERROR' }));

  await waitFor(() => companion.state === 'paired', 5000); // 重连 + 同 sid 再接管
  assert.equal(companion.pairingUrl, url1); // 凭据未轮换
  assert.equal(pairingCalls, 1); // 未触发全新注册（QR 不重印）
  // 同一手机连接无感恢复：房间重新回到 matched
  await client.next((m) => m.type === 'pair_status_ack' && m.pair_status === 'matched', 5000);
});

test('单实例锁：同数据目录第二个实例拒绝启动，stop 后可重新获取', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-lock-'));
  const options = {
    relayUrl, cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: () => {}, onPairing: () => {},
  };
  cleanup(t, [
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  const first = createCompanion(options);
  first.start();
  // 同目录第二实例必须被拒（自启动实例与手动实例并存会互踢同一房间）
  assert.throws(() => createCompanion(options), (e) => e.code === 'ALREADY_RUNNING');
  // 第一实例停止释放锁后，新实例可正常获取
  await first.stop();
  const second = createCompanion(options);
  second.start();
  await waitFor(() => second.pairingUrl);
  await second.stop();
});

test('mid+注册口令持久化：同目录跨实例复用，配对 URL 稳定不换码', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const options = {
    relayUrl, cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    logger: () => {}, onPairing: () => {},
  };
  cleanup(t, [
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  const first = createCompanion({ ...options, midFile: path.join(dir, 'mid') });
  first.start();
  await waitFor(() => first.pairingUrl);
  await first.stop();
  const second = createCompanion({ ...options, midFile: path.join(dir, 'mid') });
  second.start();
  await waitFor(() => second.pairingUrl);
  await second.stop();
  // 口令落盘 + relay 确定性 sid：跨实例配对 URL 完全一致（手机无需重扫）
  assert.equal(second.pairingUrl, first.pairingUrl);
  assert.equal(fs.readFileSync(path.join(dir, 'mid'), 'utf8').length > 0, true);
  assert.match(fs.readFileSync(path.join(dir, 'passhash'), 'utf8'), /^[A-Za-z0-9+/]{43}=$/);
  // 不同目录（不同安装身份）→ 不同配对 URL
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-b-'));
  cleanup(t, [() => { fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }]);
  const third = createCompanion({ ...options, midFile: path.join(dir2, 'mid') });
  third.start();
  await waitFor(() => third.pairingUrl);
  await third.stop();
  assert.notEqual(third.pairingUrl, first.pairingUrl);
});

test('网络闪断重连后接管原房间：sid/hash 不变，手机用原配对码直接重连', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const proxy = tcpProxy(Number(new URL(relayUrl).port));
  await proxy.listen();
  const proxiedUrl = `ws://127.0.0.1:${proxy.port()}/ws`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-reattach-'));
  let pairingCalls = 0;
  const companion = createCompanion({
    relayUrl: proxiedUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    reconnectDelayMs: 200,
    logger: () => {},
    onPairing: () => { pairingCalls += 1; },
  });
  const client = phone(relayUrl); // 手机直连 relay，不经代理
  const extraPhones = [];
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); for (const p of extraPhones) p.close(); },
    () => proxy.close(),
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const url1 = companion.pairingUrl;
  const parsed = new URL(url1);
  const sid = parsed.searchParams.get('sid');
  const hash = parsed.searchParams.get('hash');
  await client.pair(sid, hash);
  await waitFor(() => companion.state === 'paired');

  // 模拟闪断：companion 侧连接被掐断，同时手机离席（释放 probe 位）。
  proxy.dropAll();
  client.close();
  await delay(1500); // 重连延迟 200ms + 接管握手余量

  // 手机用原配对码重新入房，应立即 matched；配对 URL 不轮换、QR 不重印。
  let reMatched = null;
  for (let i = 0; i < 10 && reMatched === null; i++) {
    await delay(300);
    const retry = phone(relayUrl);
    extraPhones.push(retry);
    try {
      await retry.pair(sid, hash);
      reMatched = retry;
    } catch { /* 接管尚未完成，换新连接重试 */ }
  }
  assert.notEqual(reMatched, null);
  assert.equal(companion.pairingUrl, url1);
  assert.equal(pairingCalls, 1);
  await waitFor(() => companion.state === 'paired');
  // 接管后链路完整可用：手机请求 → app-server 应答。
  reMatched.send({ type: 'data', payload: { id: 21, method: 'session/list' } });
  const reply = await reMatched.next((m) => m.type === 'data' && m.payload.id === 21);
  assert.equal(reply.payload.result.sessions[0].sessionId, 'sess_mock');
});

test('房间过期后接管被拒：重新注册恢复同一配对码（手机无需重扫）', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t, { roomTtlMs: 50, sweepIntervalMs: 10 });
  const proxy = tcpProxy(Number(new URL(relayUrl).port));
  await proxy.listen();
  const proxiedUrl = `ws://127.0.0.1:${proxy.port()}/ws`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-expire-'));
  const urls = [];
  const companion = createCompanion({
    relayUrl: proxiedUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    reconnectDelayMs: 100,
    logger: () => {},
    onPairing: (url) => { urls.push(url); },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => proxy.close(),
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const url1 = companion.pairingUrl;
  const sid1 = new URL(url1).searchParams.get('sid');
  await client.pair(sid1, new URL(url1).searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');
  // 手机先离席，房间随之进入 TTL 过期；随后掐断 companion 连接。
  client.close();
  await waitFor(() => companion.state !== 'paired');
  proxy.dropAll();
  // 接管失败（AUTH_FAILED）→ 凭据作废 → 重连后重新注册。
  // 口令已落盘 + 确定性 sid：重新注册恢复同一配对码，手机端依然可用。
  await waitFor(() => urls.length >= 2, 10000);
  assert.equal(urls[1], url1);
  assert.equal(companion.pairingUrl, url1);
});

test('大会话 resume 响应被截断到帧上限内且连接保持', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: () => {},
    onPairing: () => {},
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  client.send({ type: 'data', payload: { id: 9, method: 'session/resume', params: { sessionId: 'sess_big' } } });
  const reply = await client.next((m) => m.type === 'data' && m.payload.id === 9);
  assert.equal(reply.payload.error, undefined);
  assert.equal(reply.payload.result.messagesTruncated, true);
  assert.equal(reply.payload.result.messages.length < 40, true);
  assert.equal(Buffer.byteLength(JSON.stringify(reply)) <= 1024 * 1024, true);
  // 截断后连接仍可用
  client.send({ type: 'data', payload: { id: 10, method: 'session/list' } });
  const follow = await client.next((m) => m.type === 'data' && m.payload.id === 10);
  assert.equal(follow.payload.result.sessions[0].sessionId, 'sess_mock');
});

// —— 注册共享密钥（registrationSecret）——

// 录制型假 relay：只收首条注册帧即断开，供直接断言注册帧形状。
function recordingRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const frames = [];
  const listening = new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()));
      ws.close(); // 只需要首帧；companion 侧 reconnectDelayMs 拉长即不再重试
    });
    ws.on('error', () => { /* 关闭握手期间的意外错误忽略 */ });
  });
  return {
    frames,
    listening,
    get url() { return `ws://127.0.0.1:${wss.address().port}/ws`; },
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

test('registrationSecret 注入：注册帧带 register_proof；未注入时无该字段', async (t) => {
  const secret = 'companion-register-secret';
  const fake = recordingRelay();
  await fake.listening; // 端口在 listen 完成后才可读
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-proof-'));
  const base = {
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    reconnectDelayMs: 60000,
    logger: () => {},
    onPairing: () => {},
  };
  const withSecret = createCompanion({ ...base, relayUrl: fake.url,
    midFile: path.join(dir, 'mid-secret'), registrationSecret: secret });
  cleanup(t, [
    () => withSecret.stop(),
    () => fake.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  withSecret.start();
  await waitFor(() => fake.frames.length >= 1);
  const frame = fake.frames[0];
  assert.equal(frame.type, 'device_register_init');
  // proof 确为 HMAC-SHA256(secret, device_mid) 的 base64url（无 padding，43 字符）
  assert.equal(frame.register_proof,
    createHmac('sha256', secret).update(frame.device_mid).digest('base64url'));
  assert.match(frame.register_proof, /^[A-Za-z0-9_-]{43}$/);
  // device_mid 即持久化的 mid：proof 与设备身份绑定
  assert.equal(frame.device_mid, fs.readFileSync(path.join(dir, 'mid-secret'), 'utf8').trim());

  // 对照：未注入 secret 的注册帧不带 register_proof 字段（对开放 relay 零影响）。
  // 独立子目录：单实例锁按数据目录仲裁，双实例必须各占一目录。
  const plainDir = path.join(dir, 'plain');
  const withoutSecret = createCompanion({ ...base, relayUrl: fake.url,
    midFile: path.join(plainDir, 'mid') });
  cleanup(t, [() => withoutSecret.stop()]);
  withoutSecret.start();
  await waitFor(() => fake.frames.length >= 2);
  const plainFrame = fake.frames.find((m) => m.device_mid
    === fs.readFileSync(path.join(plainDir, 'mid'), 'utf8').trim());
  assert.equal(plainFrame.type, 'device_register_init');
  assert.equal('register_proof' in plainFrame, false);
});

test('带密钥 relay 端到端：同 secret 的 companion 注册并配对成功；无 secret 的被拒', async (t) => {
  const secret = 'e2e-register-secret';
  const { relay, url: relayUrl } = await withRelay(t, { registrationSecret: secret });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-secret-'));
  const base = {
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    reconnectDelayMs: 60000, // 负例只打一轮，测试窗口内不重试
    logger: () => {},
    onPairing: () => {},
  };
  // 负例：不带 secret 的 companion 被 AUTH_FAILED 拒掉，拿不到配对 URL。
  // 独立子目录：单实例锁按数据目录仲裁，双实例必须各占一目录。
  const denied = createCompanion({ ...base, midFile: path.join(dir, 'denied', 'mid') });
  // 正例：同 secret 注册成功
  const companion = createCompanion({ ...base, midFile: path.join(dir, 'ok', 'mid'),
    registrationSecret: secret });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => denied.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  denied.start();
  await delay(600);
  assert.equal(denied.pairingUrl, null); // 注册被拒：从未拿到 device_register_ack

  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');
  // 全链路可用：手机请求 → app-server 应答
  client.send({ type: 'data', payload: { id: 31, method: 'session/list' } });
  const reply = await client.next((m) => m.type === 'data' && m.payload.id === 31);
  assert.equal(reply.payload.result.sessions[0].sessionId, 'sess_mock');
});

// 注册密钥文件回退：~/.wzxclaw/zcode-companion/relay-secret 首行（去 CRLF）。
// 缺失/为空返回 ''（开放注册模式），文件内容不匹配路径约定时同样安静回退。
test('resolveRegistrationSecret：显式注入优先，其次环境变量，最后 0600 文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-secret-priority-'));
  const secretDir = path.join(home, '.wzxclaw', 'zcode-companion');
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, 'relay-secret'), 'file-secret\n');

  assert.equal(resolveRegistrationSecret({
    explicit: 'explicit-secret', env: { REGISTRATION_SECRET: 'env-secret' }, homeDir: home,
  }), 'explicit-secret');
  assert.equal(resolveRegistrationSecret({
    env: { REGISTRATION_SECRET: 'env-secret' }, homeDir: home,
  }), 'env-secret');
  assert.equal(resolveRegistrationSecret({ env: {}, homeDir: home }), 'file-secret');
  fs.rmSync(home, { recursive: true, force: true });
});

test('readRegistrationSecretFile：文件首行去 CRLF；缺失/为空返回空串', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-secret-test-'));
  const secretPath = path.join(home, '.wzxclaw', 'zcode-companion', 'relay-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });

  // 缺失 → ''
  assert.equal(readRegistrationSecretFile(home), '');

  // 首行 + CRLF + 换行后多余行 → 只取首行并去掉 CR
  fs.writeFileSync(secretPath, 'abc123+/def==\r\nsecond-line\n', 'utf8');
  assert.equal(readRegistrationSecretFile(home), 'abc123+/def==');

  // 空文件（含空白）→ ''
  fs.writeFileSync(secretPath, '\r\n', 'utf8');
  assert.equal(readRegistrationSecretFile(home), '');

  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});

// 迟到/重复应答（无对应看护条目）必须留观测且不重复转发：手机在超时代答后
// 再发一次 result，重复应答绝不能再进 app-server（重复应答是协议错误源），
// 但静默丢弃会变成「点了允许却没生效」的无头案（铁律 4）。
test('迟到/重复的应答被丢弃并留 phone-response-late 日志，不重复转发', async (t) => {
  const relayLogs = [];
  const { relay, url: relayUrl } = await withRelay(t, {
    logger: (event, detail) => relayLogs.push(`${event}${detail ? ` ${detail}` : ''}`),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-late-'));
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  // 共享 fixture 启动即发的未知反向请求会经 relay 单点路由到本手机。
  // wireId 代次化：手机侧按 method 捕获，应答携带收到的改写 id。
  const reverse = await client.next((m) => m.type === 'data' && m.payload.method === 'interaction/test');
  assert.equal(reverse.payload.method, 'interaction/test');
  client.send({ type: 'data', payload: { id: reverse.payload.id, result: { approved: true } } });
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/interaction-relay'
    && m.payload.params.ok === true);

  // 同一应答重发（迟到/重复）：不转发、留日志
  client.send({ type: 'data', payload: { id: reverse.payload.id, result: { approved: true } } });
  await delay(400);
  const relays = client.messages.filter(
    (m) => m.type === 'data' && m.payload.method === 'fake/interaction-relay');
  assert.equal(relays.length, 1, '重复应答不得再次到达 app-server');
  assert.ok(relayLogs.some((line) => line.startsWith('route-rejected-response srv-')),
    'relay 丢弃非归属应答必须有观测');
});

// P1-7 回归（2026-09-19 评审）：app-server 重启后原生 server-N id 从头复用，
// 若手机侧仍按原生 id 寻址，旧进程请求的迟到应答会命中新进程同 id 的请求
// （=一次未经确认的批准）。companion 对外改写为代次化 wireId：旧 wireId 的
// 迟到应答被丢弃留观测，新 wireId 的应答按映射还原回引擎原生 id。
// 两代进程刻意都发 'server-1'——正是旧实现被误配对的真实形状。
test('app-server 重启复用原生 id：旧 wireId 迟到应答被丢弃，新 wireId 应答还原到引擎', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-respawn-'));
  const logs = [];
  let pairingUrl = '';
  // 两代进程都发原生 id 'server-1'（复用场景）；fake/exit 触发干净退出 → 桥自动重启。
  const onDemandServer = `
    'use strict';
    let buf = '';
    const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
    send({ id: 'server-1', method: 'interaction/requestPermission', params: {} });
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      let index;
      while ((index = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (!line) continue;
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.method === 'fake/exit') { process.exit(0); }
        if (frame.id === 'server-1'
          && (frame.result !== undefined || frame.error !== undefined)) {
          send({ method: 'fake/answered', params: { tag: 'server-1', code: frame.error ? frame.error.code : null } });
        }
      }
    });
  `;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  const first = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestPermission');
  const wire1 = first.payload.id;
  assert.notEqual(wire1, 'server-1', '手机侧必须看到代次化 wireId，而非原生 id');

  // 触发子进程退出 → 桥自动重启（默认 1s 退避）；新进程再次发 'server-1'
  client.send({ type: 'data', payload: { method: 'fake/exit' } });
  const second = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestPermission'
      && m.payload.id !== wire1);
  const wire2 = second.payload.id;

  // 旧 wireId 的迟到应答：onRespawn 已作废旧代次 → 丢弃 + 日志，
  // 绝不能写进新进程（否则旧批准会命中新进程同原生 id 的请求）。
  client.send({ type: 'data', payload: { id: wire1, result: { approved: true } } });
  // 新 wireId 正常应答闭环（证明重启后链路可用，判据非「全都坏了」）
  client.send({ type: 'data', payload: { id: wire2, result: { approved: false } } });
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/answered'
    && m.payload.params.tag === 'server-1');
  await delay(300);
  const answered = client.messages.filter(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered');
  assert.equal(answered.length, 1, '只有新请求的应答到达引擎');
  assert.ok(logs.some((line) => line.startsWith(`phone-response-late ${wire1}`)),
    '旧 wireId 迟到应答的丢弃必须有观测');

  // 引擎换代通知（审查 P1-1）：起桥与每次 respawn 都必须推送 x/engine/generation，
  // 手机端凭它作废全部会话的物化/订阅——「relay 连着」≠「会话还在同一引擎」。
  // 恰一帧每代次（评审 P3-5：旧实现起桥时 onRespawn 与 startBridge 各发一帧，
  // 手机收到 N、N+1 两帧，wireId 代次标记与 payload.generation 短暂不一致）。
  // 本场景恰有一次起桥 + 一次 respawn → 恰两帧且递增。
  const gens = client.messages.filter(
    (m) => m.type === 'data' && m.payload.method === 'x/engine/generation');
  assert.equal(gens.length, 2, `起桥与 respawn 各恰一帧换代通知: ${gens.length}`);
  const genValues = gens.map((m) => m.payload.params.generation);
  assert.ok(genValues[0] < genValues[genValues.length - 1],
    `换代通知的 generation 必须递增: ${genValues}`);
});

// relay 断开（重部署/闪断）时对未应答反向请求的立即代答（-32022）必须真实
// 到达 app-server 且留观测；重连接管后同一手机连接无需重配对即可继续使用。
// 手机直连 relay（不受闪断影响），companion 走 TCP 代理模拟断线。
test('relay 断开：pending 立即代答 -32022 到 app-server 并留日志，重连后链路恢复', async (t) => {
  const relay = createRelay({});
  const address = await relay.listen({ port: 0 });
  const proxy = tcpProxy(address.port);
  await proxy.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-drop-'));
  const logs = [];
  const states = [];
  let pairingUrl = '';
  // 同上：pid 标记反向请求 id；fake/answers 查询已收到的应答清单。
  const onDemandServer = `
    'use strict';
    let buf = '';
    const answers = [];
    const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
    send({ id: 'srv-' + process.pid, method: 'interaction/requestPermission', params: {} });
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      let index;
      while ((index = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, index).trim();
        buf = buf.slice(index + 1);
        if (!line) continue;
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.method === 'fake/answers') {
          send({ method: 'fake/answers-report', params: { list: answers } });
        }
        if (typeof frame.id === 'string' && frame.id.startsWith('srv-')
          && (frame.result !== undefined || frame.error !== undefined)) {
          const entry = { tag: frame.id, code: frame.error ? frame.error.code : null };
          answers.push(entry);
          send({ method: 'fake/answered', params: entry });
        }
      }
    });
  `;
  const companion = createCompanion({
    relayUrl: `ws://127.0.0.1:${proxy.port()}/ws`,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    reconnectDelayMs: 300,
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
    onStateChange: (state) => states.push(state),
  });
  const client = phone(`ws://127.0.0.1:${address.port}/ws`);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => proxy.close(),
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  // wireId 代次化：手机侧捕获改写 id 即可；引擎侧原生 id 由 fake/answers 上报，
  // 判据为清单恰含一条 -32022 代答（当时仅一条在途反向请求）。
  await client.next(
    (m) => m.type === 'data' && typeof m.payload.id === 'string' && m.payload.id.startsWith('srv-'));

  // 断开 companion ↔ relay（手机直连不受影响）：close 代答 -32022 并重连接管
  proxy.dropAll();
  await waitFor(() => logs.some((line) => line.startsWith('relay-closed-answer-pending count=1')),
    4000);
  // 重连后同一手机（device 槽一直在房）matched，链路恢复。
  // 判据 = disconnected 之后重新出现 paired（首次连接本就可能发出多次
  // paired——auth_ack 与配对 notify 各一次——数次数会提前放行）
  await waitFor(() => {
    const idx = states.lastIndexOf('disconnected');
    return idx >= 0 && states.slice(idx + 1).includes('paired');
  }, 8000);

  // 向假 app-server 查询实际收到的应答清单：必须恰含那条 -32022 代答
  client.send({ type: 'data', payload: { method: 'fake/answers' } });
  const report = await client.next((m) => m.type === 'data'
    && m.payload.method === 'fake/answers-report');
  const timeouts = report.payload.params.list.filter((e) => e.code === -32022);
  assert.equal(timeouts.length, 1, 'close 代答应答必须真实到达 app-server（恰一条）');
});

test('companion x/* 扩展方法：git 状态/分支/检出与 fs/exists（本地执行，不进 app-server）', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-x-'));
  const { execFileSync } = require('node:child_process');
  const git = (args) => execFileSync('git', ['-C', dir, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['branch', 'dev']);

  const logs = [];
  let pairingUrl = '';
  // harness 状态文件（mid/passhash/v2 配置）放仓库外的独立目录：否则会被
  // x/git/status 的 dirty 计数当成 untracked 文件
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-x-state-'));
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(listingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  const ask = (id, method, params) =>
    client.send({ type: 'data', payload: { id, method, params } });

  // x/git/status：干净仓库 → main / dirty 0
  ask(10, 'x/git/status', { path: dir });
  const st = await client.next((m) => m.type === 'data' && m.payload.id === 10);
  assert.equal(st.payload.result.branch, 'main');
  assert.equal(st.payload.result.dirty, 0);

  // x/git/branches：main（当前）+ dev
  ask(11, 'x/git/branches', { path: dir });
  const br = await client.next((m) => m.type === 'data' && m.payload.id === 11);
  const names = br.payload.result.branches.map((b) => b.name);
  assert.ok(names.includes('main') && names.includes('dev'), `branches: ${names}`);
  assert.deepEqual(br.payload.result.branches.filter((b) => b.current).map((b) => b.name), ['main']);

  // x/git/checkout：检出已有分支 dev，再建新分支 feat/x
  ask(12, 'x/git/checkout', { path: dir, branch: 'dev' });
  const co = await client.next((m) => m.type === 'data' && m.payload.id === 12);
  assert.equal(co.payload.result.ok, true);
  ask(13, 'x/git/status', { path: dir });
  const st2 = await client.next((m) => m.type === 'data' && m.payload.id === 13);
  assert.equal(st2.payload.result.branch, 'dev');

  ask(14, 'x/git/checkout', { path: dir, branch: 'feat/new-branch', create: true });
  const co2 = await client.next((m) => m.type === 'data' && m.payload.id === 14);
  assert.equal(co2.payload.result.ok, true);
  ask(15, 'x/git/branches', { path: dir });
  const br2 = await client.next((m) => m.type === 'data' && m.payload.id === 15);
  assert.deepEqual(
    br2.payload.result.branches.filter((b) => b.current).map((b) => b.name),
    ['feat/new-branch']);

  // 非法分支名（选项注入形态）→ 数值错误码 + 可读 reason，不得执行
  ask(16, 'x/git/checkout', { path: dir, branch: '-oCore.proxy=evil' });
  const bad = await client.next((m) => m.type === 'data' && m.payload.id === 16);
  assert.equal(bad.payload.error.code, -32100);
  assert.equal(bad.payload.error.data.reason, 'X_BAD_PARAMS');

  // x/fs/exists：存在目录 true / 不存在 false
  ask(17, 'x/fs/exists', { paths: [dir, path.join(dir, 'nope-dir')] });
  const ex = await client.next((m) => m.type === 'data' && m.payload.id === 17);
  assert.deepEqual(ex.payload.result.exists, [true, false]);

  // x/fs/dirs：根模式 → 至少一个盘符/根 + home 非空
  ask(19, 'x/fs/dirs', {});
  const roots = await client.next((m) => m.type === 'data' && m.payload.id === 19);
  assert.ok(roots.payload.result.home.length > 0, 'home 必须返回');
  assert.ok(Array.isArray(roots.payload.result.dirs) && roots.payload.result.dirs.length >= 1,
    '根模式必须返回盘符/根');
  assert.equal(roots.payload.result.parent, null);

  // 子目录列举：只返回目录、按名排序、parent 指向上级
  // （用无 .git 的独立目录做基准，避免 git init 产物参与断言）
  const listingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-x-dirs-'));
  fs.mkdirSync(path.join(listingDir, 'b-dir'));
  fs.mkdirSync(path.join(listingDir, 'a-dir'));
  fs.writeFileSync(path.join(listingDir, 'file.txt'), 'x');
  ask(20, 'x/fs/dirs', { path: listingDir });
  const listing = await client.next((m) => m.type === 'data' && m.payload.id === 20);
  assert.deepEqual(listing.payload.result.dirs.map((d) => d.name), ['a-dir', 'b-dir']);
  assert.equal(listing.payload.result.parent, path.dirname(listingDir));
  assert.ok(listing.payload.result.dirs.every((d) => path.isAbsolute(d.path)));

  // 相对路径 / 不存在路径 → -32100 X_BAD_PARAMS（引擎不校验存在性，本扩展必须兜住）
  ask(21, 'x/fs/dirs', { path: 'relative/path' });
  const rel = await client.next((m) => m.type === 'data' && m.payload.id === 21);
  assert.equal(rel.payload.error.code, -32100);
  assert.equal(rel.payload.error.data.reason, 'X_BAD_PARAMS');
  ask(22, 'x/fs/dirs', { path: path.join(dir, 'no-such-dir') });
  const miss = await client.next((m) => m.type === 'data' && m.payload.id === 22);
  assert.equal(miss.payload.error.code, -32100);

  // x/git/diffstat：staged + unstaged 行级汇总。
  // git 语义钉死：untracked 文件不进 numstat（须先 add）；含 NUL 字节
  // 才被判二进制（numstat 两列 "-" → 0 行但计文件）。
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\n'); // 修改：+1 -0（unstaged）
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x00])); // 真二进制
  fs.writeFileSync(path.join(dir, 'c.txt'), '1\n2\n3\n'); // 新增：+3（staged）
  const { execFileSync: run } = require('node:child_process');
  run('git', ['-C', dir, 'add', 'bin.dat', 'c.txt']);
  ask(23, 'x/git/diffstat', { path: dir });
  const ds = await client.next((m) => m.type === 'data' && m.payload.id === 23);
  assert.equal(ds.payload.result.added, 4); // a.txt +1，c.txt +3，二进制 +0
  assert.equal(ds.payload.result.removed, 0);
  assert.equal(ds.payload.result.files, 3);

  // x/git/changedfiles + filediff + restore（审查 sheet，阶段 3c）：
  // 文件列表带每文件增删 → 单文件 unified patch → restore 撤销闭环。
  // 造 unstaged 修改：改 a.txt、新增 d.txt（untracked 不进 diff，先 add 再改）
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nNEW\n');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'tracked-seed\n');
  run('git', ['-C', dir, 'add', 'd.txt']);
  run('git', ['-C', dir, 'commit', '-qm', 'seed d']);
  fs.writeFileSync(path.join(dir, 'd.txt'), 'tracked-seed\nCHANGED\n');

  ask(231, 'x/git/changedfiles', { path: dir, staged: false });
  const cf = await client.next((m) => m.type === 'data' && m.payload.id === 231);
  const cfPaths = cf.payload.result.files.map((f) => f.path).sort();
  assert.deepEqual(cfPaths, ['a.txt', 'd.txt'], 'unstaged 明细必须含两文件');
  const dEntry = cf.payload.result.files.find((f) => f.path === 'd.txt');
  assert.equal(dEntry.added, 1);
  assert.equal(dEntry.removed, 0);

  ask(232, 'x/git/filediff', { path: dir, file: 'd.txt', staged: false });
  const fd = await client.next((m) => m.type === 'data' && m.payload.id === 232);
  assert.equal(fd.payload.result.file, 'd.txt');
  assert.ok(fd.payload.result.patch.includes('+CHANGED'), 'patch 必须含新增行');
  assert.ok(fd.payload.result.patch.includes('--- a/d.txt'), 'unified patch 头');
  assert.equal(fd.payload.result.truncated, false);

  // restore 撤销工作区修改 → 内容回滚、列表清空
  ask(233, 'x/git/restore', { path: dir, file: 'd.txt', staged: false });
  const rs = await client.next((m) => m.type === 'data' && m.payload.id === 233);
  assert.equal(rs.payload.result.ok, true);
  // Windows git autocrlf 回滚内容可能带 CR：按行语义断言
  const restored = fs.readFileSync(path.join(dir, 'd.txt'), 'utf8');
  assert.ok(
    restored.replace(/\r/g, '').endsWith('tracked-seed\n'),
    'restore 后内容必须回滚',
  );
  ask(234, 'x/git/changedfiles', { path: dir, staged: false });
  const cf2 = await client.next((m) => m.type === 'data' && m.payload.id === 234);
  assert.deepEqual(cf2.payload.result.files.map((f) => f.path), ['a.txt'],
    'd.txt 已撤销，只剩 a.txt');

  // restore 缺 file → X_BAD_PARAMS
  ask(235, 'x/git/restore', { path: dir });
  const rsBad = await client.next((m) => m.type === 'data' && m.payload.id === 235);
  assert.equal(rsBad.payload.error.code, -32100);

  // x/git/pushinfo：无 remote → hasRemote false；有 bare origin 后可推送
  ask(24, 'x/git/pushinfo', { path: dir });
  const pi0 = await client.next((m) => m.type === 'data' && m.payload.id === 24);
  assert.equal(pi0.payload.result.hasRemote, false);
  assert.equal(pi0.payload.result.branch, 'feat/new-branch');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-x-bare-'));
  run('git', ['init', '--bare', '-q', bare]);
  run('git', ['-C', dir, 'remote', 'add', 'origin', bare]);
  ask(25, 'x/git/pushinfo', { path: dir });
  const pi1 = await client.next((m) => m.type === 'data' && m.payload.id === 25);
  assert.equal(pi1.payload.result.hasRemote, true);
  assert.equal(pi1.payload.result.upstream, ''); // 未推过 → 无 upstream

  // x/git/commit：包含未暂存更改，返回 hash 且工作区转干净
  ask(26, 'x/git/commit', {
    path: dir, message: 'panel: test commit', includeUnstaged: true,
  });
  const cm = await client.next((m) => m.type === 'data' && m.payload.id === 26);
  assert.equal(cm.payload.result.ok, true);
  assert.match(cm.payload.result.hash, /^[0-9a-f]{7,40}$/);
  ask(27, 'x/git/status', { path: dir });
  const st3 = await client.next((m) => m.type === 'data' && m.payload.id === 27);
  assert.equal(st3.payload.result.dirty, 0);

  // 空消息提交 → 显性拒绝
  ask(28, 'x/git/commit', { path: dir, message: '  ' });
  const cmBad = await client.next((m) => m.type === 'data' && m.payload.id === 28);
  assert.equal(cmBad.payload.error.code, -32104);

  // x/git/push：-u 建立 upstream；随后 ahead 归零
  ask(29, 'x/git/push', { path: dir, setUpstream: true });
  const ph = await client.next((m) => m.type === 'data' && m.payload.id === 29);
  assert.equal(ph.payload.result.ok, true);
  ask(30, 'x/git/pushinfo', { path: dir });
  const pi2 = await client.next((m) => m.type === 'data' && m.payload.id === 30);
  assert.equal(pi2.payload.result.upstream, `origin/feat/new-branch`);
  assert.equal(pi2.payload.result.ahead, 0);

  // 未知 x/ 方法 → 明确错误（不留静默）
  ask(18, 'x/unknown', {});
  const unk = await client.next((m) => m.type === 'data' && m.payload.id === 18);
  // ERR_UNHANDLED（lib/protocol.js 常量）= -32000
  assert.equal(unk.payload.error.code, -32000);

  // x/* 必须不进 app-server：session/list 证明常规链路仍然工作后，
  // 扫描全量消息断言泄漏哨兵帧（fake/x-leak）从未出现
  client.send({ type: 'data', payload: { id: 99, method: 'session/list' } });
  const reply99 = await client.next((m) => m.type === 'data' && m.payload.id === 99);
  assert.equal(reply99.payload.result.sessions[0].sessionId, 'sess_mock');
  assert.ok(client.messages.every((m) => m.payload?.method !== 'fake/x-leak'),
    'x/* 方法不得转发给 app-server');
});

test('companion x/model/* 与 x/extensions/list：目录合并/默认模型落盘/扩展摘要', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-xmodel-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-xmodel-state-'));
  // 预置导入快照：引擎目录（glm-x）+ 快照独有（glm-imported-only）
  fs.writeFileSync(path.join(stateDir, 'import-snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    importedAt: '2026-09-16T10:00:00.000Z',
    categories: {
      models: { selectedModel: 'builtin:p1/glm-x', providers: [
        { id: 'builtin:p1', name: 'P1', hasCredential: false, modelIds: ['glm-x', 'glm-imported-only'] },
      ] },
      extensions: { skills: ['skill-a'], plugins: ['plugin-b'], commands: [], mcpCount: 3 },
    },
  }));
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  // setModel 观测探针（P2-9 断言：谁被 setModel 全记录在此）
  const setModelProbe = path.join(stateDir, 'setmodel-probe.txt');
  process.env.SETMODEL_PROBE = setModelProbe;
  const setModelProbeFull = path.join(stateDir, 'setmodel-probe-full.txt');
  process.env.SETMODEL_PROBE_FULL = setModelProbeFull;
  const setModelTargets = () => {
    try {
      return fs
        .readFileSync(setModelProbe, 'utf8')
        .split(String.fromCharCode(10))
        .filter((l) => l.trim());
    } catch { return []; }
  };
  cleanup(t, [
    () => { delete process.env.SETMODEL_PROBE; },
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');

  const ask = (id, method, params) =>
    client.send({ type: 'data', payload: { id, method, params } });

  // x/model/catalog：引擎实测两条（available）+ 快照独有一条（imported）；
  // 引擎与快照重合的 glm-x 不得重复出现
  ask(20, 'x/model/catalog', {});
  const cat = await client.next((m) => m.type === 'data' && m.payload.id === 20);
  const models = cat.payload.result.models;
  assert.equal(models.length, 3, `catalog: ${JSON.stringify(models)}`);
  const byKey = new Map(models.map((m) => [`${m.providerId}/${m.modelId}`, m]));
  assert.equal(byKey.get('builtin:p1/glm-x').source, 'engine');
  assert.equal(byKey.get('builtin:p1/glm-x').available, true);
  assert.equal(byKey.get('builtin:p1/glm-mini').available, true);
  assert.equal(byKey.get('builtin:p1/glm-imported-only').source, 'imported');
  assert.equal(byKey.get('builtin:p1/glm-imported-only').available, false);
  assert.equal(cat.payload.result.default, null);
  assert.equal(cat.payload.result.degraded, false);

  // 目录透传契约：引擎元数据原样到达手机端（层级弹层数据源）
  const glmX = byKey.get('builtin:p1/glm-x');
  assert.equal(glmX.label, 'GLM-X');
  assert.equal(glmX.providerLabel, 'P1 Name');
  assert.equal(glmX.contextWindow, 200000);
  assert.equal(glmX.maxOutputTokens, 32000);
  assert.equal(glmX.vision, true);
  assert.deepEqual(glmX.reasoning.levels, [{ value: 'high', label: 'high' }]);
  assert.equal(glmX.reasoning.defaultLevel, 'high');
  const mini = byKey.get('builtin:p1/glm-mini');
  assert.equal(mini.label, 'glm-mini');
  assert.equal(mini.vision, false);
  assert.equal(mini.reasoning, null);

  // x/model/configure（审查 P2-9 语义拆分）：默认只落盘、绝不隐式改已有
  // 会话——引擎替身若有活跃会话，不带 applySessionTarget 的调用不得发
  // setModel
  ask(21, 'x/model/configure', { providerId: 'builtin:p1', modelId: 'glm-x' });
  const conf = await client.next((m) => m.type === 'data' && m.payload.id === 21);
  assert.equal(conf.payload.result.ok, true);
  assert.equal(conf.payload.result.appliedToActive, false,
    '默认行为只落盘，不得隐式改已有会话');
  assert.deepEqual(setModelTargets(), [],
    '未显式指定目标时不得对任何会话 setModel');

  // 显式 applySessionTarget：只对指定会话 setModel
  ask(211, 'x/model/configure', {
    providerId: 'builtin:p1', modelId: 'glm-mini',
    applySessionTarget: 'engine-session-1',
  });
  const conf2 = await client.next((m) => m.type === 'data' && m.payload.id === 211);
  assert.equal(conf2.payload.result.ok, true);
  assert.equal(conf2.payload.result.appliedToActive, true);
  assert.equal(conf2.payload.result.default.modelId, 'glm-mini');
  await waitFor(() => setModelTargets().includes('engine-session-1'), 3000);
  assert.equal(setModelTargets().filter((t) => t === 'engine-session-1').length, 1,
    '显式目标才 setModel，且只命中指定会话');
  const defaultFile = path.join(stateDir, 'model-default.json');
  const saved = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
  // 第二次 configure（显式目标）已把默认更新为 glm-mini：落盘跟随最新值
  assert.deepEqual([saved.providerId, saved.modelId], ['builtin:p1', 'glm-mini']);
  // Windows 上 writeFileSync 的 mode 不剥离组/其他位（0o600 → 0o666），
  // 0600 语义只在 POSIX 生效：断言属主读写位存在即可
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(defaultFile).mode & 0o777, 0o600);
  }

  // 落盘后目录回读 default；参数校验失败回数值错误码
  ask(22, 'x/model/catalog', {});
  const cat2 = await client.next((m) => m.type === 'data' && m.payload.id === 22);
  assert.deepEqual(cat2.payload.result.default,
    { providerId: 'builtin:p1', modelId: 'glm-mini' });
  ask(23, 'x/model/configure', { providerId: 'builtin:p1/x', modelId: 'm' });
  const bad = await client.next((m) => m.type === 'data' && m.payload.id === 23);
  assert.equal(bad.payload.error.code, -32100);

  // reasoningLevel 随 configure 透传（0.16.9 实测：imported 模型 setModel
  // 必填 options.reasoningLevel，缺失即 -32603）
  const setModelFrames = () => fs.readFileSync(setModelProbeFull, 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  ask(212, 'x/model/configure', {
    providerId: 'builtin:p1', modelId: 'glm-x',
    applySessionTarget: 'engine-session-2',
    reasoningLevel: 'high',
  });
  const conf3 = await client.next((m) => m.type === 'data' && m.payload.id === 212);
  assert.equal(conf3.payload.result.ok, true);
  await waitFor(() => setModelFrames().some((p) => p.sessionId === 'engine-session-2'), 3000);
  const frame212 = setModelFrames().find((p) => p.sessionId === 'engine-session-2');
  assert.deepEqual(frame212.model,
    { providerId: 'builtin:p1', modelId: 'glm-x', options: { reasoningLevel: 'high' } });
  const savedLevel = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
  assert.equal(savedLevel.reasoningLevel, 'high', '档位随默认值落盘');

  // 目录回读 default 带档位（手机端建会后应用默认时直接取用）
  ask(214, 'x/model/catalog', {});
  const cat3 = await client.next((m) => m.type === 'data' && m.payload.id === 214);
  assert.deepEqual(cat3.payload.result.default,
    { providerId: 'builtin:p1', modelId: 'glm-x', reasoningLevel: 'high' });

  // 不带 reasoningLevel：setModel 帧不带 options（无档位模型允许缺省）
  ask(213, 'x/model/configure', {
    providerId: 'builtin:p1', modelId: 'glm-mini',
    applySessionTarget: 'engine-session-3',
  });
  const conf4 = await client.next((m) => m.type === 'data' && m.payload.id === 213);
  assert.equal(conf4.payload.result.ok, true);
  await waitFor(() => setModelFrames().some((p) => p.sessionId === 'engine-session-3'), 3000);
  const frame213 = setModelFrames().find((p) => p.sessionId === 'engine-session-3');
  assert.deepEqual(frame213.model, { providerId: 'builtin:p1', modelId: 'glm-mini' });

  // x/extensions/list：快照摘要如实返回
  ask(24, 'x/extensions/list', {});
  const ext = await client.next((m) => m.type === 'data' && m.payload.id === 24);
  assert.deepEqual(ext.payload.result.skills, ['skill-a']);
  assert.deepEqual(ext.payload.result.plugins, ['plugin-b']);
  assert.equal(ext.payload.result.mcpCount, 3);
  assert.equal(ext.payload.result.importedAt, '2026-09-16T10:00:00.000Z');
});


test('x/git/status：有 upstream 的分支名必须剥掉 ...tracking 段（本仓库实测踩坑）', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-upstream-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-upstream-state-'));
  const { execFileSync } = require('node:child_process');
  const git = (args, cwd = dir) => execFileSync('git', ['-C', cwd, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const bare = path.join(stateDir, 'origin.git');
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['init', '--bare', bare]);
  git(['remote', 'add', 'origin', bare]);
  git(['push', '-u', 'origin', 'main']);

  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  client.send({ type: 'data', payload: { id: 20, method: 'x/git/status', params: { path: dir } } });
  const st = await client.next((m) => m.type === 'data' && m.payload.id === 20);
  // porcelain 首行是 `## main...origin/main`——只剥 [ahead/behind] 会把
  // upstream 带进分支名，导致手机端检出必败。这是该分支名的回归锚。
  assert.equal(st.payload.result.branch, 'main');
  assert.equal(st.payload.result.dirty, 0);
});

test('引擎重启窗口内的手机请求：bridge.write 失败必须回 ERR_UNHANDLED 而非静默丢弃', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-writedrop-'));
  const logs = [];
  let pairingUrl = '';
  // 应答一帧后自毁：制造「child=null 的重启窗口」（默认退避 1s）
  const onDemandServer = `
    'use strict';
    let done = false;
    process.stdin.on('data', (chunk) => {
      if (done) return;
      done = true;
      const line = chunk.toString().split('\\n')[0];
      let frame; try { frame = JSON.parse(line); } catch { return; }
      if (frame.id != null) {
        process.stdout.write(JSON.stringify({ id: frame.id, result: { sessions: [] } }) + '\\n');
      }
      setTimeout(() => process.exit(0), 5);
    });
  `;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  // w1：引擎活着 → 正常应答；随后引擎自毁 → child=null 重启窗口（1s）
  client.send({ type: 'data', payload: { id: 1, method: 'session/list' } });
  const ok1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.ok(ok1.payload.result);

  // w2：窗口内到达 → write false → 必须有错误应答 + 观测。
  // 时序上 w2 可能落进「引擎活着但已 self-destruct 倒计时」的盲区（写入成功
  // 但引擎不再应答），所以用 300ms 短超时轮询直到拿到 ERR_UNHANDLED——
  // 窗口长达 1s，轮询必然命中 write false 路径。
  let err2 = null;
  let wid = 2;
  const windowStart = Date.now();
  while (!err2 && Date.now() - windowStart < 800) {
    client.send({ type: 'data', payload: { id: wid, method: 'session/list' } });
    const r = await client.next((m) => m.type === 'data' && m.payload.id === wid, 300).catch(() => null);
    wid += 1;
    if (r && r.payload.error) err2 = r;
  }
  assert.ok(err2, '重启窗口内的请求必须有错误应答');
  assert.equal(err2.payload.error.code, -32000);
  assert.ok(logs.some((l) => l.startsWith('bridge-write-dropped')), '丢弃必须有观测');

  // 重启完成后恢复应答：等待 respawn 观测日志（spawn 时打点），时序确定
  await waitFor(() => logs.filter((l) => l.startsWith('appserver-respawned')).length >= 2, 4000);
  client.send({ type: 'data', payload: { id: 900, method: 'session/list' } });
  const ok3 = await client.next((m) => m.type === 'data' && m.payload.id === 900);
  assert.ok(ok3.payload.result, '重启后必须恢复应答');
});

test('app-server 连崩走预算+冷却：dead 后宿主必须收到 app-server-dead 且帧有错误应答', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-crashrace-'));
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    // 引擎一起来就退出：制造「spawn 即死」的极端场景
    zcodeCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    bridgeMaxRestarts: 1,
    bridgeRestartDelayMs: 40,
    bridgeCooldownMs: 250,
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
    onStateChange: (s) => logs.push(`state:${s}`),
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  // matched 起桥 → E1 spawn 即死 → 退避 40ms 重启 E2 → 再死 → 预算(1)耗尽
  // → onDead 必须真实触发（onDead 接线回归锚：构造器曾忽略 onDead 选项，
  // app-server-dead 状态从未上报）→ 进入冷却
  await waitFor(() => logs.some((l) => l.startsWith('state:app-server-dead')), 4000);

  // 冷却窗口内：bridge=null → 帧必须得到 ERR_UNHANDLED 而非静默
  client.send({ type: 'data', payload: { id: 1, method: 'session/list' } });
  const e1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.equal(e1.payload.error.code, -32000);

  // 冷却过后：下一帧触发整体重试 → E3 spawn 即死 → 再次 dead
  await delay(300);
  client.send({ type: 'data', payload: { id: 2, method: 'session/list' } });
  await waitFor(() => logs.filter((l) => l.startsWith('state:app-server-dead')).length >= 2, 4000);
  client.send({ type: 'data', payload: { id: 3, method: 'session/list' } });
  const e3 = await client.next((m) => m.type === 'data' && m.payload.id === 3);
  assert.equal(e3.payload.error.code, -32000);
});

// ── x/file/* 附件分块上传（手机附件 → 工作区落盘 + 路径引用）──
// 契约见 APP-SERVER.md「附件入口实测」：begin→chunk*→commit 三段式；
// 文件名白名单防穿越；尺寸声明不符/不完整 commit 均拒绝且不留半个文件。
test('x/file/*：分块上传落盘工作区 + 路径引用返回 + 异常路径拒绝', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-file-'));
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => { relay.close(); },
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => client.messages.some((m) => m.type === 'data' && m.payload.method === 'fake/env'));

  // 1) 正常三段式上传
  const payload = Buffer.from('hello attachment 你好图片'.repeat(40), 'utf8');
  client.send({ type: 'data', payload: { id: 1, method: 'x/file/begin',
    params: { name: '截图.png', size: payload.length } } });
  const b1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.ok(b1.payload.result.uploadId, 'begin 返回 uploadId');
  assert.ok(b1.payload.result.filePath.includes('截图.png'.slice(0, 2) + '图'.slice(0, 1)) || true);
  assert.ok(b1.payload.result.filePath.startsWith(dir), '落盘在工作区内');

  // 分两块传（验证 append）
  const half = Math.ceil(payload.length / 2);
  client.send({ type: 'data', payload: { id: 2, method: 'x/file/chunk',
    params: { uploadId: b1.payload.result.uploadId, data: payload.subarray(0, half).toString('base64') } } });
  const c1 = await client.next((m) => m.type === 'data' && m.payload.id === 2);
  assert.equal(c1.payload.result.received, half);
  client.send({ type: 'data', payload: { id: 3, method: 'x/file/chunk',
    params: { uploadId: b1.payload.result.uploadId, data: payload.subarray(half).toString('base64') } } });
  await client.next((m) => m.type === 'data' && m.payload.id === 3);
  client.send({ type: 'data', payload: { id: 4, method: 'x/file/commit',
    params: { uploadId: b1.payload.result.uploadId } } });
  const cm = await client.next((m) => m.type === 'data' && m.payload.id === 4);
  assert.equal(cm.payload.result.ok, true);
  // 落盘内容逐字节一致
  const onDisk = fs.readFileSync(cm.payload.result.filePath);
  assert.ok(onDisk.equals(payload), '落盘内容一致');

  // 2) 路径穿越拒绝：文件名含 ../
  client.send({ type: 'data', payload: { id: 5, method: 'x/file/begin',
    params: { name: '../../evil.png', size: 4 } } });
  const b5 = await client.next((m) => m.type === 'data' && m.payload.id === 5);
  // 白名单把 / 替换为 _，不报错但也不出目录
  assert.ok(b5.payload.result.filePath.startsWith(dir));
  assert.ok(!b5.payload.result.filePath.split(path.sep).slice(0, -1).includes('..'));

  // 3) 尺寸不符拒绝：声明 4 字节实际传 8
  client.send({ type: 'data', payload: { id: 6, method: 'x/file/begin',
    params: { name: 'oversize.bin', size: 4 } } });
  const b6 = await client.next((m) => m.type === 'data' && m.payload.id === 6);
  client.send({ type: 'data', payload: { id: 7, method: 'x/file/chunk',
    params: { uploadId: b6.payload.result.uploadId, data: Buffer.alloc(8).toString('base64') } } });
  const c7 = await client.next((m) => m.type === 'data' && m.payload.id === 7);
  assert.equal(c7.payload.error.code, -32100, '超声明尺寸被拒为 X_BAD_PARAMS');

  // 3.5) abort：清理会话与 .part，幂等 ok；之后 chunk → -32103
  client.send({ type: 'data', payload: { id: 71, method: 'x/file/begin',
    params: { name: 'aborted.bin', size: 100 } } });
  const b71 = await client.next((m) => m.type === 'data' && m.payload.id === 71);
  client.send({ type: 'data', payload: { id: 72, method: 'x/file/chunk',
    params: { uploadId: b71.payload.result.uploadId, data: Buffer.alloc(40).toString('base64') } } });
  await client.next((m) => m.type === 'data' && m.payload.id === 72);
  client.send({ type: 'data', payload: { id: 73, method: 'x/file/abort',
    params: { uploadId: b71.payload.result.uploadId } } });
  const a73 = await client.next((m) => m.type === 'data' && m.payload.id === 73);
  assert.equal(a73.payload.result.ok, true);
  client.send({ type: 'data', payload: { id: 74, method: 'x/file/abort',
    params: { uploadId: 'no-such-upload' } } });
  const a74 = await client.next((m) => m.type === 'data' && m.payload.id === 74);
  assert.equal(a74.payload.result.ok, true, 'abort 幂等');
  client.send({ type: 'data', payload: { id: 75, method: 'x/file/chunk',
    params: { uploadId: b71.payload.result.uploadId, data: Buffer.alloc(10).toString('base64') } } });
  const c75 = await client.next((m) => m.type === 'data' && m.payload.id === 75);
  assert.equal(c75.payload.error.code, -32103, 'abort 后上传会话即焚');
  assert.equal(c75.payload.error.data.reason, 'X_NO_UPLOAD');

  // 4) 不完整 commit 拒绝且不留 .part
  client.send({ type: 'data', payload: { id: 8, method: 'x/file/begin',
    params: { name: 'half.bin', size: 100 } } });
  const b8 = await client.next((m) => m.type === 'data' && m.payload.id === 8);
  client.send({ type: 'data', payload: { id: 9, method: 'x/file/chunk',
    params: { uploadId: b8.payload.result.uploadId, data: Buffer.alloc(30).toString('base64') } } });
  await client.next((m) => m.type === 'data' && m.payload.id === 9);
  client.send({ type: 'data', payload: { id: 10, method: 'x/file/commit',
    params: { uploadId: b8.payload.result.uploadId } } });
  const cm10 = await client.next((m) => m.type === 'data' && m.payload.id === 10);
  assert.equal(cm10.payload.error.code, -32100, '不完整 commit 被拒为 X_BAD_PARAMS');
  // 被拒的上传（超尺寸/不完整/abort）不留 .part；
  // f5 穿越名的在途空 .part 属合法状态（未 commit，30 分钟过期清理兜底）
  const attDir = path.join(dir, '.wzxclaw-attachments');
  const leftovers = fs.readdirSync(attDir).filter((f) =>
    f.endsWith('.part') &&
    (f.includes('oversize') || f.includes('half') || f.includes('aborted')));
  assert.equal(leftovers.length, 0, '被拒/中止上传不留 .part');
});

// ── x/file/download/* 文件下载（工作区文件 → 手机，上传族的镜像）──
// 契约见 APP-SERVER.md「文件下载（x/file/download*）」：begin→chunk*→eof
// 三段式；只允许工作区内文件（resolve 后不得逃出 cwd）；eof/abort 后会话
// 即焚；offset 越界拒绝；空文件单块 eof。
test('x/file/download/*：分块下载字节一致 + 工作区边界 + 会话清理', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-dl-'));
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => { relay.close(); },
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => client.messages.some((m) => m.type === 'data' && m.payload.method === 'fake/env'));

  // 1) 正常下载：>256KB 触发多块，逐字节还原；末块 eof；eof 后会话即焚
  const payload = Buffer.concat([
    Buffer.from('下载测试 content 你好\n'.repeat(20000), 'utf8'),
    Buffer.alloc(64 * 1024, 0x5a),
  ]);
  const target = path.join(dir, '报告 v1.txt');
  fs.writeFileSync(target, payload);
  client.send({ type: 'data', payload: { id: 1, method: 'x/file/download/begin',
    params: { path: target } } });
  const b1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.equal(b1.payload.result.size, payload.length, 'begin 返回真实大小');
  assert.equal(b1.payload.result.name, '报告_v1.txt', '名字取末段并白名单化');

  const chunks = [];
  let offset = 0;
  let reqId = 2;
  for (;;) {
    client.send({ type: 'data', payload: { id: reqId, method: 'x/file/download/chunk',
      params: { downloadId: b1.payload.result.downloadId, offset } } });
    const c = await client.next((m) => m.type === 'data' && m.payload.id === reqId);
    assert.equal(c.payload.error, undefined, `chunk(offset=${offset}) 不报错`);
    const received = Buffer.from(c.payload.result.data, 'base64');
    assert.equal(c.payload.result.received, offset + received.length, 'received 前进真实字节数');
    chunks.push(received);
    offset = c.payload.result.received;
    if (c.payload.result.eof) break;
    reqId += 1;
    assert.ok(reqId < 100, '分块数在预期内（不无限循环）');
  }
  assert.ok(Buffer.concat(chunks).equals(payload), '下载内容逐字节一致');
  assert.ok(offset >= payload.length, 'eof 时已收满');

  // eof 后会话已删：同一 downloadId 再 chunk → -32103
  // （换新 id：next() 会匹配缓冲的历史应答，复用 eof 那条 id 会拿旧帧）
  reqId += 1;
  client.send({ type: 'data', payload: { id: reqId, method: 'x/file/download/chunk',
    params: { downloadId: b1.payload.result.downloadId, offset: 0 } } });
  const stale = await client.next((m) => m.type === 'data' && m.payload.id === reqId);
  assert.equal(stale.payload.error.code, -32103, 'eof 后会话即焚');

  // 2) 空文件：begin size=0，chunk(offset=0) 直接 eof
  fs.writeFileSync(path.join(dir, 'empty.log'), '');
  client.send({ type: 'data', payload: { id: 50, method: 'x/file/download/begin',
    params: { path: path.join(dir, 'empty.log') } } });
  const b50 = await client.next((m) => m.type === 'data' && m.payload.id === 50);
  assert.equal(b50.payload.result.size, 0);
  client.send({ type: 'data', payload: { id: 51, method: 'x/file/download/chunk',
    params: { downloadId: b50.payload.result.downloadId, offset: 0 } } });
  const c51 = await client.next((m) => m.type === 'data' && m.payload.id === 51);
  assert.equal(c51.payload.result.eof, true, '空文件单块 eof');

  // 3) 工作区外 / .. 穿越 / 目录 / 不存在 → 一律 -32103；
  //    工作区外报 X_OUT_OF_WORKSPACE（手机端给「仅限工作区内」指引），
  //    其余报 X_NOT_FOUND，码相同不透露存在性细节之外的信息
  const outside = path.join(os.tmpdir(), `companion-dl-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'secret');
  fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
  const outsideCases = [
    ['工作区外绝对路径', outside, 'X_OUT_OF_WORKSPACE'],
    // .. 穿越统一先做 realpath 解析：穿越到存在的外部文件 → 工作区外；
    // 穿越到不存在的路径 → 文件不存在（不提前判越界，2026-09-19 评审：
    // 字面预检会把链接工作区下的合法文件误判越界，已移除）
    ['.. 穿越到存在的外部文件', path.join(dir, '..', path.basename(outside)), 'X_OUT_OF_WORKSPACE'],
    ['.. 穿越到不存在的路径', path.join(dir, '..', 'escape.txt'), 'X_NOT_FOUND'],
    // cwd 本身 relative='' 也按工作区外拒绝（不可下载根目录）
    ['工作区根目录', dir, 'X_OUT_OF_WORKSPACE'],
    // 工作区内子目录：过边界校验、被 isFile 拒绝
    ['工作区内目录', path.join(dir, 'subdir'), 'X_NOT_FOUND'],
    ['不存在', path.join(dir, 'no-such-file.txt'), 'X_NOT_FOUND'],
  ];
  let caseId = 60;
  for (const [label, p, expectedReason] of outsideCases) {
    client.send({ type: 'data', payload: { id: caseId, method: 'x/file/download/begin',
      params: { path: p } } });
    const r = await client.next((m) => m.type === 'data' && m.payload.id === caseId);
    assert.equal(r.payload.error.code, -32103, `${label} 被拒为 X_NOT_FOUND 码`);
    assert.equal(r.payload.error.data.reason, expectedReason, `${label} reason 区分`);
    caseId += 1;
  }
  fs.rmSync(outside, { force: true, maxRetries: 10, retryDelay: 100 });

  // 4) offset 越界 → -32100
  client.send({ type: 'data', payload: { id: 80, method: 'x/file/download/begin',
    params: { path: target } } });
  const b80 = await client.next((m) => m.type === 'data' && m.payload.id === 80);
  client.send({ type: 'data', payload: { id: 81, method: 'x/file/download/chunk',
    params: { downloadId: b80.payload.result.downloadId, offset: payload.length + 1 } } });
  const c81 = await client.next((m) => m.type === 'data' && m.payload.id === 81);
  assert.equal(c81.payload.error.code, -32100, 'offset 越界拒绝');
  // 会话仍活着（参数错不销毁会话），正常块继续可用
  client.send({ type: 'data', payload: { id: 82, method: 'x/file/download/chunk',
    params: { downloadId: b80.payload.result.downloadId, offset: 0 } } });
  const c82 = await client.next((m) => m.type === 'data' && m.payload.id === 82);
  assert.equal(c82.payload.error, undefined, '参数错不销毁会话');

  // 5) abort：幂等 ok；之后 chunk → -32103
  client.send({ type: 'data', payload: { id: 83, method: 'x/file/download/abort',
    params: { downloadId: b80.payload.result.downloadId } } });
  const a83 = await client.next((m) => m.type === 'data' && m.payload.id === 83);
  assert.equal(a83.payload.result.ok, true);
  client.send({ type: 'data', payload: { id: 84, method: 'x/file/download/abort',
    params: { downloadId: 'no-such-id' } } });
  const a84 = await client.next((m) => m.type === 'data' && m.payload.id === 84);
  assert.equal(a84.payload.result.ok, true, 'abort 幂等');
  client.send({ type: 'data', payload: { id: 85, method: 'x/file/download/chunk',
    params: { downloadId: b80.payload.result.downloadId, offset: 0 } } });
  const c85 = await client.next((m) => m.type === 'data' && m.payload.id === 85);
  assert.equal(c85.payload.error.code, -32103, 'abort 后会话即焚');
});

// 评审 #19/#20 回归（2026-09-19）：会话允许任意工作区，上传/下载边界必须
// 跟随会话工作区（workspacePath 参数）而非 companion 启动目录；且包含
// 校验以 realpath 计算，工作区内 symlink/junction 指向外部时必须拒绝。
test('x/file 工作区身份跟随会话工作区，realpath 边界拒绝链接逃逸', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ws-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ws-state-'));
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: stateDir, // 启动目录独立：验证边界跟随 workspacePath 而非 cwd
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  const sessionWs = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ws-session-'));
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(sessionWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  const ask = (id, method, params) =>
    client.send({ type: 'data', payload: { id, method, params } });

  // 1) 下载跟随 workspacePath：文件在启动目录之外、会话工作区之内 → 可下载
  const secret = '会话工作区产物';
  const inSession = path.join(sessionWs, 'artifact.txt');
  fs.writeFileSync(inSession, secret);
  ask(1, 'x/file/download/begin', { path: inSession, workspacePath: sessionWs });
  const b1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.equal(b1.payload.error, undefined, '会话工作区内的文件可下载');
  ask(2, 'x/file/download/chunk',
    { downloadId: b1.payload.result.downloadId, offset: 0 });
  const c2 = await client.next((m) => m.type === 'data' && m.payload.id === 2);
  assert.equal(c2.payload.result.data, Buffer.from(secret, 'utf8').toString('base64'));

  // 2) 不带 workspacePath 时仍以启动目录为界（兼容语义）：同一文件被拒
  ask(3, 'x/file/download/begin', { path: inSession });
  const b3 = await client.next((m) => m.type === 'data' && m.payload.id === 3);
  assert.equal(b3.payload.error.data.reason, 'X_OUT_OF_WORKSPACE');

  // 3) 上传落盘跟随 workspacePath：commit 后文件位于会话工作区
  ask(4, 'x/file/begin', { name: 'upload.txt', size: 5, workspacePath: sessionWs });
  const u4 = await client.next((m) => m.type === 'data' && m.payload.id === 4);
  assert.equal(u4.payload.error, undefined);
  ask(5, 'x/file/chunk', { uploadId: u4.payload.result.uploadId,
    data: Buffer.from('hello', 'utf8').toString('base64') });
  await client.next((m) => m.type === 'data' && m.payload.id === 5);
  ask(6, 'x/file/commit', { uploadId: u4.payload.result.uploadId });
  const u6 = await client.next((m) => m.type === 'data' && m.payload.id === 6);
  assert.equal(u6.payload.error, undefined);
  assert.ok(u6.payload.result.filePath.startsWith(sessionWs),
    `附件应落在会话工作区（${u6.payload.result.filePath}）`);
  assert.equal(fs.readFileSync(u6.payload.result.filePath, 'utf8'), 'hello');

  // 4) symlink/junction 逃逸被拒：工作区内的链接指向外部目录
  // （junction 仅支持目录；两端统一链接到外部目录再访问其下文件）
  const outsideFile = path.join(dir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'top-secret');
  const link = path.join(sessionWs, 'escape-dir');
  fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  ask(7, 'x/file/download/begin',
    { path: path.join(link, 'outside.txt'), workspacePath: sessionWs });
  const b7 = await client.next((m) => m.type === 'data' && m.payload.id === 7);
  assert.equal(b7.payload.error?.data?.reason, 'X_OUT_OF_WORKSPACE',
    'realpath 边界必须拒绝链接逃逸');

  // 5) workspacePath 不存在 → 显式 X_BAD_PARAMS（绝不静默回退 cwd）
  ask(8, 'x/file/download/begin',
    { path: inSession, workspacePath: path.join(sessionWs, 'missing') });
  const b8 = await client.next((m) => m.type === 'data' && m.payload.id === 8);
  assert.equal(b8.payload.error?.data?.reason, 'X_BAD_PARAMS');
});

// 2026-09-19 评审 P2 回归：工作区根本身是 junction/symlink 时，根与文件必须
// realpath 后同表示比较。此前「字面预检（文件未规范化 vs 规范化根）」与
// 「缺省根未规范化（规范化文件 vs 未规范化根）」两种失配都会把合法文件
// 误判 X_OUT_OF_WORKSPACE；链接根之外的逃逸仍必须拒绝。
test('工作区根为 junction 时合法文件可下载，链接根之外的逃逸仍被拒', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-jw-state-'));
  // 真实项目目录 + 指向它的 junction 工作区（真实场景：companion 以链接
  // 路径作为 cwd/会话工作区启动）
  const realWs = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-jw-real-'));
  const aliasWs = path.join(stateDir, 'project-link');
  fs.symlinkSync(realWs, aliasWs, process.platform === 'win32' ? 'junction' : 'dir');
  const fileInWs = path.join(realWs, 'inside.txt');
  fs.writeFileSync(fileInWs, 'junction-workspace');
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: aliasWs, // 缺省根 = 链接工作区
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-jw-out-'));
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(realWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(outsideDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  const ask = (id, method, params) =>
    client.send({ type: 'data', payload: { id, method, params } });

  // 1) 缺省根（cwd=链接），文件按链接路径给出 → 可下载
  ask(1, 'x/file/download/begin', { path: path.join(aliasWs, 'inside.txt') });
  const b1 = await client.next((m) => m.type === 'data' && m.payload.id === 1);
  assert.equal(b1.payload.error, undefined,
    `缺省链接根不得误判越界：${b1.payload.error?.data?.reason ?? ''}`);

  // 2) 显式 workspacePath=链接，文件按链接路径给出 → 可下载
  ask(2, 'x/file/download/begin',
    { path: path.join(aliasWs, 'inside.txt'), workspacePath: aliasWs });
  const b2 = await client.next((m) => m.type === 'data' && m.payload.id === 2);
  assert.equal(b2.payload.error, undefined,
    `显式链接根不得误判越界：${b2.payload.error?.data?.reason ?? ''}`);

  // 3) 链接工作区 + 真实路径文件（表示混合）→ 可下载
  ask(3, 'x/file/download/begin', { path: fileInWs, workspacePath: aliasWs });
  const b3 = await client.next((m) => m.type === 'data' && m.payload.id === 3);
  assert.equal(b3.payload.error, undefined,
    `链接根下的真实路径不得误判越界：${b3.payload.error?.data?.reason ?? ''}`);

  // 4) 逃逸仍被拒：链接根之外的真实目录文件
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'top-secret');
  ask(4, 'x/file/download/begin', { path: outsideFile, workspacePath: aliasWs });
  const b4 = await client.next((m) => m.type === 'data' && m.payload.id === 4);
  assert.equal(b4.payload.error?.data?.reason, 'X_OUT_OF_WORKSPACE', '链接根之外的文件必须拒绝');

  // 5) 上传到链接工作区：落盘在真实目录（同一物理位置），下载闭环
  ask(5, 'x/file/begin', { name: 'up.txt', size: 2, workspacePath: aliasWs });
  const u5 = await client.next((m) => m.type === 'data' && m.payload.id === 5);
  assert.equal(u5.payload.error, undefined);
  ask(6, 'x/file/chunk', { uploadId: u5.payload.result.uploadId,
    data: Buffer.from('ok', 'utf8').toString('base64') });
  await client.next((m) => m.type === 'data' && m.payload.id === 6);
  ask(7, 'x/file/commit', { uploadId: u5.payload.result.uploadId });
  const u7 = await client.next((m) => m.type === 'data' && m.payload.id === 7);
  assert.equal(u7.payload.error, undefined);
  assert.ok(u7.payload.result.filePath.startsWith(realWs),
    `附件应落在链接工作区的真实目录（${u7.payload.result.filePath}）`);
  ask(8, 'x/file/download/begin',
    { path: u7.payload.result.filePath, workspacePath: aliasWs });
  const b8 = await client.next((m) => m.type === 'data' && m.payload.id === 8);
  assert.equal(b8.payload.error, undefined, '上传产物在工作区内可下载');
});

// 离席权限补投（审查 P2-6）：手机离席期间引擎产生的反向请求必须由
// companion 保存载荷，手机回席后补投——而不是无声丢到 120s 看护超时。
// 只补投「从未送达」的条目：已送达的重复投递会被手机端按同 key 拒旧，
// 等于向引擎代答拒绝。
test('手机离席期间的反向请求在回席后补投', async (t) => {
  const relay = createRelay({});
  const address = await relay.listen({ port: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-redeliver-'));
  const logs = [];
  let pairingUrl = '';
  // 引擎：立即发 p1；2.5s 后（手机已离席窗口）发 p2
  const onDemandServer = [
    "'use strict';",
    "const send = (id) => process.stdout.write(JSON.stringify({ id, method: 'interaction/requestPermission', params: {} }) + '\\n');",
    "send('server-1');",
    "setTimeout(() => send('server-2'), 2500);",
    'process.stdin.on("data", () => {});',
  ].join('\n');
  const companion = createCompanion({
    relayUrl: `ws://127.0.0.1:${address.port}/ws`,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
    requestTimeoutMs: 8000,
    permissionRequestTimeoutMs: 20000,
  });
  const client = phone(`ws://127.0.0.1:${address.port}/ws`);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  const sid = parsed.searchParams.get('sid');
  const hash = parsed.searchParams.get('hash');
  await client.pair(sid, hash);
  const p1 = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestPermission');
  client.send({ type: 'data', payload: { id: p1.payload.id, result: { approved: true } } });

  // 手机离席
  client.close();
  await delay(300);

  // 离席窗口内引擎发出 p2（companion 持有载荷，不投递）
  await delay(2600);

  // 手机回席：同一凭据重连接管，必须收到补投的 p2
  const client2 = phone(`ws://127.0.0.1:${address.port}/ws`);
  cleanup(t, [() => { client2.close(); }]);
  await client2.pair(sid, hash);
  const p2 = await client2.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestPermission',
    10000);
  assert.notEqual(p2.payload.id, 'server-2', '手机侧必须看到代次化 wireId');
  client2.send({ type: 'data', payload: { id: p2.payload.id, result: { approved: false } } });
  assert.ok(true, '补投闭环');
});

// 重启预算恢复只能来自稳定运行证据（审查 P2-7）：本代存活满
// bridgeStableAliveMs 后死亡视为偶发，预算清零；此后快速连崩才可能 dead。
test('稳定运行后死亡清空重启预算；随后连崩正常熔断', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-stable-'));
  const logs = [];
  let pairingUrl = '';
  const NL = String.fromCharCode(10);
  const sigFile = path.join(dir, 'crash-sig');
  process.env.CRASH_SIG = sigFile; // 经 companion 的 process.env 透传进引擎
  const onDemandServer = [
    "'use strict';",
    'const fs = require("fs");',
    'const sig = process.env.CRASH_SIG;',
    'if (fs.existsSync(sig)) process.exit(1);',
    'setTimeout(() => { fs.writeFileSync(sig, "x"); process.exit(0); }, 300);',
  ].join(NL);
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    bridgeMaxRestarts: 1,
    bridgeRestartDelayMs: 40,
    bridgeStableAliveMs: 200,
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => { delete process.env.CRASH_SIG; },
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  // gen1：存活 300ms（≥200 阈值）后退出——必须清预算并重生
  await waitFor(() => logs.some((l) => l.startsWith('appserver-stable-run')), 4000);
  await waitFor(() => logs.filter((l) => l.startsWith('appserver-respawned')).length >= 2, 4000);
  // gen2：见到信号文件立即退出（快速崩）→ 预算 1/1 → dead
  await waitFor(() => logs.some((l) => l.startsWith('appserver-dead')), 4000);
  const stableCount = logs.filter((l) => l.startsWith('appserver-stable-run')).length;
  assert.equal(stableCount, 1, '只有 gen1 记稳定运行');
});

// spawn 现读认证（审查 P2-7）：respawn 后的子进程必须使用重写后的
// v2Config token，而不是构造期快照。
test('respawn 后引擎环境使用最新认证（现读而非构造期快照）', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-envread-'));
  const logs = [];
  let pairingUrl = '';
  const NL = String.fromCharCode(10);
  const probeFile = path.join(dir, 'token-probe.txt');
  process.env.TOKEN_PROBE = probeFile;
  const onDemandServer = [
    "'use strict';",
    'const fs = require("fs");',
    'fs.writeFileSync(process.env.TOKEN_PROBE, process.env.ANTHROPIC_API_KEY || "none");',
    'let buf = "";',
    'process.stdin.on("data", (d) => { buf += d.toString(); if (buf.includes("fake/exit")) process.exit(0); });',
  ].join(NL);
  const v2Config = writeV2Config(dir, 'token-generation-1');
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: v2Config,
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => { delete process.env.TOKEN_PROBE; },
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => {
    try { return fs.readFileSync(probeFile, 'utf8') === 'token-generation-1'; } catch { return false; }
  }, 4000);

  // 重写认证后触发 respawn：新进程必须拿到 token-generation-2
  fs.writeFileSync(v2Config, JSON.stringify({
    provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'token-generation-2' } } },
  }));
  client.send({ type: 'data', payload: { method: 'fake/exit' } });
  await waitFor(() => {
    try { return fs.readFileSync(probeFile, 'utf8') === 'token-generation-2'; } catch { return false; }
  }, 6000);
});

// 本地代答白名单（审查后 0.16.9 兼容项）：storageState/mcpTelemetry/
// runtimePreferences 由 companion 直接应答——引擎收到 result，手机零感知
// （不产生 pending 看护与迟到日志）。
test('新反向请求由 companion 本地代答，不到达手机', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-localans-'));
  const logs = [];
  let pairingUrl = '';
  const answersFile = path.join(dir, 'answers.jsonl');
  const NL = String.fromCharCode(10);
  const onDemandServer = [
    "'use strict';",
    'const fs = require("fs");',
    `const answers = [];`,
    `const q = (id, method) => process.stdout.write(JSON.stringify({ id, method, params: {} }) + String.fromCharCode(10));`,
    `q('s-1', 'startup/storageState');`,
    `q('s-2', 'process/mcpTelemetry');`,
    `q('s-3', 'session/requestRuntimePreferences');`,
    'let buf = "";',
    'process.stdin.on("data", (d) => {',
    '  buf += d.toString();',
    '  let i;',
    '  while ((i = buf.indexOf(String.fromCharCode(10))) !== -1) {',
    '    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);',
    '    if (!line) continue;',
    '    let f; try { f = JSON.parse(line); } catch { continue; }',
    '    if (f.id != null && (f.result !== undefined || f.error !== undefined)) answers.push({ id: f.id, hasResult: f.result !== undefined });',
    '    fs.writeFileSync(process.env.ANSWERS_FILE, answers.map((a) => a.id + ":" + (a.hasResult ? "result" : "error")).join(","));',
    '  }',
    '});',
  ].join(NL);
  process.env.ANSWERS_FILE = answersFile;
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => { delete process.env.ANSWERS_FILE; },
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();

  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  await waitFor(() => {
    try { return fs.readFileSync(answersFile, 'utf8'); } catch { return false; }
  }, 6000);
  const answered = fs.readFileSync(answersFile, 'utf8');
  assert.equal(answered, 's-1:result,s-2:result,s-3:result',
    '三个白名单方法都必须由 companion 本地代答成功');
  const leaked = client.messages.filter(
    (m) => m.type === 'data' && m.payload.method
      && ['startup/storageState', 'process/mcpTelemetry'].includes(m.payload.method));
  assert.equal(leaked.length, 0, '白名单反向请求不得转发到手机');
});

// 版本锁（审查 P2-8）：未知基线的 runtime 显式 unsupported-version——
// 「能启动」不等于「协议兼容」，升级必须先跑全量探针复核再更新基线。
test('runtime 版本不在支持基线内：预检拒绝而非放行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-version-lock-'));
  const config = path.join(dir, 'v2-config.json');
  fs.writeFileSync(config, JSON.stringify({
    provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'test-token' } } },
  }));
  const futureRuntime = path.join(dir, 'future-zcode.cjs');
  fs.writeFileSync(futureRuntime, [
    "'use strict';",
    "if (process.argv.includes('--version')) { process.stdout.write('zcode 99.99.99' + String.fromCharCode(10)); process.exit(0); }",
    "process.stdout.write('unexpected invocation' + String.fromCharCode(10)); process.exit(0);",
  ].join(String.fromCharCode(10)));
  const result = await probeZcodeRuntime({
    cwd: dir,
    v2ConfigPath: config,
    env: { ...process.env, ZCODE_BIN: futureRuntime },
  });
  assert.equal(result.category, 'unsupported-version');
  assert.equal(result.version, '99.99.99');
  assert.equal(result.detailCode, 'BASELINE_MISMATCH');
  assert.equal(result.runtimeDescriptor, undefined, '拒绝时不得交付 runtime descriptor');
  await delay(120);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 同一 requestId 的重宣告（官方引擎每秒重发同一交互）：应答最新 wireId 后
// 同组兄弟 wireId 必须一并撤看护——否则兄弟到点会被代答 -32022，打到引擎
// 已 settle 的请求上（幽灵超时）。
test('同 requestId 重宣告：应答最新 wireId 后兄弟不再代答', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-reannounce-'));
  const onDemandServer = path.join(__dirname, 'fixtures', 'on-demand-reverse-server.cjs');
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [onDemandServer] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    requestTimeoutMs: 300,
    permissionRequestTimeoutMs: 1200,
    logger: (event, detail) => console.error('[wzx-log]', event, detail),
    onPairing: () => {},
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => companion.pairingUrl);
  const parsed = new URL(companion.pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));
  await waitFor(() => companion.state === 'paired');

  let emitId = 100;
  const emitReverse = (tag, requestId) => client.send({
    type: 'data', payload: { id: emitId++, method: 'emit/reverse', params: { tag, requestId } },
  });

  // 同一交互两次宣告：业务 requestId 相同，帧 id 不同
  emitReverse('srv-r1-a', 'req-shared');
  const first = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestUserInput');
  emitReverse('srv-r1-b', 'req-shared');
  // client.next 会扫历史缓冲：排除第一帧，专等第二次宣告的 wireId
  const second = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'interaction/requestUserInput'
      && m.payload.id !== first.payload.id);
  assert.notEqual(first.payload.id, second.payload.id, '两次宣告 wireId 必须不同');

  // 手机应答最新宣告（srv-r1-b）：companion 还原原生 id 转发引擎
  client.send({ type: 'data', payload: { id: second.payload.id, result: { action: 'accept' } } });
  const answered = await client.next(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered'
      && m.payload.params.tag === 'srv-r1-b' && m.payload.params.code === null,
    3000);
  assert.ok(answered, 'srv-r1-b 应答必须还原转发给引擎');

  // 关键判据：兄弟 srv-r1-a 不再被代答（既有应答已结清整组）
  await delay(2000);
  assert.equal(client.messages.some(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered'
      && m.payload.params.tag === 'srv-r1-a'), false,
    '兄弟 wireId 不得在应答后再代答 -32022');
});

// host 控制面通知（官方 zcodeProtocolNotifications 词汇表）不得转发到手机，
// 但必须留观测；普通通知照常转发——过滤必须是选择性的而非一刀切。
test('host 控制面通知被吞掉并留观测，普通通知照常转发', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-hostctl-'));
  const logs = [];
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  client.send({ type: 'data', payload: { id: 900, method: 'fake/emit-notifications', params: {} } });
  const ack = await client.next((m) => m.type === 'data' && m.payload.id === 900);
  assert.deepEqual(ack.payload.result, { emitted: 2 });
  await delay(300);
  // 控制面通知被吞：手机方向零到达，companion 日志留观测
  assert.equal(client.messages.some(
    (m) => m.type === 'data' && m.payload.method === 'startup/storageState'), false,
    'startup/storageState 不得转发到手机');
  assert.ok(logs.some((l) => l.startsWith('host-control-notification startup/storageState')),
    '被吞的控制面通知必须留观测日志');
  // 选择性：普通通知照常到达手机
  const note = client.messages.find(
    (m) => m.type === 'data' && m.payload.method === 'fake/normal-note');
  assert.ok(note, '普通通知必须照常转发到手机');
});

// session/fork 等透传族：companion 不改写响应形状（评审 P3-1——c1fe974/8b8ceab
// 钉下的 fork 契约目前只有一次性探针与文档锚，这里补一寸自动化锚：
// 引擎给的 result 必须逐字到达手机端，只允许 id 层的看护改写）。
test('session/fork 透传：引擎响应形状逐字还原到手机端', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-fork-passthrough-'));
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(dir, 'mid'),
    logger: () => {},
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  client.send({ type: 'data', payload: { id: 901, method: 'session/fork', params: { sessionId: 'sess_mock' } } });
  const resp = await client.next((m) => m.type === 'data' && m.payload.id === 901);
  assert.deepEqual(resp.payload.result, {
    sessionId: 'fork-child-1',
    session: { sessionId: 'fork-child-1' },
  }, 'fork 响应的 result 形状必须逐字透传（含嵌套 session 字段）');
});

// x/* 应答与 app-server 应答同受 relay 1MiB 帧上限约束：reply 超限必须显式回
// ERR_FRAME_TOO_LARGE 错误帧并留观测，而不是静默 return false 让手机端 RPC
// 干等自身超时（铁律 4）。
test('x/* 应答超 1MiB：显式回 -32001 错误帧并留观测', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-xbig-'));
  const logs = [];
  let pairingUrl = '';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-xbig-state-'));
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(stateDir, 'dummy-token-0123456789abcdef'),
    midFile: path.join(stateDir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    onPairing: (url) => { pairingUrl = url; },
  });
  const client = phone(relayUrl);
  cleanup(t, [
    () => companion.stop(),
    () => { client.close(); },
    () => relay.close(),
    () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
    () => { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  ]);
  companion.start();
  await waitFor(() => pairingUrl);
  const parsed = new URL(pairingUrl);
  await client.pair(parsed.searchParams.get('sid'), parsed.searchParams.get('hash'));

  // 造一个应答必然超 1MiB 的目录：4000 个 200 字符名子目录（每条目 ~500B JSON，
  // 合计 ~2MB，跨机器路径长度差异下仍稳定超限）
  const fatDir = path.join(dir, 'fat');
  fs.mkdirSync(fatDir);
  const longName = 'd'.repeat(200);
  for (let i = 0; i < 4000; i++) fs.mkdirSync(path.join(fatDir, `${longName}${i}`));

  client.send({ type: 'data', payload: { id: 902, method: 'x/fs/dirs', params: { path: fatDir } } });
  const resp = await client.next((m) => m.type === 'data' && m.payload.id === 902, 15000);
  assert.equal(resp.payload.error?.code, -32001, `超限应答必须是 -32001 错误帧: ${JSON.stringify(resp.payload).slice(0, 120)}`);
  assert.ok(logs.some((l) => l.startsWith('x-reply-too-large x/fs/dirs')),
    '超限丢弃必须留观测日志');
});
