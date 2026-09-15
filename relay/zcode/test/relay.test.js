'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID, randomBytes, createHash, createHmac } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createRelay, MAX_PAYLOAD } = require('../server');
const { deriveProof, deriveRegisterProof, verifyProof } = require('../lib/proof');
const { classifyFrame, ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT,
  isFastMethod,
  isPermissionLikeMethod } = require('../lib/protocol');
const { runProbe } = require('../probe');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('one MiB JSON boundary forwards, larger JSON disconnects without forwarding', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p = await client(t, f.url); await auth(p, d.sid, d.hash);
  const envelope = { type: 'data', payload: { text: '' }, client_ts: 1 };
  envelope.payload.text = 'x'.repeat(MAX_PAYLOAD - Buffer.byteLength(JSON.stringify(envelope)));
  const raw = JSON.stringify(envelope);
  assert.equal(Buffer.byteLength(raw), MAX_PAYLOAD);
  p.ws.send(raw);
  assert.equal(Buffer.byteLength(JSON.stringify(await d.next('data'))), MAX_PAYLOAD);
  envelope.payload.text += 'x';
  const closed = once(p.ws, 'close'); p.send(envelope); await closed;
  await delay(20);
  assert.equal(d.messages.filter((m) => m.type === 'data').length, 0);
});

test('probe CLI reads QR only from stdin and prints sanitized JSON with mock DESKTOP', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const args = [path.resolve(__dirname, '../probe.js'), '--relay', f.url];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'close');
  child.stdin.end(qr(d));
  for (let i = 0; i < 2; i++) {
    const request = (await d.next('data')).payload;
    d.send({ type: 'data', payload: { zcode_type: request.zcode_type.replace('-request', '-response'),
      requestId: request.requestId, success: true, result: { windowControlSessionId: 'PRIVATE_MOCK',
        workspaces: [{ path: 'PRIVATE_MOCK' }], tasks: [] } } });
  }
  assert.equal((await exited)[0], 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).status, 'ok');
  for (const value of [d.sid, d.hash, qr(d), 'PRIVATE_MOCK']) assert.equal(stdout.includes(value), false);
  assert.equal(args.includes(qr(d)), false);
  await eventually(async () => (await f.health()).sockets === 1);
});

test('relay close is idempotent and terminates open sockets', async (t) => {
  const unused = createRelay();
  await unused.close(); await unused.close();
  await assert.rejects(unused.listen({ port: 0 }));
  const f = await fixture(t);
  const d = await device(t, f.url);
  const closed = once(d.ws, 'close');
  await f.relay.close(); await closed; await f.relay.close();
});

test('malformed JSON, binary, oversize and authentication timeout clean sockets', async (t) => {
  const f = await fixture(t, { authTimeoutMs: 150 });
  for (const raw of ['{', 'null', '[]', Buffer.from('{}')]) {
    const c = await client(t, f.url); c.ws.send(raw);
    assert.equal((await c.next('error')).code, 'BAD_MESSAGE'); await closeClient(c);
  }
  const large = await client(t, f.url);
  const closed = once(large.ws, 'close');
  large.ws.send('x'.repeat(MAX_PAYLOAD + 1)); await closed;
  const idle = await client(t, f.url);
  assert.equal((await idle.next('error')).code, 'AUTH_TIMEOUT'); await closeClient(idle);
  await eventually(async () => (await f.health()).sockets === 0);
});

test('unmatched data from an authenticated peer is dropped without kicking', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  d.send({ type: 'data', payload: { stray: true } });
  // 不回 error、不断连；配对后链路照常可用。
  await delay(100);
  assert.equal(d.messages.some((m) => m.type === 'error'), false);
  const p = await client(t, f.url);
  assert.equal((await auth(p, d.sid, d.hash)).ack.pair_status, 'matched');
  const msg = { type: 'data', payload: { after: 1 } };
  d.send(msg);
  assert.deepEqual(await p.next('data'), msg);
});

test('path and browser origins rejected before upgrade', async (t) => {
  const f = await fixture(t);
  for (const [url, options] of [[f.url.replace('/ws', '/other'), {}],
    [f.url, { origin: 'https://website.invalid' }], [f.url, { origin: 'null' }]]) {
    const ws = new WebSocket(url, options);
    t.after(() => ws.terminate());
    await assert.rejects(once(ws, 'open'), /403/);
  }
  assert.equal((await f.health()).sockets, 0);
});

