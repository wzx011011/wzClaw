'use strict';

const http = require('node:http');
const { randomBytes, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const MAX_PAYLOAD = 1024 * 1024;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createRelay(options = {}) {
  const config = { authTimeoutMs: 10000, roomTtlMs: 60000, sweepIntervalMs: 1000,
    pingIntervalMs: 30000, maxSockets: 32, maxDevices: 16, maxRooms: 16, maxProbes: 3,
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
  // 配对语义：device 在房且至少一个 probe 在房。同一房间支持多台手机（上限 maxProbes），
  // relay 对 device 侧广播，companion 无感知。
  const matched = (room) => Boolean(room.device && room.probes.size > 0);
  // 槽位陈旧判定：以最近 pong 时间戳为准（而非 ping 前置置位的 alive 标志——
  // pong 在途的一个 RTT 窗口内健康端会被误判 stale，被挑战者清场误杀）。
  // 阈值 1.5 倍心跳周期：错过完整一个周期以上才视为失联，远大于移动端 RTT。
  const staleAfterMs = Math.ceil(config.pingIntervalMs * 1.5);
  const isStale = (state) => state.ws.readyState !== WebSocket.OPEN
    || Date.now() - state.lastPongAt > staleAfterMs;
  function notify(room) {
    const pair_status = matched(room) ? 'matched' : 'waiting';
    if (room.device) send(room.device.ws, { type: 'pair_status_ack', pair_status });
    for (const probe of room.probes.values()) send(probe.ws, { type: 'pair_status_ack', pair_status });
  }
  function detach(state) {
    clearTimeout(state.authTimer);
    const room = state.room;
    if (!room) return;
    if (state.role === 'probe') room.probes.delete(state.ws);
    else if (room[state.role] === state) room[state.role] = null;
    if (room.owner === state) room.owner = null;
    state.room = null;
    if (!room.device && room.probes.size === 0 && !room.owner && room.inactiveAt === null) room.inactiveAt = Date.now();
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
      lastPongAt: Date.now(), rateStart: Date.now(), rateCount: 0 };
    sockets.set(ws, state);
    state.authTimer = setTimeout(() => fail(state, 'AUTH_TIMEOUT'), config.authTimeoutMs).unref();
    ws.on('pong', () => { state.lastPongAt = Date.now(); });
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
      if (binary || raw.length > MAX_PAYLOAD) return fail(state);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return fail(state); }
      if (!isObject(msg)) return fail(state);
      // 限流只计认证/控制类消息：已配对成员的 data 帧是流式负载（app-server 每个
      // NDJSON 行一帧，实测每个输出字符可达 2 帧），计入会掐断正常回合。
      // 滥用防护由认证、帧大小上限与坏帧 fail 承担。
      const exempt = state.authenticated && msg.type === 'data' && state.room && matched(state.room);
      if (!exempt && ++state.rateCount > config.rateLimit) return fail(state, 'RATE_LIMITED');
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
      const room = { sid, secret: msg.pass_hash, owner: state, device: null, probes: new Map(), inactiveAt: null };
      rooms.set(sid, room); state.room = room;
      send(ws, { type: 'device_register_ack', device_sid: sid }); return;
    }
    if (msg.type === 'auth_init') {
      if (state.authenticated || state.nonce || !['device', 'probe'].includes(msg.role)) return fail(state, 'AUTH_FAILED');
      const room = findRoom(msg.device_sid);
      if (!room || (state.room !== null && state.room !== room)) return fail(state, 'AUTH_FAILED');
      if (msg.role === 'device') {
        // owner 保护：房间注册者未认证前，其他 socket 不得抢占 device 槽
        // （凭据同源——配对 URL 持有者也能过 HMAC，防手机端冒充 device）。
        // 半开 owner 例外：重连的 companion 正是要收回自己的房间。
        if (room.owner && room.owner !== state && !isStale(room.owner)) return fail(state, 'PEER_EXISTS');
        // 纯检查、零副作用：健康在位 device 直接拒绝；陈旧（半开）槽位不在此时
        // 清场，留到 auth_response 验证通过后接管——仅持 sid 的未认证端不能触发任何清场。
        if (room.device && room.device !== state && !isStale(room.device)) {
          return fail(state, 'PEER_EXISTS');
        }
      } else {
        // probe 容量预检（纯检查、零副作用）：健康在位数已达上限直接拒绝；
        // 陈旧槽位不计入占用，可在 auth_response 验证通过后被接管回收。
        const healthy = [...room.probes.values()].filter((s) => !isStale(s)).length;
        if (healthy >= config.maxProbes) return fail(state, 'CAPACITY');
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
      if (state.role === 'probe') {
        if (!findRoom(room.sid)) return fail(state, 'AUTH_FAILED');
        // 已验证持有 pass_hash 才允许清场：逐槽回收陈旧连接（半开接管），
        // 重连端可立即收回旧槽而不必等心跳周期。
        for (const incumbent of [...room.probes.values()]) {
          if (!isStale(incumbent)) continue;
          room.probes.delete(incumbent.ws);
          incumbent.ws.terminate();
          logger('peer-takeover', `role=probe stale=${incumbent.ws.readyState !== WebSocket.OPEN ? 'closed' : 'missed-ping'}`);
        }
        // 回收后仍满员（质询期间被其他 probe 占满的认证竞态）：按容量拒绝。
        if (room.probes.size >= config.maxProbes) return fail(state, 'CAPACITY');
        room.probes.set(state.ws, state);
      } else {
        // 已验证持有 pass_hash 才允许清场：owner 与 device 槽的陈旧在位者
        // （半开）在验证通过后一并收回。典型场景：companion 断网留下半开连接
        // （owner/device 槽还挂着旧 socket），重连时立即收回房间，手机配对不失效。
        for (const incumbent of [room.owner, room.device]) {
          if (!incumbent || incumbent === state) continue;
          if (!isStale(incumbent)) return fail(state, 'PEER_EXISTS'); // 健康在位者受保护
          if (room.owner === incumbent) room.owner = null; else room.device = null;
          incumbent.ws.terminate();
          logger('peer-takeover', `role=device stale=${incumbent.ws.readyState !== WebSocket.OPEN ? 'closed' : 'missed-ping'}`);
        }
        if (!findRoom(room.sid)) return fail(state, 'AUTH_FAILED');
        room.device = state;
      }
      room.inactiveAt = null; state.authenticated = true;
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
      if (state.role === 'device') {
        // device 下行广播给全体 probe（多手机同房间，各自收到完整流）。
        // v1 已知限制：广播不区分 probe，且手机端请求 id 各自从 1 起编号，
        // 双手机同时在线时可能出现 RPC id 冲突串台与反向请求扇出双重应答；
        // 后续由 companion/Dart 侧引入 per-probe id 命名空间解决，relay 层不改协议。
        for (const probe of state.room.probes.values()) send(probe.ws, msg);
      } else {
        // probe 上行只发给 device，probe 之间不互通。
        send(state.room.device.ws, msg);
      }
    } else fail(state);
  }
  const sweepTimer = setInterval(() => {
    for (const [sid, room] of rooms) {
      if (room.inactiveAt !== null && Date.now() - room.inactiveAt >= config.roomTtlMs) rooms.delete(sid);
    }
  }, config.sweepIntervalMs).unref();
  const pingTimer = setInterval(() => {
    for (const state of sockets.values()) {
      // 连续两个心跳周期无 pong 才判死（留足在途余量），比旧 alive 标志
      // （ping 前置置位、pong 复位）更不容易在 RTT 窗口内误杀健康端。
      if (Date.now() - state.lastPongAt > config.pingIntervalMs * 2) { state.ws.terminate(); continue; }
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
