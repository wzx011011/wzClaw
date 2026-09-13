'use strict';

const http = require('node:http');
const { randomBytes, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const MAX_PAYLOAD = 1024 * 1024;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createRelay(options = {}) {
  const config = { authTimeoutMs: 10000, roomTtlMs: 60000, sweepIntervalMs: 1000,
    pingIntervalMs: 30000, maxSockets: 32, maxDevices: 16, maxRooms: 16,
    rateLimit: 120, rateWindowMs: 10000, ...options };
  const logger = typeof config.logger === 'function' ? config.logger : () => {};
  delete config.logger;
  for (const value of Object.values(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid relay option');
  }
  const rooms = new Map();
  const sockets = new Map();
  let closing = false;
  let closePromise;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin || req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', sockets: sockets.size, rooms: rooms.size,
      devices: [...rooms.values()].filter((room) => room.device).length }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_PAYLOAD || ws.bufferedAmount > MAX_PAYLOAD * 2) {
      ws.terminate(); return;
    }
    ws.send(json);
  }
  const matched = (room) => Boolean(room.device && room.probe);
  function notify(room) {
    for (const peer of [room.device, room.probe]) {
      if (peer) send(peer.ws, { type: 'pair_status_ack', pair_status: matched(room) ? 'matched' : 'waiting' });
    }
  }
  function detach(state) {
    clearTimeout(state.authTimer);
    const room = state.room;
    if (!room) return;
    if (room[state.role] === state) room[state.role] = null;
    if (room.owner === state) room.owner = null;
    state.room = null;
    if (!room.device && !room.probe && !room.owner && room.inactiveAt === null) room.inactiveAt = Date.now();
    notify(room);
  }
  function fail(state, code = 'BAD_MESSAGE') {
    if (state.failed) return;
    state.failed = true; state.nonce = null;
    detach(state);
    send(state.ws, { type: 'error', code, message: 'Request rejected' });
    state.ws.close(1008, 'Request rejected');
    state.closeTimer = setTimeout(() => state.ws.terminate(), 100).unref();
  }
  function findRoom(sid) {
    const room = typeof sid === 'string' && rooms.get(sid);
    if (room && room.inactiveAt !== null && Date.now() - room.inactiveAt >= config.roomTtlMs) {
      rooms.delete(sid); return null;
    }
    return room || null;
  }
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (closing || url.pathname !== '/ws' || req.headers.origin || sockets.size >= config.maxSockets) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
  });
  wss.on('connection', (ws, req, url) => {
    const state = { ws, mid: url.searchParams.get('mid'), headerMid: req.headers['x-device-id'],
      role: null, room: null, nonce: null, authenticated: false, failed: false,
      alive: true, rateStart: Date.now(), rateCount: 0 };
    sockets.set(ws, state);
    state.authTimer = setTimeout(() => fail(state, 'AUTH_TIMEOUT'), config.authTimeoutMs).unref();
    ws.on('pong', () => { state.alive = true; });
    ws.on('error', () => { ws.terminate(); });
    ws.on('close', (code) => {
      clearTimeout(state.closeTimer); detach(state); sockets.delete(ws);
      // 只记角色与关闭码（1000 正常关 / 1006 网络中断 / 1008 被拒），不含任何标识值
      logger('ws-close', `role=${state.role || 'unauth'} code=${code}`);
    });
    ws.on('message', (raw, binary) => {
      if (state.failed) return;
      if (Date.now() - state.rateStart >= config.rateWindowMs) {
        state.rateStart = Date.now(); state.rateCount = 0;
      }
      if (++state.rateCount > config.rateLimit) return fail(state, 'RATE_LIMITED');
      if (binary || raw.length > MAX_PAYLOAD) return fail(state);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return fail(state); }
      if (!isObject(msg)) return fail(state);
      handleMessage(state, msg);
    });
  });
  function handleMessage(state, msg) {
    const ws = state.ws;
    if (msg.type === 'device_register_init') {
      if (state.room || state.nonce || state.authenticated) return fail(state, 'AUTH_FAILED');
      if (typeof msg.device_mid !== 'string' || !msg.device_mid.length || msg.device_mid.length > 256
        || msg.device_mid !== state.mid || msg.device_mid !== state.headerMid
        || typeof msg.pass_hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(msg.pass_hash)
        || Buffer.from(msg.pass_hash, 'base64').toString('base64') !== msg.pass_hash) return fail(state, 'AUTH_FAILED');
      if (rooms.size >= config.maxRooms
        || [...rooms.values()].filter((room) => room.device || room.owner).length >= config.maxDevices) return fail(state, 'CAPACITY');
      const sid = randomUUID();
      const room = { sid, secret: msg.pass_hash, owner: state, device: null, probe: null, inactiveAt: null };
      rooms.set(sid, room); state.room = room;
      send(ws, { type: 'device_register_ack', device_sid: sid }); return;
    }
    if (msg.type === 'auth_init') {
      if (state.authenticated || state.nonce || !['device', 'probe'].includes(msg.role)) return fail(state, 'AUTH_FAILED');
      const room = findRoom(msg.device_sid);
      if (!room || (msg.role === 'device' && ((room.owner !== null && room.owner !== state)
        || (state.room !== null && state.room !== room)))
        || (msg.role === 'probe' && state.room)) return fail(state, 'AUTH_FAILED');
      if (room[msg.role]) {
        // 旧端 socket 已断/失联（半开）时允许接管：新端仍要过 HMAC 质询，安全等价。
        // 典型场景：手机网络闪断留下半开连接，旧端要等一个心跳周期才被清理，
        // 期间手机重连会一直撞 PEER_EXISTS 表现为"频繁重连"。
        const incumbent = room[msg.role];
        if (incumbent.ws.readyState === WebSocket.OPEN && incumbent.alive) return fail(state, 'PEER_EXISTS');
        room[msg.role] = null;
        incumbent.ws.terminate();
        logger('peer-takeover', `role=${msg.role} stale=${incumbent.ws.readyState !== WebSocket.OPEN ? 'closed' : 'missed-ping'}`);
      }
      state.room = room; state.role = msg.role;
      state.nonce = randomBytes(32).toString('base64url');
      send(ws, { type: 'auth_challenge', nonce: state.nonce }); return;
    }
    if (msg.type === 'auth_response') {
      const nonce = state.nonce; state.nonce = null;
      const room = state.room;
      if (!nonce || !room || msg.device_sid !== room.sid || state.authenticated) return fail(state, 'AUTH_FAILED');
      // pass_hash 本身作为字符串密钥，不能先进行 base64 解码。
      const expected = createHmac('sha256', room.secret).update(`${nonce}|${state.role}|${room.sid}`).digest();
      const proof = typeof msg.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(msg.proof)
        ? Buffer.from(msg.proof, 'base64url') : Buffer.alloc(0);
      if (proof.length !== expected.length || proof.toString('base64url') !== msg.proof
        || !timingSafeEqual(proof, expected)) return fail(state, 'AUTH_FAILED');
      if (room[state.role]) return fail(state, 'PEER_EXISTS');
      if (!findRoom(room.sid)) return fail(state, 'AUTH_FAILED');
      room[state.role] = state; room.inactiveAt = null; state.authenticated = true;
      clearTimeout(state.authTimer);
      send(ws, { type: 'auth_ack', pair_status: matched(room) ? 'matched' : 'waiting' });
      notify(room); return;
    }
    if (!state.authenticated) return fail(state, 'AUTH_REQUIRED');
    if (msg.type === 'pair_status_query') {
      if (msg.device_sid !== state.room.sid) return fail(state, 'AUTH_FAILED');
      send(ws, { type: 'pair_status_ack', pair_status: matched(state.room) ? 'matched' : 'waiting' });
    } else if (msg.type === 'data') {
      if (!isObject(msg.payload)) return fail(state);
      // 未配对时外发数据静默丢弃：认证设备（companion）常在手机离开后仍有
      // app-server 尾流数据，踢掉会迫使其重注册轮换 sid/hash，手机端配对全部失效。
      if (!matched(state.room)) return;
      send(state.room[state.role === 'device' ? 'probe' : 'device'].ws, msg);
    } else fail(state);
  }
  const sweepTimer = setInterval(() => {
    for (const [sid, room] of rooms) {
      if (room.inactiveAt !== null && Date.now() - room.inactiveAt >= config.roomTtlMs) rooms.delete(sid);
    }
  }, config.sweepIntervalMs).unref();
  const pingTimer = setInterval(() => {
    for (const state of sockets.values()) {
      if (!state.alive) { state.ws.terminate(); continue; }
      state.alive = false;
      if (state.ws.readyState === WebSocket.OPEN) state.ws.ping();
    }
  }, config.pingIntervalMs).unref();
  return {
    // 测试钩子：只读访问内部 socket 状态表（模拟错过心跳的半开连接）
    get _sockets() { return sockets; },
    listen({ port = 18884, host = '127.0.0.1' } = {}) {
      if (closing || server.listening || !Number.isInteger(port) || port < 0 || port > 65535
        || typeof host !== 'string' || !host.length) return Promise.reject(new Error('Invalid listen state, port or host'));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearInterval(sweepTimer); clearInterval(pingTimer);
      for (const state of sockets.values()) {
        clearTimeout(state.authTimer); clearTimeout(state.closeTimer); state.ws.terminate();
      }
      closePromise = Promise.all([
        new Promise((resolve) => wss.close(resolve)),
        new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(resolve); server.closeAllConnections();
        }),
      ]).then(() => { rooms.clear(); sockets.clear(); });
      return closePromise;
    },
  };
}

module.exports = { createRelay, MAX_PAYLOAD };
if (require.main === module) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const hostIdx = args.indexOf('--host');
  const port = portIdx !== -1 && /^\d+$/.test(args[portIdx + 1] || '') ? Number(args[portIdx + 1]) : 18884;
  // 容器/nginx 部署用 --host 0.0.0.0；默认仅回环。
  const host = hostIdx !== -1 && typeof args[hostIdx + 1] === 'string' && args[hostIdx + 1].length ? args[hostIdx + 1] : '127.0.0.1';
  const relay = createRelay({ logger: (event, detail) => console.log(`[relay] ${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ''}`) });
  relay.listen({ port, host }).then((address) => {
    console.log(`Relay listening at ws://${address.address}:${address.port}/ws`);
  }).catch(async () => { console.error('Relay startup failed'); await relay.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close(); });
}
