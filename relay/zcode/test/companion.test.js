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
const { createCompanion, readRegistrationSecretFile } = require('../companion');

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
      assert.equal(ack.pair_status, 'matched');
    },
    close() { ws.close(); },
  };
}

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
test('反向请求超时按 method 分档：权限/AskUser 放宽、非权限短超时，超时回 -32022', async (t) => {
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
    requestTimeoutMs: 300,            // 非权限类：短档（对应线上 15s 档）
    permissionRequestTimeoutMs: 2000, // 权限/AskUser 类：放宽档（对应线上 120s 档）
    logger: () => {},
    onPairing: () => {},
  });
  const client = phone(relayUrl);
  // 超时代答回给 app-server（不经过手机），故由假 app-server 上报 fake/answered 观察判据。
  const rejected = (tag) => client.messages.some(
    (m) => m.type === 'data' && m.payload.method === 'fake/answered'
      && m.payload.params.tag === tag && m.payload.params.code === -32022);
  const emit = (tag, method) => client.send({
    type: 'data', payload: { id: `emit-${tag}`, method: 'emit/reverse', params: { tag, method } },
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

  // 同挂一条权限类（session/requestPermission）与一条非权限类（workspace/open）。
  emit('srv-perm', 'session/requestPermission');
  emit('srv-plain', 'workspace/open');
  await client.next((m) => m.type === 'data' && m.payload.id === 'srv-perm');
  await client.next((m) => m.type === 'data' && m.payload.id === 'srv-plain');

  // 短档（300ms）到期后：非权限类已被代答拒绝；权限类不受短档影响仍在等待。
  await delay(900);
  assert.equal(rejected('srv-plain'), true);
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
