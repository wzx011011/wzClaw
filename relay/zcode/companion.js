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
const { randomBytes, createHmac } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { MAX_PAYLOAD } = require('./server');

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
  return `${base}?sid=${encodeURIComponent(sid)}&hash=${encodeURIComponent(hash)}`;
}

// app-server stdio 桥：按行分帧，崩溃自动重启（上限 + 退避）。
class AppServerBridge {
  constructor({ command, args, cwd, env, logger, maxRestarts = 5, restartDelayMs = 1000 }) {
    this.command = command; this.args = args; this.cwd = cwd; this.env = env;
    this.logger = logger || (() => {});
    this.maxRestarts = maxRestarts; this.restartDelayMs = restartDelayMs;
    this.child = null; this.buffer = ''; this.restarts = 0;
    this.onFrame = null; this.onDead = null; this.stopped = false;
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
    child.stdout.on('data', (chunk) => this.feed(chunk.toString()));
    child.stderr.on('data', (chunk) => this.logger('appserver-stderr', chunk.toString().slice(0, 2000)));
    child.on('error', (error) => { this.logger('appserver-spawn-error', error.code || String(error)); this.scheduleRestart(); });
    child.on('exit', (code, signal) => { this.child = null; this.scheduleRestart(code, signal); });
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
    reconnectDelayMs = 5000, requestTimeoutMs = 15000,
  } = options;
  if (typeof relayUrl !== 'string' || !/^wss?:\/\/.+\/ws$/.test(relayUrl)) throw safeError('INVALID_RELAY_URL');

  let stopped = false;
  let ws = null;
  let bridge = null;
  let bridgeStarted = false;
  let pairing = null; // { sid, passHash, url }
  let authStage = 'idle'; // idle → registered → challenged → authenticated
  let reconnectTimer = null;
  const pending = new Map(); // 反向请求超时看护（不代答的转发给手机端）

  function log(event, detail) { logger(event, detail); }

  function ensureMid() {
    fs.mkdirSync(path.dirname(midFile), { recursive: true });
    try { return fs.readFileSync(midFile, 'utf8').trim(); } catch { /* 首次运行 */ }
    const mid = `companion-${randomBytes(16).toString('hex')}`;
    fs.writeFileSync(midFile, mid, { mode: 0o600 });
    return mid;
  }
  const mid = ensureMid();

