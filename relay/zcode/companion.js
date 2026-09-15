'use strict';

// 桌面 companion：以 device 角色注册到 zcode relay，配对成功后把手机端发来的
// data 载荷（ZCode Protocol v1 帧）与本机 `zcode app-server` 的 stdio NDJSON
// 双向桥接。详见 APP-SERVER.md。
//
// 安全约定：
// - pass_hash/sid 只出现在配对 URL（companion 的核心功能），日志与事件不携带。
// - 模型认证 token 仅从 ~/.zcode/v2/config.json 读出后注入子进程环境变量，
//   不落盘、不打印、不经过 relay。

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { MAX_PAYLOAD } = require('./server');
const { deriveProof, deriveRegisterProof } = require('./lib/proof');
const { ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT, isFastMethod } = require('./lib/protocol');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeError = (code) => Object.assign(new Error(code), { code });

const RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';
const RUNTIME_PREFERENCES_RESULT = { nativeSearchEnhancementsEnabled: false };

// 默认解析本机 ZCode 安装（可被 options.zcodeCommand 覆盖，测试注入假进程用）。
function defaultZcodeCommand() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) {
    return { command: process.execPath, args: [process.env.ZCODE_BIN] };
  }
  if (fs.existsSync(local)) return { command: process.execPath, args: [local] };
  return { command: 'zcode', args: [] };
}

// 读取桌面端已登录的 coding-plan token（只返回，不打印）。
function readModelAuth(v2ConfigPath) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(v2ConfigPath, 'utf8')); } catch { throw safeError('AUTH_STORE_UNREADABLE'); }
  const entry = parsed?.provider?.['builtin:bigmodel-coding-plan'];
  const token = entry?.options?.apiKey;
  if (typeof token !== 'string' || token.length === 0) throw safeError('NOT_LOGGED_IN');
  return token;
}

function derivePairingUrl(relayUrl, sid, hash) {
  const relay = new URL(relayUrl);
  const origin = `${relay.protocol === 'wss:' ? 'https:' : 'http:'}//${relay.host}`;
  const base = `${origin}${relay.pathname.replace(/\/ws\/?$/, '')}/pair`;
  // name=主机名：手机端多桌面列表的默认显示名（App 端可选参数，旧版忽略）
  const host = os.hostname().slice(0, 64);
  return `${base}?sid=${encodeURIComponent(sid)}&hash=${encodeURIComponent(hash)}`
    + `&name=${encodeURIComponent(host)}`;
}

