'use strict';

const http = require('node:http');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { verifyProof, verifyRegisterProof } = require('./lib/proof');
const { classifyFrame } = require('./lib/protocol');
const { MAX_PAYLOAD } = require('./lib/constants');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createRelay(options = {}) {
  // 注册共享密钥：字符串型开关量，须在数值配置校验前单独提取。
  // 设置后 device_register_init 必须携带 register_proof（防公网自助注册占满
  // maxRooms/maxDevices 的注册 DoS）；未设置（undefined/null）时行为完全不变，
  // 本地开发/测试零摩擦。
  const registrationSecret = options.registrationSecret === undefined || options.registrationSecret === null
    ? null : options.registrationSecret;
  if (registrationSecret !== null && (typeof registrationSecret !== 'string' || !registrationSecret.length)) {
    throw new Error('Invalid registration secret');
  }
  const config = { authTimeoutMs: 10000, roomTtlMs: 60000, sweepIntervalMs: 1000,
    pingIntervalMs: 30000, maxSockets: 32, maxDevices: 16, maxRooms: 16, maxProbes: 3,
    rateLimit: 120, rateWindowMs: 10000,
    // RPC 路由必须有界且可回收。deadline 只约束 relay 的归属记录，不替代
    // companion/app-server 自己的请求超时；到期后迟到响应会以 unmatched 留观测。
    routeDeadlineMs: 2 * 60 * 1000, maxPendingRoutes: 256,
    // 孤儿反向请求补投宽限：新 probe 认证后仍在线这么久才补投（见
    // auth_response）。短连在线探测会在宽限内离席，从而不被当成权限应答者。
    probeReplayGraceMs: 2000,
    // 流式 data 独立配额：不能沿用控制帧 120/10s 把正常回合掐断，也不能无限豁免。
    // 16 个满帧/窗口：单次 session/resume 截断回复可接近 1MiB，必须容纳；
    // 持续占用仍受字节总量和帧数双重限制。
    dataRateLimit: 2000, dataRateBytes: 16 * MAX_PAYLOAD, ...options };
  delete config.registrationSecret;
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
      // 终止必须留观测（静默丢弃=缺陷）： oversized=单帧超限，slow=慢消费堆积。
      // 只记字节数，不落帧内容。
      const state = sockets.get(ws);
      logger('send-overflow-terminate',
        `role=${state?.role || 'unknown'} frame=${Buffer.byteLength(json)}B buffered=${ws.bufferedAmount}B`);
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
    // 清理路由归属，避免断线后 id 重用串到新连接。清理必须核对
    // 「已认证的槽位所有者 + 路由代次」（2026-09-19 评审修复）：
    // - 认证失败的冒名 device 从未拥有设备槽，不得清真实设备的在途路由；
    // - 被接管的旧 device 只清自己代次的路由，不伤新代次的在途请求。
    if (state.role === 'device' && state.authenticated && state.deviceGen != null) {
      for (const [id, route] of room.requestRoutes) {
        if (route.deviceGen === state.deviceGen) room.requestRoutes.delete(id);
      }
      for (const [id, route] of room.reverseRoutes) {
        if (route.deviceGen === state.deviceGen) room.reverseRoutes.delete(id);
      }
    } else if (state.role === 'probe') {
      for (const [id, route] of room.requestRoutes) {
        if (route.probe === state) room.requestRoutes.delete(id);
      }
      // 反向请求不随持有者离席而丢失（2026-09-19 评审修复）：优先移交给
      // 其他健康 probe；暂无则保留载荷待下一个 probe 入房后补投。
      reassignReverseRoutes(room, state);
    }
    state.room = null;
    if (!room.device && room.probes.size === 0 && !room.owner && room.inactiveAt === null) room.inactiveAt = Date.now();
    notify(room);
  }

  // 把 [from]（离席 probe）名下的反向请求移交给健康 probe；无健康 probe 时
  // 保留路由与载荷（deadline 到期由 sweep 统一清，companion 侧 120s 看护
  // 也会代答拒绝，不会永久挂起）。
  function reassignReverseRoutes(room, from) {
    for (const [id, route] of room.reverseRoutes) {
      if (route.probe !== from) continue;
      const next = [...room.probes.values()].find((p) => !isStale(p) && p !== from);
      if (next && route.payload) {
        route.probe = next;
        send(next.ws, { type: 'data', payload: route.payload });
        logger('reverse-reassigned', `id=${id} reason=holder-left`);
      } else if (!next) {
        route.probe = null; // 待命：下一个 probe 认证后补投（见 auth_response）
        logger('reverse-orphaned', `id=${id}`);
      } else {
        // 无载荷可重投的历史路由：只能删除
        room.reverseRoutes.delete(id);
      }
    }
  }
  // probe 失联恢复的补投半边：失联期间入房待命（probe=null）的反向路由
  // 由恢复者补投。宽限语义与认证补投一致：宽限期后仍在线才投——短连在线
  // 探测抢答会以默认 -32000 杀掉等待中的权限。pong 处理器在检测到
  // 「错过 ≥1.5 心跳周期后重新应答」时调用；测试经 _recoverProbe 直调
  //（真实恢复窗口受心跳竞态限制，黑盒复现不稳定）。
  function replayOrphansToRecoveredProbe(state) {
    if (!state.authenticated || state.role !== 'probe' || !state.room) return;
    if (state.room.reverseRoutes.size === 0) return;
    const probeWs = state.ws;
    const room = state.room;
    setTimeout(() => {
      if (probeWs.readyState !== WebSocket.OPEN) return;
      if (room.probes.get(probeWs) !== state) return; // 已离席/被接管
      for (const [id, route] of room.reverseRoutes) {
        if (route.probe === null && route.payload) {
          route.probe = state;
          send(probeWs, { type: 'data', payload: route.payload });
          logger('reverse-reassigned', `id=${id} reason=probe-recovered`);
        }
      }
    }, config.probeReplayGraceMs).unref();
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
      lastPongAt: Date.now(), rateStart: Date.now(), rateCount: 0,
      dataRateStart: Date.now(), dataRateCount: 0, dataRateBytes: 0,
      openAt: Date.now(), ip: req.socket.remoteAddress || '-' };
    sockets.set(ws, state);
    // 连接级诊断（排查手机端断线重连）：只记 IP 与时刻，不含任何标识值
    logger('ws-open', `ip=${state.ip}`);
    state.authTimer = setTimeout(() => fail(state, 'AUTH_TIMEOUT'), config.authTimeoutMs).unref();
    ws.on('pong', () => {
      // 失联恢复检测（审查 P2-6 relay 半）：此前错过 1.5 个心跳周期的
      // probe 重新应答——失联期间入房待命（probe=null）的反向路由由它
      // 补投（见 replayOrphansToRecoveredProbe 的宽限语义）。
      const staleBefore = Date.now() - state.lastPongAt > staleAfterMs;
      state.lastPongAt = Date.now();
      if (staleBefore) replayOrphansToRecoveredProbe(state);
    });
    ws.on('error', () => { ws.terminate(); });
    ws.on('close', (code) => {
      clearTimeout(state.closeTimer); detach(state); sockets.delete(ws);
      // 只记角色与关闭码（1000 正常关 / 1006 网络中断 / 1008 被拒），不含任何标识值
      logger('ws-close', `role=${state.role || 'unauth'} code=${code} ip=${state.ip} life=${Math.round((Date.now() - state.openAt) / 1000)}s`);
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
      const dataFrame = state.authenticated && msg.type === 'data' && state.room && matched(state.room);
      if (dataFrame) {
        if (Date.now() - state.dataRateStart >= config.rateWindowMs) {
          state.dataRateStart = Date.now(); state.dataRateCount = 0; state.dataRateBytes = 0;
        }
        state.dataRateCount += 1; state.dataRateBytes += raw.length;
        if (state.dataRateCount > config.dataRateLimit || state.dataRateBytes > config.dataRateBytes) {
          return fail(state, 'DATA_RATE_LIMITED');
        }
      } else if (++state.rateCount > config.rateLimit) return fail(state, 'RATE_LIMITED');
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
      // 注册 proof 先于容量检查：不持密钥的注册请求连 CAPACITY 探测都摸不到，
      // 公网攻击者无法借此测绘房间水位。校验含形状检查（base64url 定长 43，
      // hex 不认）与 timingSafeEqual 常量时间比较。
      if (registrationSecret !== null
        && !verifyRegisterProof({ proof: msg.register_proof, secret: registrationSecret, mid: msg.device_mid })) {
        return fail(state, 'AUTH_FAILED');
      }
      // 确定性 sid：由 (pass_hash, mid) HMAC 派生。companion 把注册口令落盘后，
      // 进程重启/自启动/换机重连都会得到同一房间号——手机端配对一次长期有效，
      // relay 容器重启后重新注册也恢复同一 sid（房间在内存，凭据关系可再生）。
      // sid 本就印在配对 URL 里，可由 URL 信息推出，不降低安全性。
      const sid = createHmac('sha256', msg.pass_hash).update(`zcode-relay-sid:${msg.device_mid}`)
        .digest('base64url').slice(0, 24);
      const existing = rooms.get(sid);
      if (existing) {
        // 幂等重注册（同 mid+同 hash）：接管 owner 复用原房间与在房 probe，
        // 解决"companion 掉线重注册 → 手机配对全失效"的换码风暴。
        if (existing.owner && existing.owner !== state) existing.owner.ws.terminate();
        existing.owner = state; existing.inactiveAt = null;
        state.room = existing;
        send(ws, { type: 'device_register_ack', device_sid: sid }); return;
      }
      if (rooms.size >= config.maxRooms
        || [...rooms.values()].filter((room) => room.device || room.owner).length >= config.maxDevices) return fail(state, 'CAPACITY');
      const room = { sid, secret: msg.pass_hash, owner: state, device: null, probes: new Map(), inactiveAt: null,
        // relay 内部 ID 命名空间：probe 的同号请求改写后交给 device，响应再还原。
        // deviceGen：device 槽代次（路由按代次归属清理，见 detach）。
        nextRequestId: 1, requestRoutes: new Map(), reverseRoutes: new Map(), deviceGen: 0 };
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
      // pass_hash 本身作为字符串密钥，不能先进行 base64 解码。形状检查（base64url
      // 定长 43，hex 不认）与 timingSafeEqual 常量时间比较收口在共享 lib/proof.js
      // （companion 侧推导/Dart 侧等价实现语义一致）。
      if (!verifyProof({ proof: msg.proof, passHash: room.secret, nonce, role: state.role, sid: room.sid })) {
        return fail(state, 'AUTH_FAILED');
      }
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
        // 补投孤儿反向请求（原持有 probe 离席且无健康接手者的待命路由）。
        // 不在认证时立即补投（2026-09-19 评审 P2）：设备列表的在线探测是
        // 短连 probe，无交互能力（没有 onRequest 钩子，收到即同步默认
        // -32000 拒绝）——立即补投会让用户「查一下在不在线」就杀掉等待
        // 中的权限。宽限期后 probe 仍在线才补投：探测早已离席，长连 App
        // 稳定在线；「多等」优于「立即拒绝」。补投后仍保持单点路由（防双允许）。
        if (room.reverseRoutes.size > 0) {
          const probeWs = state.ws;
          setTimeout(() => {
            if (probeWs.readyState !== WebSocket.OPEN) return;
            if (room.probes.get(probeWs) !== state) return; // 已离席/被接管
            for (const [id, route] of room.reverseRoutes) {
              if (route.probe === null && route.payload) {
                route.probe = state;
                send(probeWs, { type: 'data', payload: route.payload });
                logger('reverse-reassigned', `id=${id} reason=new-probe`);
              }
            }
          }, config.probeReplayGraceMs).unref();
        }
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
        // 设备槽代次：本连接转发的路由都挂这个代次，detach 按代次精准清理
        state.deviceGen = ++room.deviceGen;
      }
      room.inactiveAt = null; state.authenticated = true;
      clearTimeout(state.authTimer);
      send(ws, { type: 'auth_ack', pair_status: matched(room) ? 'matched' : 'waiting' });
      logger('auth-ok', `role=${state.role} ip=${state.ip}`);
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
      if (!matched(state.room)) {
        // 重连窗口（device 槽短暂为空）的下行帧静默丢弃是既有语义，
        // 但零观测会让「手机发了却没生效」变成无头案——留计数日志
        logger('data-dropped-unmatched', `role=${state.role}`);
        return;
      }
      if (state.role === 'device') {
        const kind = classifyFrame(msg.payload);
        if (kind === 'response' && typeof msg.payload.id === 'number') {
          const route = state.room.requestRoutes.get(msg.payload.id);
          if (!route) { logger('route-unmatched-response', String(msg.payload.id)); return; }
          state.room.requestRoutes.delete(msg.payload.id);
          send(route.probe.ws, { type: 'data', payload: { ...msg.payload, id: route.sourceId } });
        } else if (kind === 'reverse-request') {
          // 反向请求只能由一个手机回答。稳定选择第一个健康 probe，避免双允许。
          // 路由保留原始载荷：持有 probe 离席时可移交给其他 probe（见 detach）。
          const probe = [...state.room.probes.values()].find((p) => !isStale(p));
          if (!probe) {
            // 全部 probe 失联：保留载荷待命（下一个 probe 入房补投），
            // 不再直接丢弃——丢弃会让权限无人能答而房间看似正常
            if (!state.room.reverseRoutes.has(msg.payload.id)
              && state.room.reverseRoutes.size >= config.maxPendingRoutes) {
              logger('route-capacity-reverse', `count=${state.room.reverseRoutes.size}`);
              return;
            }
            state.room.reverseRoutes.set(msg.payload.id, {
              probe: null, deadlineAt: Date.now() + config.routeDeadlineMs,
              deviceGen: state.deviceGen ?? null, payload: msg.payload,
            });
            logger('route-no-probe', String(msg.payload.id));
            return;
          }
          if (!state.room.reverseRoutes.has(msg.payload.id)
            && state.room.reverseRoutes.size >= config.maxPendingRoutes) {
            logger('route-capacity-reverse', `count=${state.room.reverseRoutes.size}`);
            return;
          }
          state.room.reverseRoutes.set(msg.payload.id, {
            probe, deadlineAt: Date.now() + config.routeDeadlineMs,
            deviceGen: state.deviceGen ?? null, payload: msg.payload,
          });
          send(probe.ws, msg);
        } else {
          // 无 id 的通知/流式事件可安全广播，保留多手机旁观能力。
          for (const probe of state.room.probes.values()) send(probe.ws, msg);
        }
      } else {
        const kind = classifyFrame(msg.payload);
        if (kind === 'request' && typeof msg.payload.id === 'number') {
          if (state.room.requestRoutes.size >= config.maxPendingRoutes) {
            logger('route-capacity-request', `count=${state.room.requestRoutes.size}`);
            send(state.ws, { type: 'data', payload: { id: msg.payload.id,
              error: { code: -32000, message: 'Relay request route capacity reached' } } });
            return;
          }
          const wireId = state.room.nextRequestId++;
          state.room.requestRoutes.set(wireId, { probe: state, sourceId: msg.payload.id,
            deadlineAt: Date.now() + config.routeDeadlineMs,
            deviceGen: state.room.deviceGen });
          send(state.room.device.ws, { type: 'data', payload: { ...msg.payload, id: wireId } });
        } else if (kind === 'reverse-request') {
          // 字符串 method+id 只允许来自 device（app-server 的反向请求）。probe
          // 发出同形状普通请求时必须显式拒绝，绝不能误当反向请求广播/单播给其它手机。
          logger('route-rejected-request', 'string-id');
          send(state.ws, { type: 'data', payload: { id: msg.payload.id,
            error: { code: -32600, message: 'Probe request id must be a number' } } });
        } else if (kind === 'response') {
          const route = state.room.reverseRoutes.get(msg.payload.id);
          if (route && route.probe === state) {
            state.room.reverseRoutes.delete(msg.payload.id);
            send(state.room.device.ws, msg);
          } else {
            logger('route-rejected-response', String(msg.payload.id));
          }
        } else {
          // probe 通知保持上行；普通响应必须有明确反向请求归属。
          send(state.room.device.ws, msg);
        }
      }
    } else fail(state);
  }
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, room] of rooms) {
      if (room.inactiveAt !== null && now - room.inactiveAt >= config.roomTtlMs) {
        rooms.delete(sid);
        continue;
      }
      for (const [id, route] of room.requestRoutes) {
        if (route.deadlineAt > now) continue;
        room.requestRoutes.delete(id);
        logger('route-expired-request', `id=${id}`);
      }
      for (const [id, route] of room.reverseRoutes) {
        if (route.deadlineAt > now) continue;
        room.reverseRoutes.delete(id);
        logger('route-expired-reverse', `id=${id}`);
      }
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
    // 测试钩子：直调「probe 失联恢复」补投路径（pong 处理器的恢复半边）
    _recoverProbe(state) { replayOrphansToRecoveredProbe(state); },
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
  const relay = createRelay({ logger: (event, detail) => console.log(`[relay] ${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ''}`),
    // 注册共享密钥经环境变量注入（Docker -e REGISTRATION_SECRET=...）；
    // 未设置时开放注册，行为与旧版一致。
    registrationSecret: process.env.REGISTRATION_SECRET });
  relay.listen({ port, host }).then((address) => {
    console.log(`Relay listening at ws://${address.address}:${address.port}/ws`);
  }).catch(async () => { console.error('Relay startup failed'); await relay.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close(); });
}
