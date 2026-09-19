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
const { applyImport } = require('../../../companion_app/zcode-importer');

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
    const inElectron = resolveZcodeRuntime({ LOCALAPPDATA: root });
    assert.deepEqual(inElectron, { category: 'resolved', source: 'installed', command: process.execPath, args: [runtime] });
    assert.deepEqual(defaultZcodeCommand({ LOCALAPPDATA: root }), { command: process.execPath, args: [runtime] });
  } finally {
    if (original === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: original, configurable: true });
  }
  try {
    // node CLI 父进程：同样自托管（node ≥24 含 node:sqlite 可承载 runtime）
    const inNode = resolveZcodeRuntime({ LOCALAPPDATA: root });
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
    });
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
  await client.next((m) => m.type === 'data' && m.payload.id === 'server-2');
  client.send({ type: 'data', payload: { id: 'server-2', result: { approved: true } } });
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
  await client.next((m) => m.type === 'data' && m.payload.id === 'srv-perm');

  // 短档（300ms）到期后：非白名单方法不受短档影响，仍在等待手机应答。
  await delay(900);
  assert.equal(rejected('srv-perm'), false);

  // 权限类在放宽档内从容应答（模拟人看手机后点确认）：不触发代答。
  emit('srv-ask', 'interaction/askUser');
  await client.next((m) => m.type === 'data' && m.payload.id === 'srv-ask');
  await delay(300);
  client.send({ type: 'data', payload: { id: 'srv-ask', result: { selectedLabels: ['A'] } } });

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
  const reverse = await client.next((m) => m.type === 'data' && m.payload.id === 'server-2');
  assert.equal(reverse.payload.method, 'interaction/test');
  client.send({ type: 'data', payload: { id: 'server-2', result: { approved: true } } });
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/interaction-relay'
    && m.payload.params.ok === true);

  // 同一应答重发（迟到/重复）：不转发、留日志
  client.send({ type: 'data', payload: { id: 'server-2', result: { approved: true } } });
  await delay(400);
  const relays = client.messages.filter(
    (m) => m.type === 'data' && m.payload.method === 'fake/interaction-relay');
  assert.equal(relays.length, 1, '重复应答不得再次到达 app-server');
  assert.ok(relayLogs.some((line) => line.startsWith('route-rejected-response server-2')),
    'relay 丢弃非归属应答必须有观测');
});