// app-server stdio 桥：按行分帧，崩溃自动重启（上限 + 退避）。
class AppServerBridge {
  constructor({ command, args, cwd, env, logger, maxRestarts = 5, restartDelayMs = 1000 }) {
    this.command = command; this.args = args; this.cwd = cwd; this.env = env;
    this.logger = logger || (() => {});
    this.maxRestarts = maxRestarts; this.restartDelayMs = restartDelayMs;
    this.child = null; this.buffer = ''; this.restarts = 0;
    this.onFrame = null; this.onDead = null; this.onRespawn = null; this.stopped = false;
  }
  start() {
    this.stopped = false;
    this.spawnChild();
  }
  spawnChild() {
    const child = spawn(this.command, [...this.args, 'app-server', '--cwd', this.cwd], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env,
    });
    this.child = child; this.buffer = '';
    // setEncoding 让 Node 在流层面按 UTF-8 边界解码：多字节中文跨 chunk 时
    // 不会各译各的产生 U+FFFD（坏行被静默丢弃或乱码透传到手机）。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.feed(chunk));
    child.stderr.on('data', (chunk) => this.logger('appserver-stderr', chunk.slice(0, 2000)));
    // spawn 失败（ENOENT/EINVAL）只发 'error' 不发 'exit'：必须在此置空 this.child，
    // 否则 scheduleRestart 的 child!==null 守卫直接返回，桥变僵尸（永不重启也不报死）。
    child.on('error', (error) => {
      this.logger('appserver-spawn-error', error.code || String(error));
      if (this.child === child) this.child = null;
      this.scheduleRestart('spawn-error');
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.scheduleRestart(code, signal);
    });
    // 新进程的 server-N 反向请求 id 从头计数：通知宿主作废旧 pending 看护，
    // 防止旧定时器误杀复用了同 id 的新请求。
    if (this.onRespawn) this.onRespawn();
  }
  scheduleRestart(code, signal) {
    if (this.stopped) return;
    if (this.child !== null) return;
    if (this.restarts >= this.maxRestarts) {
      this.logger('appserver-dead', `exit=${code} signal=${signal}`);
      if (this.onDead) this.onDead();
      return;
    }
    this.restarts += 1;
    setTimeout(() => { if (!this.stopped && this.child === null) this.spawnChild(); }, this.restartDelayMs).unref();
  }
  feed(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame; try { frame = JSON.parse(line); } catch { this.logger('appserver-bad-line', ''); continue; }
      if (isObject(frame) && this.onFrame) this.onFrame(frame);
    }
  }
  write(frame) {
    if (this.stopped) return false;
    if (!isObject(frame)) return false;
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_PAYLOAD) return false;
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(line);
    return true;
  }
  resetRestartBudget() { this.restarts = 0; }
  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (!this.child) return Promise.resolve();
    const child = this.child; this.child = null;
    child.removeAllListeners('exit');
    return new Promise((resolve) => {
      const finish = () => resolve();
      child.once('exit', finish);
      setTimeout(() => { child.kill(); }, 0);
      setTimeout(() => { child.kill('SIGKILL'); finish(); }, 2000).unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream.destroy(); } catch { /* 忽略 */ }
      }
    });
  }
}

