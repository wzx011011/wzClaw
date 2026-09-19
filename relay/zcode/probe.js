'use strict';

const { randomUUID, createHmac } = require('node:crypto');
const { WebSocket } = require('ws');
const { MAX_PAYLOAD } = require('./lib/constants');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeError = (code) => Object.assign(new Error(code), { code });

function parseInputs(relayUrl, qrUrl, timeoutMs) {
  try {
    const relay = new URL(relayUrl);
    const qr = new URL(qrUrl);
    if (!['ws:', 'wss:'].includes(relay.protocol) || relay.hostname !== '127.0.0.1'
      || relay.pathname !== '/ws' || relay.username || relay.password || relay.search || relay.hash
      || !['http:', 'https:'].includes(qr.protocol) || qr.username || qr.password
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new Error();
    const sid = qr.searchParams.get('sid');
    const hash = qr.searchParams.get('hash');
    if (qr.searchParams.getAll('sid').length !== 1 || qr.searchParams.getAll('hash').length !== 1
      || !sid || sid.length > 256 || !hash || !/^[A-Za-z0-9+/]{43}=$/.test(hash)
      || Buffer.from(hash, 'base64').toString('base64') !== hash) throw new Error();
    return { relay: relay.href, sid, hash };
  } catch { throw safeError('INVALID_INPUT'); }
}

async function runProbe({ relayUrl, qrUrl, timeoutMs = 15000 } = {}) {
  const { relay, sid, hash } = parseInputs(relayUrl, qrUrl, timeoutMs);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false, handshakeTimeout: timeoutMs });
    let done = false;
    let authState = 'initial';
    let started = false;
    let heartbeat;
    const pending = new Map();
    const summary = { status: 'ok', bootstrap: null, workspaceList: null };
    const timer = setTimeout(() => finish(safeError('TIMEOUT')), timeoutMs);
    // 只输出白名单字段名称和计数，丢弃返回值及任意动态字段名。
    function summarize(result, bootstrap) {
      if (!isObject(result) || !Array.isArray(result.workspaces)
        || (bootstrap && (typeof result.windowControlSessionId !== 'string' || !result.windowControlSessionId || !Array.isArray(result.tasks)))
        || (result.tasks !== undefined && !Array.isArray(result.tasks))) throw safeError('INVALID_RESPONSE');
      return { status: 'ok', workspaceCount: result.workspaces.length,
        ...(Array.isArray(result.tasks) ? { taskCount: result.tasks.length } : {}),
        fields: ['windowControlSessionId', 'workspaces', 'tasks'].filter((key) => Object.hasOwn(result, key)) };
    }
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer); clearInterval(heartbeat); pending.clear();
      const settle = () => { if (error) reject(error); else resolve(summary); };
      if (ws.readyState === WebSocket.CLOSED) return settle();
      // 等待 close 后才结算，防止调用方退出时遗留连接。
      const forced = setTimeout(() => ws.terminate(), 100);
      ws.once('close', () => { clearTimeout(forced); settle(); });
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      else ws.terminate();
    }
    function send(value) {
      if (ws.readyState !== WebSocket.OPEN) return finish(safeError('DISCONNECTED'));
      ws.send(JSON.stringify(value));
    }
    function startRequests() {
      if (started) return;
      started = true;
      for (const [type, key] of [['bootstrap-request', 'bootstrap'], ['workspace-list-request', 'workspaceList']]) {
        const requestId = randomUUID();
        pending.set(requestId, { key, responseType: type.replace('-request', '-response') });
        send({ type: 'data', payload: { zcode_type: type, requestId }, client_ts: Date.now() });
      }
    }
    ws.on('open', () => send({ type: 'auth_init', role: 'probe', device_sid: sid }));
    ws.on('error', () => finish(safeError('CONNECTION_FAILED')));
    ws.on('close', () => { if (!done) finish(safeError('DISCONNECTED')); });
    ws.on('message', (raw, binary) => {
      if (done) return;
      try {
        if (binary) throw safeError('INVALID_RESPONSE');
        const msg = JSON.parse(raw.toString());
        if (!isObject(msg)) throw safeError('INVALID_RESPONSE');
        if (msg.type === 'error') throw safeError('RELAY_ERROR');
        if (msg.type === 'auth_challenge') {
          if (authState !== 'initial' || typeof msg.nonce !== 'string' || !msg.nonce.length || msg.nonce.length > 256) throw safeError('INVALID_RESPONSE');
          authState = 'proof';
          const proof = createHmac('sha256', hash).update(`${msg.nonce}|probe|${sid}`).digest('base64url');
          send({ type: 'auth_response', device_sid: sid, proof });
        } else if (msg.type === 'auth_ack') {
          if (authState !== 'proof' || !['matched', 'waiting'].includes(msg.pair_status)) throw safeError('INVALID_RESPONSE');
          authState = 'authenticated';
          heartbeat = setInterval(() => send({ type: 'pair_status_query', device_sid: sid }), 5000);
          if (msg.pair_status === 'matched') startRequests();
        } else if (msg.type === 'pair_status_ack') {
          if (authState !== 'authenticated' || !['matched', 'waiting'].includes(msg.pair_status)) throw safeError('INVALID_RESPONSE');
          if (msg.pair_status === 'matched') startRequests();
          else if (started) throw safeError('DISCONNECTED');
        } else if (msg.type === 'data') {
          if (authState !== 'authenticated' || !started || !isObject(msg.payload)) throw safeError('INVALID_RESPONSE');
          const payload = msg.payload;
          const request = pending.get(payload.requestId);
          if (!request) return;
          if (payload.error != null || payload.success === false || payload.zcode_type === 'error') throw safeError('APP_ERROR');
          if (payload.success !== true || payload.zcode_type !== request.responseType) throw safeError('INVALID_RESPONSE');
          summary[request.key] = summarize(payload.result, request.key === 'bootstrap');
          pending.delete(payload.requestId);
          if (!pending.size) finish();
        } else throw safeError('INVALID_RESPONSE');
      } catch (error) {
        const allowed = ['INVALID_RESPONSE', 'RELAY_ERROR', 'DISCONNECTED', 'APP_ERROR'];
        finish(safeError(allowed.includes(error.code) ? error.code : 'INVALID_RESPONSE'));
      }
    });
  });
}

module.exports = { runProbe };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--relay') throw safeError('INVALID_INPUT');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 16384) throw safeError('INVALID_INPUT');
    }
    console.log(JSON.stringify(await runProbe({ relayUrl: args[1], qrUrl: input.trim() }), null, 2));
  })().catch((error) => {
    const codes = ['INVALID_INPUT', 'TIMEOUT', 'CONNECTION_FAILED', 'DISCONNECTED', 'INVALID_RESPONSE', 'RELAY_ERROR', 'APP_ERROR'];
    console.error(JSON.stringify({ status: 'error', code: codes.includes(error.code) ? error.code : 'PROBE_FAILED' }));
    process.exitCode = 1;
  });
}