test('capacity, room expiration and modest per-socket rate limits', async (t) => {
  const f = await fixture(t, { maxRooms: 1, maxDevices: 1, roomTtlMs: 50, sweepIntervalMs: 10, rateLimit: 5 });
  const d = await device(t, f.url);
  const mid = randomUUID();
  const extra = await client(t, `${f.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  extra.send({ type: 'device_register_init', device_mid: mid, pass_hash: d.hash });
  assert.equal((await extra.next('error')).code, 'CAPACITY');
  for (let i = 0; i < 3; i++) d.send({ type: 'pair_status_query', device_sid: d.sid });
  assert.equal((await d.next('error')).code, 'RATE_LIMITED');
  await eventually(async () => (await f.health()).rooms === 0);
  const old = await client(t, f.url);
  old.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
  assert.equal((await old.next('error')).code, 'AUTH_FAILED');
});

test('socket cap and ping/pong cleanup', async (t) => {
  const f = await fixture(t, { maxSockets: 1, pingIntervalMs: 40 });
  const c = await client(t, f.url, { autoPong: false });
  const blocked = new WebSocket(f.url);
  t.after(() => blocked.terminate());
  await assert.rejects(once(blocked, 'open'), /403/);
  await once(c.ws, 'close');
  await eventually(async () => (await f.health()).sockets === 0);
});

test('probe with mock DESKTOP returns only sanitized counts and known field names', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const running = runProbe({ relayUrl: f.url, qrUrl: qr(d), timeoutMs: 2000 });
  const first = (await d.next('data')).payload;
  const second = (await d.next('data')).payload;
  assert.deepEqual([first.zcode_type, second.zcode_type].sort(), ['bootstrap-request', 'workspace-list-request']);
  assert.notEqual(first.requestId, second.requestId);
  for (const request of [first, second]) assert.deepEqual(Object.keys(request).sort(), ['requestId', 'zcode_type']);
  // 故意包含敏感 mock 字段，验证它们不会出现在输出中。
  const secret = 'SENSITIVE_MOCK_TITLE_PATH_ID';
  const result = { windowControlSessionId: secret, workspaces: [{ id: secret, path: secret, title: secret }],
    tasks: [{ id: secret }, { title: secret }], [secret]: secret };
  d.send({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId: 'uncorrelated', result: {} } });
  for (const request of [second, first]) {
    d.send({ type: 'data', payload: { zcode_type: request.zcode_type.replace('-request', '-response'), requestId: request.requestId, success: true, result } });
  }
  const summary = await running;
  assert.deepEqual(summary, { status: 'ok',
    bootstrap: { status: 'ok', workspaceCount: 1, taskCount: 2, fields: ['windowControlSessionId', 'workspaces', 'tasks'] },
    workspaceList: { status: 'ok', workspaceCount: 1, taskCount: 2, fields: ['windowControlSessionId', 'workspaces', 'tasks'] } });
  for (const value of [secret, d.sid, d.hash, first.requestId, qr(d)]) assert.equal(JSON.stringify(summary).includes(value), false);
  await eventually(async () => (await f.health()).sockets === 1);
});

test('probe waits for device authentication and accepts list without tasks', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url, false);
  const running = runProbe({ relayUrl: f.url, qrUrl: qr(d), timeoutMs: 2000 });
  await eventually(async () => (await f.health()).sockets === 2);
  await delay(30);
  assert.equal(d.messages.filter((m) => m.type === 'data').length, 0);
  await auth(d, d.sid, d.hash, 'device');
  for (let i = 0; i < 2; i++) {
    const request = (await d.next('data')).payload;
    const result = request.zcode_type === 'bootstrap-request'
      ? { windowControlSessionId: 'mock-only', workspaces: [], tasks: [] } : { workspaces: [] };
    d.send({ type: 'data', payload: { zcode_type: request.zcode_type.replace('-request', '-response'), requestId: request.requestId, success: true, result } });
  }
  assert.deepEqual((await running).workspaceList, { status: 'ok', workspaceCount: 0, fields: ['workspaces'] });
});

test('probe timeout, app error, malformed result and device disconnect reject and clean up', async (t) => {
  for (const mode of ['timeout', 'error', 'invalid', 'disconnect']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const d = await device(t, f.url);
      const outcome = runProbe({ relayUrl: f.url, qrUrl: qr(d), timeoutMs: 200 }).then(
        () => assert.fail('Expected rejection'), (error) => error);
      const request = (await d.next('data')).payload;
      if (mode === 'disconnect') await closeClient(d);
      else if (mode !== 'timeout') d.send({ type: 'data', payload: {
        zcode_type: request.zcode_type.replace('-request', '-response'), requestId: request.requestId,
        ...(mode === 'error' ? { error: 'SECRET_APP_ERROR' } : { success: true, result: { workspaces: 'SECRET_INVALID' } }),
      } });
      const error = await outcome;
      assert.equal(error.code, { timeout: 'TIMEOUT', error: 'APP_ERROR', invalid: 'INVALID_RESPONSE', disconnect: 'DISCONNECTED' }[mode]);
      assert.equal(error.message.includes('SECRET'), false);
      await eventually(async () => (await f.health()).sockets === (mode === 'disconnect' ? 0 : 1));
    });
  }
});

test('probe rejects missing or non-boolean success even with valid results', async (t) => {
  for (const type of ['bootstrap-request', 'workspace-list-request']) {
    for (const success of [undefined, 'true', 1]) {
      await t.test(`${type}: ${String(success)}`, async (t) => {
        const f = await fixture(t);
        const d = await device(t, f.url);
        const outcome = assert.rejects(runProbe({ relayUrl: f.url, qrUrl: qr(d), timeoutMs: 2000 }),
          { code: 'INVALID_RESPONSE' });
        const request = (await d.next('data', (m) => m.payload.zcode_type === type)).payload;
        d.send({ type: 'data', payload: { zcode_type: type.replace('-request', '-response'),
          requestId: request.requestId, ...(success === undefined ? {} : { success }),
          result: { windowControlSessionId: 'mock-only', workspaces: [], tasks: [] } } });
        await outcome;
        await eventually(async () => (await f.health()).sockets === 1);
      });
    }
  }
});

test('probe validates supplied URLs and never infers relay from QR origin', async () => {
  for (const relayUrl of [undefined, 'https://127.0.0.1/ws', 'ws://example.invalid/ws', 'ws://localhost/ws',
    'ws://127.0.0.1/other', 'ws://127.0.0.1/ws?token=private']) {
    await assert.rejects(runProbe({ relayUrl, qrUrl: 'https://example.invalid/?sid=x&hash=x' }), { code: 'INVALID_INPUT' });
  }
  for (const qrUrl of ['file:///private', 'javascript:secret', 'https://example.invalid/?sid=x']) {
    await assert.rejects(runProbe({ relayUrl: 'ws://127.0.0.1:18884/ws', qrUrl }), { code: 'INVALID_INPUT' });
  }
});

async function fixture(t, options) {
  const relay = createRelay(options);
  t.after(() => relay.close());
  const address = await relay.listen({ port: 0 });
  assert.equal(address.address, '127.0.0.1');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const health = async () => (await fetch(`http://127.0.0.1:${address.port}/health`)).json();
  return { relay, url, health };
}
async function client(t, url, options) {
  const ws = new WebSocket(url, options);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return { ws, messages, send: (msg) => ws.send(JSON.stringify(msg)),
    async next(type, predicate = () => true) {
      for (let i = 0; i < 200; i++) {
        const index = messages.findIndex((msg) => msg.type === type && predicate(msg));
        if (index !== -1) return messages.splice(index, 1)[0];
        await delay(5);
      }
      assert.fail(`Missing message type: ${type}`);
    },
  };
}
const proofFor = (hash, nonce, role, sid) => createHmac('sha256', hash).update(`${nonce}|${role}|${sid}`).digest('base64url');
async function challenge(c, sid, role = 'probe') {
  c.send({ type: 'auth_init', role, device_sid: sid });
  return (await c.next('auth_challenge')).nonce;
}
async function auth(c, sid, hash, role = 'probe') {
  const nonce = await challenge(c, sid, role);
  const response = { type: 'auth_response', device_sid: sid, proof: proofFor(hash, nonce, role, sid) };
  c.send(response);
  const ack = await c.next('auth_ack');
  return { response, ack };
}
async function device(t, url, authenticate = true, suppliedSid) {
  const mid = randomUUID();
  const hash = createHash('sha256').update(randomBytes(32)).digest('base64');
  const c = await client(t, `${url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  c.send({ type: 'device_register_init', device_mid: mid, pass_hash: hash,
    device_sid: suppliedSid, meta: { name: 'mock DESKTOP' }, client_ts: Date.now() });
  const sid = (await c.next('device_register_ack')).device_sid;
  if (authenticate) assert.equal((await auth(c, sid, hash, 'device')).ack.pair_status, 'waiting');
  return Object.assign(c, { sid, hash });
}
async function closeClient(c) {
  if (c.ws.readyState === WebSocket.CLOSED) return;
  const closed = once(c.ws, 'close'); c.ws.close(); await closed;
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  assert.fail('Condition not reached');
}
function qr(d) {
  const url = new URL('https://untrusted.invalid/mobile');
  url.searchParams.set('sid', d.sid); url.searchParams.set('hash', d.hash);
  return url.href;
}

test('mock DESKTOP registration, peer arrival, heartbeat, roundtrip and peer loss', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p = await client(t, f.url);
  assert.equal((await auth(p, d.sid, d.hash)).ack.pair_status, 'matched');
  await d.next('pair_status_ack', (m) => m.pair_status === 'matched');
  p.send({ type: 'pair_status_query', device_sid: d.sid });
  await p.next('pair_status_ack', (m) => m.pair_status === 'matched');
  const msg = { type: 'data', payload: { sample: 1 }, client_ts: 123 };
  p.send(msg); assert.deepEqual(await d.next('data'), msg);
  d.send(msg); assert.deepEqual(await p.next('data'), msg);
  d.messages.length = 0;
  await closeClient(p);
  await d.next('pair_status_ack', (m) => m.pair_status === 'waiting');
  assert.deepEqual(await f.health(), { status: 'ok', sockets: 1, rooms: 1, devices: 1 });
});

test('mock DESKTOP reconnects using same sid/hash and re-matches existing probe without registration', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const originalQr = qr(d);
  const p = await client(t, f.url); await auth(p, d.sid, d.hash);
  await p.next('pair_status_ack', (m) => m.pair_status === 'matched');
  await closeClient(d);
  await p.next('pair_status_ack', (m) => m.pair_status === 'waiting');

  const wrong = await client(t, f.url);
  const wrongNonce = await challenge(wrong, d.sid, 'device');
  wrong.send({ type: 'auth_response', device_sid: d.sid,
    proof: proofFor('wrong-key', wrongNonce, 'device', d.sid) });
  assert.equal((await wrong.next('error')).code, 'AUTH_FAILED');
  await closeClient(wrong);

  const late = await client(t, f.url);
  const lateNonce = await challenge(late, d.sid, 'device');
  const reconnected = await client(t, f.url);
  assert.equal((await auth(reconnected, d.sid, d.hash, 'device')).ack.pair_status, 'matched');
  await p.next('pair_status_ack', (m) => m.pair_status === 'matched');
  late.send({ type: 'auth_response', device_sid: d.sid,
    proof: proofFor(d.hash, lateNonce, 'device', d.sid) });
  assert.equal((await late.next('error')).code, 'PEER_EXISTS');
  await closeClient(late);
  const duplicate = await client(t, f.url);
  duplicate.send({ type: 'auth_init', role: 'device', device_sid: d.sid });
  assert.equal((await duplicate.next('error')).code, 'PEER_EXISTS');
  await closeClient(duplicate);

  const msg = { type: 'data', payload: { mockReconnected: true } };
  p.send(msg); assert.deepEqual(await reconnected.next('data'), msg);
  reconnected.send(msg); assert.deepEqual(await p.next('data'), msg);
  assert.equal(reconnected.messages.some((m) => m.type === 'device_register_ack'), false);
  assert.equal(qr(d), originalQr);
  assert.deepEqual(await f.health(), { status: 'ok', sockets: 2, rooms: 1, devices: 1 });
});

test('half-open probe (missed heartbeat) is taken over by a reconnecting probe', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p1 = await client(t, f.url);
  assert.equal((await auth(p1, d.sid, d.hash)).ack.pair_status, 'matched');

  // 模拟半开：socket 仍 OPEN 但已错过心跳（alive=false）——手机断网后立即重连的场景
  // （sockets 表键为服务端 ws 对象，按 角色+房间 反查 state；close 先监听再触发，避免错过事件）
  const p1Closed = once(p1.ws, 'close');
  const p1State = [...f.relay._sockets.values()].find((s) => s.role === 'probe' && s.room?.sid === d.sid);
  assert.ok(p1State, 'probe state not found');
  p1State.lastPongAt = 0;

  const p2 = await client(t, f.url);
  const nonce = await challenge(p2, d.sid);
  p2.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor(d.hash, nonce, 'probe', d.sid) });
  assert.equal((await p2.next('auth_ack')).pair_status, 'matched');
  // 旧 socket 被清理，新端可正常收发
  await p1Closed;
  const msg = { type: 'data', payload: { takeover: 1 } };
  p2.send(msg);
  assert.deepEqual(await d.next('data'), msg);
});

test('healthy probe incumbents protected: extra probe rejected at capacity', async (t) => {
  await t.test('default capacity 3 rejects the 4th probe', async (t) => {
    const f = await fixture(t);
    const d = await device(t, f.url);
    const probes = [];
    for (let i = 0; i < 3; i++) {
      const p = await client(t, f.url);
      assert.equal((await auth(p, d.sid, d.hash)).ack.pair_status, 'matched');
      probes.push(p);
    }
    const fourth = await client(t, f.url);
    fourth.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
    assert.equal((await fourth.next('error')).code, 'CAPACITY');
    await delay(30);
    // 在位 probe 均健康存活，未被清退
    for (const p of probes) assert.equal(p.ws.readyState, WebSocket.OPEN);
  });
  await t.test('maxProbes is configurable', async (t) => {
    const f = await fixture(t, { maxProbes: 2 });
    const d = await device(t, f.url);
    const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
    const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
    const third = await client(t, f.url);
    third.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
    assert.equal((await third.next('error')).code, 'CAPACITY');
    const msg = { type: 'data', payload: { pair: 'intact' } };
    p1.send(msg); assert.deepEqual(await d.next('data'), msg);
  });
});

test('deterministic sid: re-register and relay restart keep the same room identity', async (t) => {
  const mid = randomUUID();
  const hash = createHash('sha256').update(randomBytes(32)).digest('base64');
  const f = await fixture(t);
  const d1 = await client(t, `${f.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  d1.send({ type: 'device_register_init', device_mid: mid, pass_hash: hash });
  const sid1 = (await d1.next('device_register_ack')).device_sid;
  await closeClient(d1);

  // 同 mid+hash 重注册（模拟 companion 进程重启）：同 sid、房间可继续配对
  const d2 = await client(t, `${f.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  d2.send({ type: 'device_register_init', device_mid: mid, pass_hash: hash });
  assert.equal((await d2.next('device_register_ack')).device_sid, sid1);
  const p = await client(t, f.url);
  assert.equal((await auth(p, sid1, hash)).ack.pair_status, 'waiting');
  await closeClient(d2); await closeClient(p);

  // 换 hash（口令轮换）→ 不同 sid，旧房间自然过期
  const hash2 = createHash('sha256').update(randomBytes(32)).digest('base64');
  const d3 = await client(t, `${f.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  d3.send({ type: 'device_register_init', device_mid: mid, pass_hash: hash2 });
  assert.notEqual((await d3.next('device_register_ack')).device_sid, sid1);
  await closeClient(d3);

  // 跨 relay 实例（容器重启）：同 mid+hash 仍得到同一 sid
  await f.relay.close();
  const f2 = await fixture(t);
  const d4 = await client(t, `${f2.url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  d4.send({ type: 'device_register_init', device_mid: mid, pass_hash: hash });
  assert.equal((await d4.next('device_register_ack')).device_sid, sid1);
});

test('preauth data, unknown room/role, wrong proof length/key, and replay rejected', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  for (const msg of [{ type: 'data', payload: {} },
    { type: 'auth_init', role: 'probe', device_sid: 'missing' },
    { type: 'auth_init', role: 'terminal', device_sid: d.sid }]) {
    const c = await client(t, f.url); c.send(msg); await c.next('error'); await closeClient(c);
  }
  for (const key of [null, Buffer.from(d.hash, 'base64'), 'wrong-key']) {
    const c = await client(t, f.url);
    const nonce = await challenge(c, d.sid);
    c.send({ type: 'auth_response', device_sid: d.sid, proof: key === null ? 'short' : proofFor(key, nonce, 'probe', d.sid) });
    assert.equal((await c.next('error')).code, 'AUTH_FAILED'); await closeClient(c);
  }
  const p = await client(t, f.url);
  const { response } = await auth(p, d.sid, d.hash);
  p.send(response); assert.equal((await p.next('error')).code, 'AUTH_FAILED'); await closeClient(p);
  const p2 = await client(t, f.url);
  await challenge(p2, d.sid); p2.send(response);
  assert.equal((await p2.next('error')).code, 'AUTH_FAILED');
  assert.equal(d.ws.readyState, WebSocket.OPEN);
  assert.equal(d.messages.filter((m) => m.type === 'data').length, 0);
});

test('probe beyond capacity rejected while existing pair survives, including auth race', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  // 质询发出时槽位未满，应答时已被占满 → 认证竞态按容量拒绝
  const late = await client(t, f.url);
  const nonce = await challenge(late, d.sid);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
  const p3 = await client(t, f.url); await auth(p3, d.sid, d.hash);
  late.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor(d.hash, nonce, 'probe', d.sid) });
  assert.equal((await late.next('error')).code, 'CAPACITY');
  const fourth = await client(t, f.url);
  fourth.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
  assert.equal((await fourth.next('error')).code, 'CAPACITY');
  const fakeDevice = await client(t, f.url);
  fakeDevice.send({ type: 'auth_init', role: 'device', device_sid: d.sid });
  // owner 保护：健康在位的注册者挡下陌生端（PEER_EXISTS 而非 AUTH_FAILED）
  assert.equal((await fakeDevice.next('error')).code, 'PEER_EXISTS');
  p1.send({ type: 'data', payload: { alive: true } });
  assert.deepEqual((await d.next('data')).payload, { alive: true });
  assert.equal(p1.ws.readyState, WebSocket.OPEN);
});

test('two probes join the same paired room in either arrival order', async (t) => {
  await t.test('device authenticated first', async (t) => {
    const f = await fixture(t);
    const d = await device(t, f.url);
    const p1 = await client(t, f.url);
    assert.equal((await auth(p1, d.sid, d.hash)).ack.pair_status, 'matched');
    const p2 = await client(t, f.url);
    assert.equal((await auth(p2, d.sid, d.hash)).ack.pair_status, 'matched');
    // 任一 probe 加入都要让在位成员感知最新 pair_status
    await p1.next('pair_status_ack', (m) => m.pair_status === 'matched');
    await d.next('pair_status_ack', (m) => m.pair_status === 'matched');
    assert.deepEqual(await f.health(), { status: 'ok', sockets: 3, rooms: 1, devices: 1 });
  });
  await t.test('probes waiting before the device authenticates', async (t) => {
    const f = await fixture(t);
    const d = await device(t, f.url, false);
    const p1 = await client(t, f.url);
    assert.equal((await auth(p1, d.sid, d.hash)).ack.pair_status, 'waiting');
    const p2 = await client(t, f.url);
    assert.equal((await auth(p2, d.sid, d.hash)).ack.pair_status, 'waiting');
    await auth(d, d.sid, d.hash, 'device');
    await p1.next('pair_status_ack', (m) => m.pair_status === 'matched');
    await p2.next('pair_status_ack', (m) => m.pair_status === 'matched');
  });
});

test('partial probe departure keeps the room matched for the remaining probe', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
  d.messages.length = 0; p1.messages.length = 0; p2.messages.length = 0;
  await closeClient(p1);
  // 一台离席：device 与幸存 probe 看到的仍是 matched，不能回落成 waiting
  await d.next('pair_status_ack', (m) => m.pair_status === 'matched');
  await p2.next('pair_status_ack', (m) => m.pair_status === 'matched');
  await delay(30);
  assert.equal(d.messages.some((m) => m.type === 'pair_status_ack' && m.pair_status === 'waiting'), false);
  const msg = { type: 'data', payload: { alive: 1 } };
  p2.send(msg); assert.deepEqual(await d.next('data'), msg);
  d.send(msg); assert.deepEqual(await p2.next('data'), msg);
  // 最后一台离席：device 才看到 waiting
  d.messages.length = 0;
  await closeClient(p2);
  await d.next('pair_status_ack', (m) => m.pair_status === 'waiting');
  assert.deepEqual(await f.health(), { status: 'ok', sockets: 1, rooms: 1, devices: 1 });
});

test('room expires by TTL only after the device and all probes have left', async (t) => {
  const f = await fixture(t, { roomTtlMs: 50, sweepIntervalMs: 10 });
  const d = await device(t, f.url);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
  await closeClient(p1); await closeClient(p2);
  await delay(80); // 超过 roomTtl，但 device 仍在房 → 不过期
  assert.equal((await f.health()).rooms, 1);
  await closeClient(d);
  await eventually(async () => (await f.health()).rooms === 0);
  const late = await client(t, f.url);
  late.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
  assert.equal((await late.next('error')).code, 'AUTH_FAILED');
});

test('device broadcast reaches every probe while probe upstream goes to device only', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
  const down = { type: 'data', payload: { broadcast: true } };
  d.send(down);
  assert.deepEqual(await p1.next('data'), down);
  assert.deepEqual(await p2.next('data'), down);
  p1.send({ type: 'data', payload: { from: 'p1' } });
  assert.deepEqual((await d.next('data')).payload, { from: 'p1' });
  p2.send({ type: 'data', payload: { from: 'p2' } });
  assert.deepEqual((await d.next('data')).payload, { from: 'p2' });
  await delay(30);
  // probe 之间不互通：p2 收不到 p1 的上行，p1 收不到 p2 的上行
  assert.equal(p2.messages.some((m) => m.type === 'data' && m.payload.from === 'p1'), false);
  assert.equal(p1.messages.some((m) => m.type === 'data' && m.payload.from === 'p2'), false);
});

test('matched data frames are exempt from the per-socket rate limit', async (t) => {
  const f = await fixture(t, { rateLimit: 20, rateWindowMs: 10000 });
  const d = await device(t, f.url);
  const p = await client(t, f.url); await auth(p, d.sid, d.hash);
  // 流式回合的真实形状：配对成员的 data 帧密度远超控制帧限流阈值。
  // 50 帧（> rateLimit=20）在 10s 窗口内连发，连接不得被 RATE_LIMITED 掐断。
  for (let i = 0; i < 50; i += 1) d.send({ type: 'data', payload: { seq: i } });
  for (let i = 0; i < 50; i += 1) assert.deepEqual((await p.next('data')).payload, { seq: i });
  assert.equal(d.ws.readyState, WebSocket.OPEN);
  assert.equal(p.ws.readyState, WebSocket.OPEN);
  // 控制帧仍受限流约束：超发 pair_status_query 应被 RATE_LIMITED 拒绝
  for (let i = 0; i < 30; i += 1) p.send({ type: 'pair_status_query', device_sid: d.sid });
  assert.equal((await p.next('error')).code, 'RATE_LIMITED');
});

test('stale probe slot is reclaimed individually while healthy probes stay connected', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  const p2 = await client(t, f.url); await auth(p2, d.sid, d.hash);
  const p3 = await client(t, f.url); await auth(p3, d.sid, d.hash);
  // 房间满员后模拟 p3 半开（socket 仍 OPEN 但错过心跳）：新 probe 应只接管 p3 的槽位。
  // _sockets 按连接顺序插入，同房间 probe 过滤后的第 3 个即 p3 的服务端状态。
  const probeStates = [...f.relay._sockets.values()].filter((s) => s.role === 'probe' && s.room?.sid === d.sid);
  assert.equal(probeStates.length, 3);
  probeStates[2].lastPongAt = 0;
  const p3Closed = once(p3.ws, 'close');
  const p4 = await client(t, f.url);
  assert.equal((await auth(p4, d.sid, d.hash)).ack.pair_status, 'matched');
  await p3Closed;
  assert.equal(p1.ws.readyState, WebSocket.OPEN);
  assert.equal(p2.ws.readyState, WebSocket.OPEN);
  const msg = { type: 'data', payload: { after: 'takeover' } };
  p4.send(msg); assert.deepEqual(await d.next('data'), msg);
  d.send(msg); assert.deepEqual(await p4.next('data'), msg);
});

test('unverified takeover attempts cause no side effects on room members', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const p1 = await client(t, f.url); await auth(p1, d.sid, d.hash);
  // 仅持 sid 的未认证端：质询应答验证失败不得清场，在位成员照常收发
  const attacker = await client(t, f.url);
  const nonce = await challenge(attacker, d.sid);
  attacker.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor('wrong-key', nonce, 'probe', d.sid) });
  assert.equal((await attacker.next('error')).code, 'AUTH_FAILED');
  const fakeDevice = await client(t, f.url);
  fakeDevice.send({ type: 'auth_init', role: 'device', device_sid: d.sid });
  // owner 保护：健康在位的注册者挡下陌生端（PEER_EXISTS），同样零副作用；
  // owner 陈旧时陌生端可拿到质询，但不持正确密钥仍在 auth_response 被拒。
  assert.equal((await fakeDevice.next('error')).code, 'PEER_EXISTS');
  await delay(30);
  assert.equal(p1.ws.readyState, WebSocket.OPEN);
  assert.equal(d.ws.readyState, WebSocket.OPEN);
  const keep = { type: 'data', payload: { intact: true } };
  p1.send(keep); assert.deepEqual(await d.next('data'), keep);
  // probe 半开槽位同样只对验证通过的端开放：错误 proof 不清场，正主才能接管
  const p1State = [...f.relay._sockets.values()].find((s) => s.role === 'probe' && s.room?.sid === d.sid);
  p1State.lastPongAt = 0;
  const attacker2 = await client(t, f.url);
  const nonce2 = await challenge(attacker2, d.sid);
  attacker2.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor('wrong-key', nonce2, 'probe', d.sid) });
  assert.equal((await attacker2.next('error')).code, 'AUTH_FAILED');
  await delay(30);
  assert.equal(p1.ws.readyState, WebSocket.OPEN); // 半开在位端未被未验证端清场
  const p1Closed = once(p1.ws, 'close');
  const p2 = await client(t, f.url);
  assert.equal((await auth(p2, d.sid, d.hash)).ack.pair_status, 'matched');
  await p1Closed;
  // device 半开槽位：owner 归属校验会拦下陌生端，故先让正主 d 断开、二任 d2 接管
  // 原槽位并进入半开，攻击者才能拿到质询——但不持正确密钥，不得清场。
  await closeClient(d);
  const d2 = await client(t, f.url);
  assert.equal((await auth(d2, d.sid, d.hash, 'device')).ack.pair_status, 'matched');
  const d2State = [...f.relay._sockets.values()].find((s) => s.role === 'device' && s.room?.sid === d.sid);
  d2State.lastPongAt = 0;
  const attacker3 = await client(t, f.url);
  const nonce3 = await challenge(attacker3, d.sid, 'device');
  attacker3.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor('wrong-key', nonce3, 'device', d.sid) });
  assert.equal((await attacker3.next('error')).code, 'AUTH_FAILED');
  await delay(30);
  assert.equal(d2.ws.readyState, WebSocket.OPEN); // 半开 device 未被未验证端清场
  const d2Closed = once(d2.ws, 'close');
  const d3 = await client(t, f.url);
  assert.equal((await auth(d3, d.sid, d.hash, 'device')).ack.pair_status, 'matched');
  await d2Closed;
  const after = { type: 'data', payload: { recovered: true } };
  p2.send(after); assert.deepEqual(await d3.next('data'), after);
});

test('registration generates unique sid and forwarding cannot cross rooms', async (t) => {
  const f = await fixture(t);
  const a = await device(t, f.url);
  const b = await device(t, f.url, true, a.sid);
  assert.notEqual(a.sid, b.sid);
  const pa = await client(t, f.url); await auth(pa, a.sid, a.hash);
  const pb = await client(t, f.url); await auth(pb, b.sid, b.hash);
  pa.send({ type: 'data', device_sid: b.sid, payload: { destination: b.sid } });
  await a.next('data'); await delay(30);
  assert.equal(b.messages.filter((m) => m.type === 'data').length, 0);
  assert.equal(pb.messages.filter((m) => m.type === 'data').length, 0);
});

// —— 注册共享密钥（registrationSecret，防公网注册 DoS）——

// 带 mid 的裸客户端：只连不发注册帧，供各注册变体自行拼帧。
async function registerClient(t, url) {
  const mid = randomUUID();
  const c = await client(t, `${url}?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  return Object.assign(c, { mid });
}

test('registrationSecret 设置后：无 proof/错 secret/hex 编码注册被拒，正确 proof 成功', async (t) => {
  const secret = 'relay-test-registration-secret';
  const f = await fixture(t, { registrationSecret: secret });
  const hash = createHash('sha256').update(randomBytes(32)).digest('base64');

  // 无 register_proof：拒绝
  const bare = await registerClient(t, f.url);
  bare.send({ type: 'device_register_init', device_mid: bare.mid, pass_hash: hash });
  assert.equal((await bare.next('error')).code, 'AUTH_FAILED');
  await closeClient(bare);

  // 错误 secret 推导的 proof：拒绝
  const wrong = await registerClient(t, f.url);
  wrong.send({ type: 'device_register_init', device_mid: wrong.mid, pass_hash: hash,
    register_proof: deriveRegisterProof({ secret: 'not-the-secret', mid: wrong.mid }) });
  assert.equal((await wrong.next('error')).code, 'AUTH_FAILED');
  await closeClient(wrong);

  // hex 编码的正确 HMAC：形状不符（非 base64url 定长 43），拒绝
  const hexish = await registerClient(t, f.url);
  hexish.send({ type: 'device_register_init', device_mid: hexish.mid, pass_hash: hash,
    register_proof: createHmac('sha256', secret).update(hexish.mid).digest('hex') });
  assert.equal((await hexish.next('error')).code, 'AUTH_FAILED');
  await closeClient(hexish);

  // 正确 base64url proof：注册成功，后续质询配对流程照常可用
  const ok = await registerClient(t, f.url);
  ok.send({ type: 'device_register_init', device_mid: ok.mid, pass_hash: hash,
    register_proof: deriveRegisterProof({ secret, mid: ok.mid }) });
  const sid = (await ok.next('device_register_ack')).device_sid;
  assert.equal((await auth(ok, sid, hash, 'device')).ack.pair_status, 'waiting');

  // 拒绝路径零残留：被拒注册不占房间/设备槽（等被拒 socket 完成关闭）
  await eventually(async () => (await f.health()).sockets === 1);
  assert.deepEqual(await f.health(), { status: 'ok', sockets: 1, rooms: 1, devices: 1 });
});

test('registrationSecret 未设置时无 proof 注册照常成功（兼容）', async (t) => {
  const f = await fixture(t);
  const plain = await registerClient(t, f.url);
  const hash = createHash('sha256').update(randomBytes(32)).digest('base64');
  plain.send({ type: 'device_register_init', device_mid: plain.mid, pass_hash: hash });
  // 旧客户端形状（无 register_proof 字段）必须继续可用，本地开发/测试零摩擦
  assert.equal(typeof (await plain.next('device_register_ack')).device_sid, 'string');
});

test('registrationSecret 选项校验：非法值抛错，null/undefined 视为未设置', async (t) => {
  for (const value of ['', 123, {}]) {
    assert.throws(() => createRelay({ registrationSecret: value }), /Invalid registration secret/);
  }
  for (const value of [undefined, null]) {
    const relay = createRelay({ registrationSecret: value });
    t.after(() => relay.close());
  }
});

// —— 共享模块单测（lib/proof 与 lib/protocol）——

test('lib/proof：deriveProof 与独立实现逐字节一致，verifyProof 严格拒不符', () => {
  const nonce = randomBytes(32).toString('base64url');
  const role = 'probe';
  const sid = randomUUID();
  const hash = createHash('sha256').update(randomBytes(32)).digest('base64');
  const proof = deriveProof({ passHash: hash, nonce, role, sid });
  // proofFor 是测试侧的独立 HMAC 实现：两侧语义漂移会在此暴露
  assert.equal(proof, proofFor(hash, nonce, role, sid));
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyProof({ proof, passHash: hash, nonce, role, sid }), true);
  assert.equal(verifyProof({ proof, passHash: 'wrong-key', nonce, role, sid }), false);
  assert.equal(verifyProof({ proof, passHash: hash, nonce, role: 'device', sid }), false);
  assert.equal(verifyProof({ proof, passHash: hash, nonce: 'other', role, sid }), false);
  assert.equal(verifyProof({ proof, passHash: hash, nonce, role, sid: randomUUID() }), false);
  // hex/短串/非字符串形状一律拒绝
  assert.equal(verifyProof({ proof: Buffer.from(proof, 'base64url').toString('hex'), passHash: hash, nonce, role, sid }), false);
  assert.equal(verifyProof({ proof: 'short', passHash: hash, nonce, role, sid }), false);
  assert.equal(verifyProof({ proof: null, passHash: hash, nonce, role, sid }), false);
});

test('lib/protocol：classifyFrame 帧分类与错误码常量', () => {
  assert.equal(classifyFrame({ id: 1, method: 'session/list', params: {} }), 'request');
  assert.equal(classifyFrame({ id: 'server-1', method: 'session/requestPermission', params: {} }), 'reverse-request');
  assert.equal(classifyFrame({ method: 'session/event', params: {} }), 'notification');
  assert.equal(classifyFrame({ id: 1, result: { ok: true } }), 'response');
  assert.equal(classifyFrame({ id: 'server-1', error: { code: -32022, message: 'x' } }), 'response');
  assert.equal(classifyFrame({ id: 1 }), null);
  assert.equal(classifyFrame({}), null);
  assert.equal(classifyFrame(null), null);
  assert.equal(classifyFrame('frame'), null);
  // 错误码常量与线上已用值锁死（companion 代答/自造码，改值即破坏手机端兼容）
  assert.deepEqual([ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT], [-32000, -32001, -32022]);
});

test('lib/protocol：默认长档 + isFastMethod 白名单短档', () => {
  // 已知快速方法走短档
  assert.equal(isFastMethod('session/requestRuntimePreferences'), true);
  // 其余（含未知交互方法）一律长档：误入短档会被静默代答拒绝——
  // 失败模式必须偏向"多等"而非"误杀"
  assert.equal(isFastMethod('session/requestPermission'), false);
  assert.equal(isFastMethod('interaction/askUser'), false);
  assert.equal(isFastMethod('workspace/open'), false);
  assert.equal(isFastMethod('session/list'), false);
  assert.equal(isFastMethod(123), false);
  assert.equal(isFastMethod(undefined), false);
});