function createCompanion(options = {}) {
  const {
    relayUrl, cwd = process.cwd(), zcodeCommand, v2ConfigPath,
    midFile = path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'mid'),
    logger = () => {}, onPairing = () => {}, onStateChange = () => {},
    reconnectDelayMs = 5000,
    // 注册共享密钥：relay 设置 REGISTRATION_SECRET 后注册必须携带 proof
    // （防公网注册 DoS）。仅当 secret 存在时才附 register_proof；
    // 未提供时注册帧与旧版完全一致（对开放注册的 relay 零影响）。
    registrationSecret,
    // 反向请求超时看护分两档（默认长档策略）：已知快速方法（isFastMethod
    // 白名单）短档；其余一律长档——未知交互方法误入短档会被静默代答拒绝，
    // 长档最坏只是多等。两档均可注入短值供测试。
    requestTimeoutMs = 15000, permissionRequestTimeoutMs = 120000,
  } = options;
  if (typeof relayUrl !== 'string' || !/^wss?:\/\/.+\/ws$/.test(relayUrl)) throw safeError('INVALID_RELAY_URL');
  if (registrationSecret !== undefined && (typeof registrationSecret !== 'string' || !registrationSecret.length)) {
    throw safeError('INVALID_REGISTRATION_SECRET');
  }

  let stopped = false;
  let ws = null;
  let bridge = null;
  let bridgeStarted = false;
  let bridgeDead = false; // 重启预算耗尽后为真,直到下一次成功起桥
  let pairing = null; // { sid, passHash, url }
  let authStage = 'idle'; // idle → registered → challenged → authenticated
  let reconnectTimer = null;
  // 上次注册成功的凭据；重连时优先用它接管原房间（sid 不变，手机端配对不失效）。
  let creds = null;
  let reattaching = false;
  let matchedUp = false; // 房间当前是否手机+设备齐全（决定 app-server 出站是否放行）
  const pending = new Map(); // 反向请求超时看护（按 method 分档，见 handleAppServerFrame）

  function log(event, detail) { logger(event, detail); }

  function ensureMid() {
    fs.mkdirSync(path.dirname(midFile), { recursive: true });
    try { return fs.readFileSync(midFile, 'utf8').trim(); } catch { /* 首次运行 */ }
    const mid = `companion-${randomBytes(16).toString('hex')}`;
    fs.writeFileSync(midFile, mid, { mode: 0o600 });
    return mid;
  }
  const mid = ensureMid();

  // 注册口令持久化（与 mid 同目录）：配合 relay 的确定性 sid（由 pass_hash+mid 派生），
  // 进程重启/开机自启动/掉线重连都得到同一配对码，手机端无需重扫。
  function ensurePassHash() {
    const passHashFile = path.join(path.dirname(midFile), 'passhash');
    fs.mkdirSync(path.dirname(passHashFile), { recursive: true });
    try {
      const saved = fs.readFileSync(passHashFile, 'utf8').trim();
      if (/^[A-Za-z0-9+/]{43}=$/.test(saved)) return saved;
    } catch { /* 首次运行 */ }
    const generated = randomBytes(32).toString('base64');
    fs.writeFileSync(passHashFile, generated, { mode: 0o600 });
    return generated;
  }
  const passHash = ensurePassHash();

  // 单实例锁（与 mid 同目录）：自启动实例与手动实例并存会互踢（同 mid+口令
  // 派生同一房间，注册互为 owner 接管）。持锁进程死亡后锁可被新实例接管。
  const lockFile = path.join(path.dirname(midFile), 'companion.lock');
  const isPidAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  (function acquireInstanceLock() {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10); } catch { /* 首次运行 */ }
    // 同进程的第二个实例 pid 相同，同样视为已持有锁（stop() 会删锁，正常重取不受影响）
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      throw safeError('ALREADY_RUNNING');
    }
    fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
  })();

  function send(value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_PAYLOAD) return false;
    ws.send(json);
    return true;
  }

  function startBridge() {
    if (bridgeStarted) return;
    let token;
    try { token = readModelAuth(v2ConfigPath || path.join(os.homedir(), '.zcode/v2/config.json')); }
    catch (error) {
      // 不置位 bridgeStarted：token 读取失败可能是瞬时的（桌面正在重写 config /
      // 用户尚未登录），下一次手机帧自然重试，而非永久禁用直到进程重启。
      log('model-auth-missing', error.code);
      return;
    }
    bridgeStarted = true;
    bridgeDead = false;
    const resolved = zcodeCommand || defaultZcodeCommand();
    bridge = new AppServerBridge({
      command: resolved.command, args: resolved.args, cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: token },
      logger: (event, detail) => log(event, detail),
      onDead: () => {
        // 重启预算耗尽：重置标志让下一次手机帧触发整体重试，并如实上报状态。
        bridge = null; bridgeStarted = false; bridgeDead = true;
        log('bridge-dead', ''); onStateChange('app-server-dead');
      },
    });
    bridge.onFrame = handleAppServerFrame;
    // 新 app-server 进程的 server-N id 从头计数：作废旧 pending（只清定时器，
    // 不代答——旧进程已不在，写了也无人认领）。
    bridge.onRespawn = () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
    bridge.start();
    log('bridge-started', '');
    onStateChange('app-server-started');
  }

  function sendToPhone(frame) {
    // 未配对（手机离席）时不出站：配合 relay 的静默丢弃语义，避免任何踢除路径。
    if (!matchedUp) return;
    send({ type: 'data', payload: shrinkFrame(frame) });
  }

  // 大响应截断：session/resume 响应携带全量消息历史（实测可达 26MB），
  // 超 relay 1MiB 帧上限时对半收敛只保留尾部消息并打 messagesTruncated 标记。
  function shrinkFrame(frame) {
    const budget = MAX_PAYLOAD - 64 * 1024;
    try {
      if (Buffer.byteLength(JSON.stringify(frame)) <= budget) return frame;
      const result = frame && frame.result;
      if (result && Array.isArray(result.messages) && result.messages.length > 1) {
        let kept = result.messages.length;
        let copy;
        do {
          kept = Math.max(1, Math.floor(kept / 2));
          copy = { ...result, messages: result.messages.slice(-kept), messagesTruncated: true, truncatedMessageCount: result.messages.length };
        } while (Buffer.byteLength(JSON.stringify({ ...frame, result: copy })) > budget && kept > 1);
        frame = { ...frame, result: copy };
        log('frame-truncated', `messages kept=${kept}/${copy.truncatedMessageCount}`);
      }
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_PAYLOAD) {
        // 单条消息仍超限（极端情况）：回错误而不是断线
        return { id: frame.id, error: { code: ERR_FRAME_TOO_LARGE, message: '响应过大：单条消息超出中继帧上限，请在桌面端处理该会话' } };
      }
      return frame;
    } catch { return frame; }
  }

  // app-server → 手机。运行时偏好反向请求由 companion 代答；其余反向请求
  // 转发给手机端应答并做超时看护（默认长档，见 lib/protocol.js 失败模式
  // 分析）：仅白名单快速方法走短档；超时代答 -32022 拒绝。
  function handleAppServerFrame(frame) {
    if (frame.method && frame.id != null) {
      if (frame.method === RUNTIME_PREFERENCES_METHOD) {
        bridge.write({ id: frame.id, result: RUNTIME_PREFERENCES_RESULT });
        return;
      }
      const timeoutMs = isFastMethod(frame.method) ? requestTimeoutMs : permissionRequestTimeoutMs;
      const stale = pending.get(frame.id);
      if (stale) clearTimeout(stale); // 同 id 覆盖前先清旧定时器，防旧定时器误杀复用 id 的新请求
      const timer = setTimeout(() => {
        if (pending.delete(frame.id) && bridge) {
          bridge.write({ id: frame.id, error: { code: ERR_TIMEOUT, message: 'Client request timed out' } });
        }
      }, timeoutMs).unref();
      pending.set(frame.id, timer);
    }
    sendToPhone(frame);
  }

  // 手机 → app-server。
  function handlePhoneFrame(frame) {
    if (!isObject(frame)) return;
    // 手机端对反向请求的应答：无对应看护条目（已超时代答/进程重启作废/迟到）
    // 则静默丢弃，不向 app-server 转发重复响应（重复应答是协议错误源）。
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined) && !frame.method) {
      const timer = pending.get(frame.id);
      if (!timer) return;
      clearTimeout(timer); pending.delete(frame.id);
    }
    startBridge();
    if (!bridge) {
      // 桥不可用（未登录/spawn 失败/重启预算耗尽）：回明确错误而非静默挂起。
      if (frame.method && frame.id != null && matchedUp) {
        send({ type: 'data', payload: { id: frame.id, error: { code: ERR_UNHANDLED, message: 'companion 桥不可用：app-server 未启动或桌面未登录 ZCode' } } });
      }
      return;
    }
    if (bridge.write(frame)) bridge.resetRestartBudget();
  }

  function register() {
    authStage = 'registering';
    pairing = { sid: null, passHash, url: null };
    send({ type: 'device_register_init', device_mid: mid, pass_hash: passHash,
      ...(registrationSecret ? { register_proof: deriveRegisterProof({ secret: registrationSecret, mid }) } : {}) });
  }

  function connect() {
    if (stopped) return;
    const url = new URL(relayUrl);
    url.searchParams.set('mid', mid);
    ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
      headers: { 'x-device-id': mid }, handshakeTimeout: 15000 });
    // 本连接的本地引用：stop() 置空外层 ws 后，关闭握手期间迟到的消息帧
    // 不会解引用 null（TypeError 杀进程），也不会误碰新连接。
    const conn = ws;
    ws.on('open', () => {
      // 重连优先接管原房间（同 sid/hash 再认证，relay 原生支持）：配对码保持有效。
      // 房间已失效时 relay 回 error，届时作废本地凭据，下次重连全新注册出新码。
      if (creds) {
        reattaching = true;
        pairing = { sid: creds.sid, passHash: creds.passHash,
          url: derivePairingUrl(relayUrl, creds.sid, creds.passHash) };
        authStage = 'registered';
        send({ type: 'auth_init', role: 'device', device_sid: creds.sid });
        return;
      }
      register();
    });
    ws.on('error', () => { /* close 兜底重连 */ });
    ws.on('close', () => {
      if (ws !== conn) return; // 陈旧连接的迟到 close：不动当前状态
      ws = null;
      authStage = 'idle';
      matchedUp = false;
      reattaching = false;
      // relay 断开（重部署/闪断）时桥通常仍在：对未应答的反向请求立即代答 -32022，
      // 维持"每个转发的反向请求最终必有应答"的不变量，避免桌面回合中途无限挂起。
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        if (bridge) bridge.write({ id, error: { code: ERR_TIMEOUT, message: 'Client request timed out' } });
      }
      pending.clear();
      onStateChange('disconnected');
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs).unref();
      }
    });
    ws.on('message', (raw, binary) => {
      if (ws !== conn) return; // 关闭握手期间或已换代：丢弃迟到帧
      if (binary) return;
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!isObject(msg)) return;
      if (msg.type === 'error') {
        // 接管尝试被拒（房间过期/被占等）：作废凭据，重连后走全新注册。
        // 注意 reattaching 只在接管握手期间为真（auth_ack 处清零），
        // 会话中途的错误帧（如限流）不会误烧凭据导致手机配对失效。
        if (reattaching) creds = null;
        log('relay-error', msg.code || '');
        conn.close();
        return;
      }
      if (msg.type === 'device_register_ack') {
        if (authStage !== 'registering' || typeof msg.device_sid !== 'string' || !msg.device_sid) { conn.close(); return; }
        pairing.sid = msg.device_sid;
        pairing.url = derivePairingUrl(relayUrl, pairing.sid, pairing.passHash);
        creds = { sid: pairing.sid, passHash: pairing.passHash };
        authStage = 'registered';
        onPairing(pairing.url); // 配对 URL 一次性交给宿主（渲染 QR 用）
        onStateChange('waiting-pairing');
        send({ type: 'auth_init', role: 'device', device_sid: pairing.sid });
        return;
      }
      if (msg.type === 'auth_challenge') {
        if (authStage !== 'registered' || typeof msg.nonce !== 'string' || !msg.nonce) { conn.close(); return; }
        authStage = 'challenged';
        const proof = deriveProof({ passHash: pairing.passHash, nonce: msg.nonce, role: 'device', sid: pairing.sid });
        send({ type: 'auth_response', device_sid: pairing.sid, proof });
        return;
      }
      if (msg.type === 'auth_ack') {
        if (authStage !== 'challenged' || !['matched', 'waiting'].includes(msg.pair_status)) return;
        // 设备端先于手机完成认证时收到 waiting：状态推进，等 pair_status_ack matched 再起桥。
        authStage = 'authenticated';
        reattaching = false; // 接管握手完成：后续错误帧不再按"接管被拒"烧凭据
        matchedUp = msg.pair_status === 'matched';
        if (msg.pair_status === 'matched') { startBridge(); onStateChange('paired'); }
        else onStateChange('waiting-pairing');
        return;
      }
      if (msg.type === 'pair_status_ack') {
        if (authStage !== 'authenticated') return;
        matchedUp = msg.pair_status === 'matched';
        if (msg.pair_status === 'matched') { startBridge(); onStateChange('paired'); }
        else onStateChange('waiting-pairing');
        return;
      }
      if (msg.type === 'data') {
        if (authStage !== 'authenticated' || !isObject(msg.payload)) return;
        handlePhoneFrame(msg.payload);
      }
    });
  }

  return {
    start() {
      if (stopped) throw safeError('ALREADY_STOPPED');
      connect();
    },
    get pairingUrl() { return pairing ? pairing.url : null; },
    get state() {
      if (!ws) return 'disconnected';
      if (authStage !== 'authenticated') return 'connecting';
      // 以房间实际配对状态为准：手机离席时如实报告 waiting-pairing 而非残留 paired。
      if (!matchedUp) return 'waiting-pairing';
      if (bridgeDead) return 'app-server-dead';
      return bridgeStarted && bridge ? 'paired' : 'paired-no-model';
    },
  stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearTimeout(reconnectTimer);
    try {
      if (parseInt(fs.readFileSync(lockFile, 'utf8'), 10) === process.pid) fs.unlinkSync(lockFile);
    } catch { /* 锁已被接管或不存在 */ }
    const parts = [];
    if (bridge) {
      parts.push(bridge.stop());
      bridge = null;
    }
    if (ws) {
      const socket = ws;
      ws = null;
      parts.push(new Promise((resolve) => {
        socket.removeAllListeners('close');
        socket.once('close', () => resolve());
        setTimeout(() => { socket.terminate(); resolve(); }, 1000).unref();
        try { socket.close(1000); } catch { socket.terminate(); resolve(); }
      }));
    }
    return Promise.all(parts);
  },
  };
}