  function send(value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_PAYLOAD) return false;
    ws.send(json);
    return true;
  }

  function startBridge() {
    if (bridgeStarted) return;
    bridgeStarted = true;
    let token;
    try { token = readModelAuth(v2ConfigPath || path.join(os.homedir(), '.zcode/v2/config.json')); }
    catch (error) { log('model-auth-missing', error.code); return; }
    const resolved = zcodeCommand || defaultZcodeCommand();
    bridge = new AppServerBridge({
      command: resolved.command, args: resolved.args, cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: token },
      logger: (event, detail) => log(event, detail),
      onDead: () => { log('bridge-dead', ''); onStateChange('app-server-dead'); },
    });
    bridge.onFrame = handleAppServerFrame;
    bridge.start();
    log('bridge-started', '');
    onStateChange('app-server-started');
  }

  function sendToPhone(frame) { send({ type: 'data', payload: shrinkFrame(frame) }); }

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
        return { id: frame.id, error: { code: -32001, message: '响应过大：单条消息超出中继帧上限，请在桌面端处理该会话' } };
      }
      return frame;
    } catch { return frame; }
  }

  // app-server → 手机。运行时偏好反向请求由 companion 代答；其余反向请求
  // （权限确认等）转发给手机端应答，并做超时看护。
  function handleAppServerFrame(frame) {
    if (frame.method && frame.id != null) {
      if (frame.method === RUNTIME_PREFERENCES_METHOD) {
        bridge.write({ id: frame.id, result: RUNTIME_PREFERENCES_RESULT });
        return;
      }
      const timer = setTimeout(() => {
        if (pending.delete(frame.id) && bridge) {
          bridge.write({ id: frame.id, error: { code: -32022, message: 'Client request timed out' } });
        }
      }, requestTimeoutMs).unref();
      pending.set(frame.id, timer);
    }
    sendToPhone(frame);
  }

  // 手机 → app-server。
  function handlePhoneFrame(frame) {
    if (!isObject(frame)) return;
    // 手机端对反向请求的应答：清理看护计时器。
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined) && !frame.method) {
      const timer = pending.get(frame.id);
      if (timer) { clearTimeout(timer); pending.delete(frame.id); }
    }
    startBridge();
    if (!bridge) return;
    if (bridge.write(frame)) bridge.resetRestartBudget();
  }

  function register() {
    authStage = 'registering';
    const passHash = randomBytes(32).toString('base64');
    pairing = { sid: null, passHash, url: null };
    send({ type: 'device_register_init', device_mid: mid, pass_hash: passHash });
  }

  function connect() {
    if (stopped) return;
    const url = new URL(relayUrl);
    url.searchParams.set('mid', mid);
    ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
      headers: { 'x-device-id': mid }, handshakeTimeout: 15000 });
    let registered = false;
    ws.on('open', () => { register(); });
    ws.on('error', () => { /* close 兜底重连 */ });
    ws.on('close', () => {
      ws = null;
      authStage = 'idle';
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      onStateChange('disconnected');
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs).unref();
      }
    });
    ws.on('message', (raw, binary) => {
      if (binary) return;
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!isObject(msg)) return;
      if (msg.type === 'error') { log('relay-error', msg.code || ''); ws.close(); return; }
      if (msg.type === 'device_register_ack') {
        if (authStage !== 'registering' || typeof msg.device_sid !== 'string' || !msg.device_sid) { ws.close(); return; }
        registered = true;
        pairing.sid = msg.device_sid;
        pairing.url = derivePairingUrl(relayUrl, pairing.sid, pairing.passHash);
        authStage = 'registered';
        onPairing(pairing.url); // 配对 URL 一次性交给宿主（渲染 QR 用）
        onStateChange('waiting-pairing');
        send({ type: 'auth_init', role: 'device', device_sid: pairing.sid });
        return;
      }
      if (msg.type === 'auth_challenge') {
        if (authStage !== 'registered' || typeof msg.nonce !== 'string' || !msg.nonce) { ws.close(); return; }
        authStage = 'challenged';
        const proof = createHmac('sha256', pairing.passHash)
          .update(`${msg.nonce}|device|${pairing.sid}`).digest('base64url');
        send({ type: 'auth_response', device_sid: pairing.sid, proof });
        return;
      }
      if (msg.type === 'auth_ack') {
        if (authStage !== 'challenged' || !['matched', 'waiting'].includes(msg.pair_status)) return;
        // 设备端先于手机完成认证时收到 waiting：状态推进，等 pair_status_ack matched 再起桥。
        authStage = 'authenticated';
        if (msg.pair_status === 'matched') { startBridge(); onStateChange('paired'); }
        else onStateChange('waiting-pairing');
        return;
      }
      if (msg.type === 'pair_status_ack') {
        if (authStage !== 'authenticated') return;
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
      return bridgeStarted && bridge ? 'paired' : 'paired-no-model';
    },
  stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearTimeout(reconnectTimer);
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

module.exports = { createCompanion, AppServerBridge, readModelAuth, derivePairingUrl, defaultZcodeCommand };
if (require.main === module) {
  const args = process.argv.slice(2);
  const relayIdx = args.indexOf('--relay');
  const cwdIdx = args.indexOf('--cwd');
  const noQrIdx = args.indexOf('--no-qr');
  if (relayIdx === -1 || !args[relayIdx + 1]) {
    console.error('用法: node companion.js --relay ws://127.0.0.1:18884/ws [--cwd <工作目录>] [--no-qr]');
    process.exitCode = 1;
  } else {
    let renderQr;
    try { renderQr = require('qrcode-terminal').generate; } catch { renderQr = null; }
    const companion = createCompanion({
      relayUrl: args[relayIdx + 1],
      cwd: cwdIdx !== -1 && args[cwdIdx + 1] ? args[cwdIdx + 1] : process.cwd(),
      logger: (event, detail) => console.error(`[companion] ${event}${detail ? ` ${detail}` : ''}`),
      onPairing: (url) => {
        console.log('配对 URL（扫码或粘贴到手机 App）:');
        if (renderQr && noQrIdx === -1) {
          console.log('');
          renderQr(url, { small: true });
        }
        console.log(url);
      },
      onStateChange: (state) => console.error(`[companion] state=${state}`),
    });
    companion.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { companion.stop(); process.exit(0); });
  }
}