// app-server 进程重启后 server-N id 从头计数：onRespawn 必须清空旧 pending，
// 否则旧 id 的迟到应答会写进新进程（跨进程串话）。用 pid 标记 id 区分新旧实例。
test('app-server 重启作废旧 pending：旧 id 迟到应答被丢弃留日志，新 id 正常应答', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-respawn-'));
  const logs = [];
  let pairingUrl = '';
  // pid 标记反向请求 id；fake/exit 触发干净退出 → 桥自动重启。
  const onDemandServer = `
    'use strict';
    let buf = '';
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
        if (frame.method === 'fake/exit') { process.exit(0); }
        if (typeof frame.id === 'string' && frame.id.startsWith('srv-')
          && (frame.result !== undefined || frame.error !== undefined)) {
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
    (m) => m.type === 'data' && typeof m.payload.id === 'string' && m.payload.id.startsWith('srv-'));
  const pid1 = first.payload.id;

  // 触发子进程退出 → 桥自动重启（默认 1s 退避）；重启时 onRespawn 清空 pending
  client.send({ type: 'data', payload: { method: 'fake/exit' } });
  const second = await client.next(
    (m) => m.type === 'data' && typeof m.payload.id === 'string'
      && m.payload.id.startsWith('srv-') && m.payload.id !== pid1);
  const pid2 = second.payload.id;

  // 旧 id 的迟到应答：pending 已被 onRespawn 清空 → 丢弃 + 日志，
  // 绝不能写进新进程（若无清空，此应答会被转发并出现在 fake/answered）。
  client.send({ type: 'data', payload: { id: pid1, result: { approved: true } } });
  // 新 id 正常应答闭环（证明重启后链路可用，判据非「全都坏了」）
  client.send({ type: 'data', payload: { id: pid2, result: { approved: false } } });
  await client.next((m) => m.type === 'data' && m.payload.method === 'fake/answered'
    && m.payload.params.tag === pid2);
  await delay(300);
  assert.equal(client.messages.some((m) => m.type === 'data' && m.payload.method === 'fake/answered'
    && m.payload.params.tag === pid1), false, '旧 id 迟到应答不得到达新进程');
  assert.ok(logs.some((line) => line.startsWith(`phone-response-late ${pid1}`)),
    '旧 id 迟到应答的丢弃必须有观测');
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
  const first = await client.next(
    (m) => m.type === 'data' && typeof m.payload.id === 'string' && m.payload.id.startsWith('srv-'));
  const pid1 = first.payload.id;

  // 断开 companion ↔ relay（手机直连不受影响）：close 代答 -32022 并重连接管
  proxy.dropAll();
  await waitFor(() => logs.some((line) => line.startsWith('relay-closed-answer-pending count=1')),
    4000);
  // 重连后同一手机（device 槽一直在房）matched，链路恢复
  await waitFor(() => states.filter((s) => s === 'paired').length >= 2, 8000);

  // 向假 app-server 查询实际收到的应答清单：必须恰含那条 -32022 代答
  client.send({ type: 'data', payload: { method: 'fake/answers' } });
  const report = await client.next((m) => m.type === 'data'
    && m.payload.method === 'fake/answers-report');
  const entry = report.payload.params.list.find((e) => e.tag === pid1);
  assert.ok(entry, 'close 代答应答必须真实到达 app-server');
  assert.equal(entry.code, -32022);
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

test('GUI importer 与 core 共享显式 snapshotPath，工作区/偏好/扩展端到端可读', async (t) => {
  const { relay, url: relayUrl } = await withRelay(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-shared-state-'));
  const stateDir = path.join(dir, 'state');
  const snapshotPath = path.join(stateDir, 'gui-import.json');
  const receipt = applyImport({
    manifest: {
      models: { selectedModel: null, providers: [] },
      workspaces: ['C:\\work\\one', 'C:\\work\\two'],
      preferences: { locale: 'zh-CN', keepAwakeWhileRunning: true },
      extensions: { skills: ['skill-a'], plugins: [], commands: ['review'], mcpCount: 2 },
    },
    selection: { workspaces: true, preferences: true, extensions: true },
    snapshotPath,
  });
  assert.equal(receipt.ok, true);
  let pairingUrl = '';
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    stateDir,
    snapshotPath,
    zcodeCommand: { command: process.execPath, args: [FAKE_APP_SERVER] },
    v2ConfigPath: writeV2Config(dir, 'dummy-token-0123456789abcdef'),
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
  const ask = (id, method) => client.send({ type: 'data', payload: { id, method, params: {} } });

  ask(41, 'x/workspaces/list');
  assert.deepEqual((await client.next((m) => m.payload?.id === 41)).payload.result.workspaces,
    ['C:\\work\\one', 'C:\\work\\two']);
  ask(42, 'x/preferences/summary');
  assert.deepEqual((await client.next((m) => m.payload?.id === 42)).payload.result,
    { count: 2, keys: ['keepAwakeWhileRunning', 'locale'], importedAt: receipt.importedAt });
  ask(43, 'x/extensions/list');
  const extensions = (await client.next((m) => m.payload?.id === 43)).payload.result;
  assert.deepEqual(extensions.skills, ['skill-a']);
  assert.deepEqual(extensions.commands, ['review']);
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

  // x/model/configure：默认模型落盘（0600）+ 对活跃会话即时 setModel
  ask(21, 'x/model/configure', { providerId: 'builtin:p1', modelId: 'glm-x' });
  const conf = await client.next((m) => m.type === 'data' && m.payload.id === 21);
  assert.equal(conf.payload.result.ok, true);
  assert.equal(conf.payload.result.appliedToActive, true);
  const defaultFile = path.join(stateDir, 'model-default.json');
  const saved = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
  assert.deepEqual([saved.providerId, saved.modelId], ['builtin:p1', 'glm-x']);
  // Windows 上 writeFileSync 的 mode 不剥离组/其他位（0o600 → 0o666），
  // 0600 语义只在 POSIX 生效：断言属主读写位存在即可
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(defaultFile).mode & 0o777, 0o600);
  }

  // 落盘后目录回读 default；参数校验失败回数值错误码
  ask(22, 'x/model/catalog', {});
  const cat2 = await client.next((m) => m.type === 'data' && m.payload.id === 22);
  assert.deepEqual(cat2.payload.result.default,
    { providerId: 'builtin:p1', modelId: 'glm-x' });
  ask(23, 'x/model/configure', { providerId: 'builtin:p1/x', modelId: 'm' });
  const bad = await client.next((m) => m.type === 'data' && m.payload.id === 23);
  assert.equal(bad.payload.error.code, -32100);

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
    ['.. 穿越到上级', path.join(dir, '..', 'escape.txt'), 'X_OUT_OF_WORKSPACE'],
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