// 读取注册共享密钥文件 ~/.wzxclaw/zcode-companion/relay-secret（首行，去 CRLF）。
// 与 NAS 部署脚本 deploy-nas-zcode.sh 读取的路径同名同语义——两端各自持有同一行
// 密钥，不进 git、不进进程参数。文件缺失或为空返回 ''（开放注册模式，不附 proof）。
function readRegistrationSecretFile(homeDir = os.homedir()) {
  const secretFile = path.join(homeDir, '.wzxclaw', 'zcode-companion', 'relay-secret');
  try {
    const firstLine = fs.readFileSync(secretFile, 'utf8').split(/\r?\n/, 1)[0].trim();
    // 凭据文件统一 0600（与 mid/passhash 一致；此前遗漏）
    try { fs.chmodSync(secretFile, 0o600); } catch { /* 平台不支持时忽略 */ }
    return firstLine || '';
  } catch {
    return '';
  }
}

module.exports = { createCompanion, AppServerBridge, readModelAuth, derivePairingUrl, defaultZcodeCommand, readRegistrationSecretFile };
// 把配对二维码渲染成 PNG + 纯文本链接，写到固定位置（数据目录 + 可选额外路径）。
// 口令/房间号均持久化且确定性派生：二维码内容几乎永不变化——
// 用户永远去同一个固定路径取最新码，无需每次找。
async function writePairingArtifacts(url, midFile, extraPngPath) {
  const dataDir = path.dirname(path.resolve(midFile));
  fs.mkdirSync(dataDir, { recursive: true });
  const pngTargets = [path.join(dataDir, 'pair-qr.png')];
  if (extraPngPath) pngTargets.push(extraPngPath);
  fs.writeFileSync(path.join(dataDir, 'pair-url.txt'), url, { mode: 0o600 });
  let qrcodeLib = null;
  try { qrcodeLib = require('qrcode'); } catch { /* 未安装则只写文本 */ }
  if (qrcodeLib) {
    for (const target of pngTargets) {
      try { await qrcodeLib.toFile(target, url, { width: 600, margin: 2 }); } catch { /* 尽力而为 */ }
    }
  }
  console.error(`[companion] 配对码已更新：${pngTargets[0]}（文本链接 ${dataDir}${path.sep}pair-url.txt）`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const relayIdx = args.indexOf('--relay');
  const cwdIdx = args.indexOf('--cwd');
  const noQrIdx = args.indexOf('--no-qr');
  const secretIdx = args.indexOf('--register-secret');
  const midFileIdx = args.indexOf('--mid-file');
  const qrPngIdx = args.indexOf('--qr-png');
  const midFile = midFileIdx !== -1 && args[midFileIdx + 1] ? args[midFileIdx + 1] : undefined;
  const qrPngPath = qrPngIdx !== -1 && args[qrPngIdx + 1] ? args[qrPngIdx + 1] : undefined;
  // 注册共享密钥三级回退：CLI 参数 > 环境变量 REGISTRATION_SECRET >
  // ~/.wzxclaw/zcode-companion/relay-secret 文件；都未提供时不附
  // register_proof（对开放注册的 relay 零影响）。
  // 密钥来源：环境变量 > 文件（0600）。CLI 参数档会进 shell history /
  // 进程列表，与「密钥不进进程参数」约定冲突——仅保留供测试，并打印警告。
  const registrationSecret = secretIdx !== -1 && args[secretIdx + 1]
    ? (console.error('[companion] 警告: --register-secret 会暴露在进程参数中，仅建议测试使用'),
       args[secretIdx + 1])
    : process.env.REGISTRATION_SECRET || readRegistrationSecretFile();
  if (relayIdx === -1 || !args[relayIdx + 1]) {
    console.error('用法: node companion.js --relay ws://127.0.0.1:18884/ws [--cwd <工作目录>] [--no-qr] [--register-secret <注册密钥>] [--mid-file <路径>] [--qr-png <路径>]');
    process.exitCode = 1;
  } else {
    let qrTerminal;
    try { qrTerminal = require('qrcode-terminal'); } catch { qrTerminal = null; }
    let companion;
    try {
      companion = createCompanion({
        relayUrl: args[relayIdx + 1],
        ...(registrationSecret ? { registrationSecret } : {}),
        cwd: cwdIdx !== -1 && args[cwdIdx + 1] ? args[cwdIdx + 1] : process.cwd(),
        ...(midFileIdx !== -1 && args[midFileIdx + 1] ? { midFile: args[midFileIdx + 1] } : {}),
        logger: (event, detail) => console.error(`[companion] ${event}${detail ? ` ${detail}` : ''}`),
        onPairing: (url) => {
          console.log('配对 URL（扫码或粘贴到手机 App）:');
          if (qrTerminal && noQrIdx === -1) {
            console.log('');
            // 必须以方法形式调用（内部依赖 this.error 取纠错级别）
            qrTerminal.generate(url, { small: true });
          }
          console.log(url);
          // 二维码 PNG/文本链接写到固定位置：口令与房间号确定性派生，
          // 内容几乎永不变化——用户始终去同一路径取码。
          writePairingArtifacts(
            url,
            midFile || path.join(os.homedir(), '.wzxclaw', 'zcode-companion', 'mid'),
            qrPngPath,
          ).catch(() => {});
        },
        onStateChange: (state) => console.error(`[companion] state=${state}`),
      });
    } catch (error) {
      if (error && error.code === 'ALREADY_RUNNING') {
        console.error('[companion] 已有实例正在运行（同一数据目录），本实例退出。');
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
    if (companion) {
      companion.start();
      // 断线重连定时器是 unref 的：CLI 模式必须持有事件循环，
      // 否则掉线瞬间进程静默退出（测试/库模式不受影响）。
      const keepalive = setInterval(() => {}, 1 << 30);
      // 静默死亡取证：未捕获异常/拒绝必须留下堆栈再退（曾出现无日志 exit 1）
      process.on('uncaughtException', (error) => {
        console.error(`[companion] uncaughtException: ${error && error.stack || error}`);
        clearInterval(keepalive);
        companion.stop();
        process.exit(1);
      });
      process.on('unhandledRejection', (reason) => {
        console.error(`[companion] unhandledRejection: ${reason && reason.stack || reason}`);
      });
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => { clearInterval(keepalive); companion.stop(); process.exit(0); });
      }
    }
  }
}
