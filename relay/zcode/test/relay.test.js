'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID, randomBytes, createHash, createHmac } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { createRelay, MAX_PAYLOAD } = require('../server');
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

test('authenticated data requires a matched peer', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  d.send({ type: 'data', payload: {} });
  assert.equal((await d.next('error')).code, 'NOT_PAIRED');
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

test('second same-role peer rejected while existing pair survives, including auth race', async (t) => {
  const f = await fixture(t);
  const d = await device(t, f.url);
  const late = await client(t, f.url);
  const nonce = await challenge(late, d.sid);
  const p = await client(t, f.url); await auth(p, d.sid, d.hash);
  late.send({ type: 'auth_response', device_sid: d.sid, proof: proofFor(d.hash, nonce, 'probe', d.sid) });
  assert.equal((await late.next('error')).code, 'PEER_EXISTS');
  const second = await client(t, f.url);
  second.send({ type: 'auth_init', role: 'probe', device_sid: d.sid });
  assert.equal((await second.next('error')).code, 'PEER_EXISTS');
  const fakeDevice = await client(t, f.url);
  fakeDevice.send({ type: 'auth_init', role: 'device', device_sid: d.sid });
  assert.equal((await fakeDevice.next('error')).code, 'AUTH_FAILED');
  p.send({ type: 'data', payload: { alive: true } });
  assert.deepEqual((await d.next('data')).payload, { alive: true });
  assert.equal(p.ws.readyState, WebSocket.OPEN);
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
