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
const { ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT, ERR_X_BAD_PARAMS,
  ERR_X_GIT_TIMEOUT, ERR_X_GIT_FAILED, isFastMethod } = require('./lib/protocol');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeError = (code) => Object.assign(new Error(code), { code });

// 单条 app-server NDJSON 不能无限积累。上限必须高于 relay 1MiB：companion 会先
// 收到并截断大型 session/resume（实测可达约 26MiB）再走 relay；32MiB 允许这条
// 正常恢复路径，同时阻止无换行坏流吃尽常驻进程内存。
const MAX_NDJSON_BUFFER = 32 * 1024 * 1024;

const RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';
const RUNTIME_PREFERENCES_RESULT = { nativeSearchEnhancementsEnabled: false };

// 默认解析本机 ZCode 安装（可被 options.zcodeCommand 覆盖，测试注入假进程用）。
// 必须与 runtime 预检复用同一解析结果，否则预检与长期 bridge 的运行时宿主可能不一致。
function defaultZcodeCommand(env = process.env) {
  const resolved = resolveZcodeRuntime(env);
  if (resolved.category === 'resolved') return { command: resolved.command, args: resolved.args };
  return { command: 'zcode', args: [] };
}

// 运行时预检只产生脱敏的状态码，绝不向调用者返回命令行、token 或原始 stderr。
function resolveZcodeRuntime(env = process.env) {
  const local = path.join(env.LOCALAPPDATA || '', 'Programs/ZCode/resources/glm/zcode.cjs');
  const host = path.join(env.LOCALAPPDATA || '', 'Programs/ZCode/ZCode.exe');
  const commandForRuntime = (runtime) => {
    // 打包 Companion 的 Electron 不能代替官方 ZCode host 执行其 cjs runtime。
    // 本机独立安装完整时必须使用同安装目录官方 host；CLI 保持 Node 自身路径。
    if (process.versions.electron && fs.existsSync(host)) return host;
    return process.execPath;
  };
  // 内嵌 runtime（Companion 安装包 extraResources 自带，2026-09-17 策略：
  // 允许内嵌自用、不公开分发、官方安装优先）。打包态取 resources/zcode-runtime；
  // 开发/测试用 WZXCLAW_BUNDLED_RUNTIME 显式指定。CLI（无 resourcesPath）或
  // 文件不存在时自然跳过。路径不存在不报错——它只是兜底，不是用户显式配置。
  const bundled = env.WZXCLAW_BUNDLED_RUNTIME
    || (process.resourcesPath
      ? path.join(process.resourcesPath, 'zcode-runtime', 'glm', 'zcode.cjs')
      : null);
  if (env.ZCODE_BIN) {
    if (!fs.existsSync(env.ZCODE_BIN)) return { category: 'invalid-override' };
    return { category: 'resolved', source: 'environment', command: commandForRuntime(env.ZCODE_BIN), args: [env.ZCODE_BIN] };
  }
  if (fs.existsSync(local)) return { category: 'resolved', source: 'installed', command: commandForRuntime(local), args: [local] };
  if (bundled && fs.existsSync(bundled)) {
    // 宿主 = Companion 自身可执行文件的 Node 模式（E41 起宿主 Node 含
    // node:sqlite，实测可承载 runtime；ELECTRON_RUN_AS_NODE 由
    // runtimeProcessEnv 按 .cjs 参数自动注入）
    return { category: 'resolved', source: 'bundled', command: process.execPath, args: [bundled] };
  }
  return { category: 'resolved', source: 'path', command: 'zcode', args: [] };
}

function runtimeProcessEnv(resolved, env = process.env) {
  // Electron host（包括独立安装的 ZCode.exe）执行 cjs runtime 时必须切 Node 模式；
  // 直接 PATH CLI 与其他可执行文件参数均不携带该变量。
  const runtimeScript = resolved.args[0];
  const runsCjsRuntime = typeof runtimeScript === 'string' && runtimeScript.toLowerCase().endsWith('.cjs');
  return {
    ...env,
    ...(runsCjsRuntime && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

function runRuntimeCommand(resolved, commandArgs, { timeoutMs = 5000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child; let settled = false; let stdout = ''; let stderr = ''; let stderrBytes = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child) try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.kill(); } catch { /* 已退出 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs).unref();
    try {
      child = spawn(resolved.command, [...resolved.args, ...commandArgs], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: runtimeProcessEnv(resolved, env),
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, 16 * 1024); });
      // 只排空并计量，不返回/记录原文，避免凭据或会话内容进入 UI 日志。
      child.stderr.on('data', (chunk) => {
        stderrBytes = Math.min(stderrBytes + chunk.length, 16 * 1024);
        // 某些官方 CLI 把 --version 写到 stderr；只在内存中限长保留供版本解析，
        // 不向日志/UI/调用方公开原文。
        stderr = (stderr + chunk).slice(0, 16 * 1024);
      });
      child.on('error', (error) => finish({ ok: false, code: error.code || 'SPAWN_ERROR' }));
      child.on('exit', (code) => finish(code === 0
        ? { ok: true, stdout: stdout.trim(), versionText: `${stdout}\n${stderr}`.trim() }
        : { ok: false, code: `EXIT_${code ?? 'UNKNOWN'}`, stderrPresent: stderrBytes > 0 }));
    } catch (error) { finish({ ok: false, code: error.code || 'SPAWN_ERROR' }); }
  });
}

function probeAppServer(resolved, { cwd, env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child; let settled = false; let buffer = '';
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child) try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.kill(); } catch { /* 已退出 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs).unref();
    try {
      child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', cwd], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: runtimeProcessEnv(resolved, env),
      });
      child.stdout.setEncoding('utf8');
      child.stderr.on('data', () => { /* 排空但不记录原文，防敏感诊断泄漏 */ });
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 32 * 1024) return finish({ ok: false, code: 'OUTPUT_LIMIT' });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line) continue;
          let frame;
          try { frame = JSON.parse(line); } catch { return finish({ ok: false, code: 'BAD_RESPONSE' }); }
          if (frame.method && frame.id != null) {
            const response = frame.method === RUNTIME_PREFERENCES_METHOD
              ? { id: frame.id, result: RUNTIME_PREFERENCES_RESULT }
              : { id: frame.id, error: { code: ERR_UNHANDLED, message: 'runtime probe does not handle this request' } };
            try { child.stdin.write(`${JSON.stringify(response)}\n`); } catch { return finish({ ok: false, code: 'WRITE_FAILED' }); }
          } else if (frame.id === 'runtime-probe-1') {
            return Array.isArray(frame.result?.sessions)
              ? finish({ ok: true })
              : finish({ ok: false, code: frame.error ? 'APP_SERVER_ERROR' : 'BAD_RESPONSE' });
          }
        }
      });
      child.on('error', (error) => finish({ ok: false, code: error.code || 'SPAWN_ERROR' }));
      child.on('exit', (code) => finish({ ok: false, code: `EXIT_${code ?? 'UNKNOWN'}` }));
      child.stdin.on('error', () => finish({ ok: false, code: 'WRITE_FAILED' }));
      child.stdin.write('{"id":"runtime-probe-1","method":"session/list","params":{}}\n');
    } catch (error) { finish({ ok: false, code: error.code || 'SPAWN_ERROR' }); }
  });
}

async function probeZcodeRuntime({ cwd = process.cwd(), v2ConfigPath, env = process.env } = {}) {
  const resolved = resolveZcodeRuntime(env);
  if (resolved.category !== 'resolved') return { category: resolved.category, source: null, version: null, detailCode: null };
  const version = await runRuntimeCommand(resolved, ['--version'], { env });
  if (!version.ok) return { category: version.code === 'ENOENT' ? 'not-installed' : 'version-failed', source: resolved.source, version: null, detailCode: version.code };
  const versionText = (version.versionText || version.stdout).match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null;
  if (!versionText) return { category: 'version-failed', source: resolved.source, version: null, detailCode: 'BAD_VERSION' };
  const doctor = await runRuntimeCommand(resolved, ['doctor'], { timeoutMs: 10000, env });
  if (!doctor.ok) {
    return { category: 'doctor-failed', source: resolved.source, version: versionText,
      detailCode: doctor.code, doctorWarning: null };
  }
  let token;
  try { token = readModelAuth(v2ConfigPath || path.join(os.homedir(), '.zcode/v2/config.json')); }
  catch (error) { return { category: error.code === 'NOT_LOGGED_IN' ? 'not-logged-in' : 'auth-store-unreadable', source: resolved.source, version: versionText, detailCode: error.code, doctorWarning: doctor.ok ? null : doctor.code }; }
  const probe = await probeAppServer(resolved, {
    cwd,
    env: { ...env, ANTHROPIC_API_KEY: token },
  });
  return probe.ok
    ? { category: 'ready', source: resolved.source, version: versionText, detailCode: null, doctorWarning: doctor.ok ? null : doctor.code }
    : { category: probe.code === 'TIMEOUT' ? 'app-server-timeout' : 'app-server-failed', source: resolved.source, version: versionText, detailCode: probe.code, doctorWarning: doctor.ok ? null : doctor.code };
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
  constructor({ command, args, cwd, env, logger, onDead, maxRestarts = 5, restartDelayMs = 1000,
    restartWindowMs = 5 * 60 * 1000 }) {
    this.command = command; this.args = args; this.cwd = cwd; this.env = env;
    this.logger = logger || (() => {});
    this.maxRestarts = maxRestarts; this.restartDelayMs = restartDelayMs;
    // 预算按时间滑窗计（默认 5 分钟 5 次）：固定计数 + 每帧重置预算会被
    // 「崩溃循环 + 持续手机流量」打成约 1 次/秒的无限快拉。
    this.restartWindowMs = restartWindowMs; this.restartTimes = [];
    this.child = null; this.buffer = '';
    // onDead 必须从选项取：此前构造器忽略它导致预算耗尽回调永不触发，
    // 宿主永远看不到 app-server-dead 状态（回归锚：companion.test 连崩用例）
    this.onDead = onDead || null;
    this.onFrame = null; this.onRespawn = null; this.stopped = false;
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
    // 子进程 stderr 可能含配置、请求或凭据上下文；只留长度观测，绝不转发原文。
    child.stderr.on('data', (chunk) => this.logger('appserver-stderr', `bytes=${Buffer.byteLength(chunk)}`));
    // 子进程死亡瞬间的在途写入会在 stdin 流（而非 child 对象）上异步抛
    // EOF/EPIPE——不挂监听就是 uncaughtException，整个 companion 进程被带走
    // （CLI 与 Electron 壳同命）。挂日志监听消化；后续写入靠 write() 的
    // writable 检查挡住并有应答。
    child.stdin.on('error', (error) => {
      this.logger('appserver-stdin-error', error.code || String(error));
    });
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
    this.logger('appserver-respawned', '');
  }
  scheduleRestart(code, signal) {
    if (this.stopped) return;
    if (this.child !== null) return;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.restartWindowMs);
    if (this.restartTimes.length >= this.maxRestarts) {
      this.logger('appserver-dead',
        `exit=${code} signal=${signal} restarts=${this.restartTimes.length}/${this.restartWindowMs}ms`,);
      if (this.onDead) this.onDead();
      return;
    }
    this.restartTimes.push(now);
    // 指数退避封顶 30s：连崩时不要按固定节奏快拉
    const delay = Math.min(this.restartDelayMs * 2 ** (this.restartTimes.length - 1), 30000);
    setTimeout(() => { if (!this.stopped && this.child === null) this.spawnChild(); }, delay).unref();
  }
  feed(text) {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_NDJSON_BUFFER) {
      this.logger('appserver-ndjson-overflow', String(Buffer.byteLength(this.buffer)));
      this.buffer = '';
      const child = this.child;
      if (child) child.kill();
      return;
    }
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
  resetRestartBudget() { this.restartTimes = []; }
  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (!this.child) return Promise.resolve();
    const child = this.child; this.child = null;
    child.removeAllListeners('exit');
    // kill 必须同步发起：Electron before-quit 无法等待异步清理，异步杀进程
    // 可能赶不上退出序列 → 孤儿 app-server。优雅退出由 stdin destroy 的
    // EOF 兜底；2s SIGKILL 防僵尸。
    child.kill();
    return new Promise((resolve) => {
      const finish = () => resolve();
      child.once('exit', finish);
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
    // 自发链路保活间隔与僵尸判定阈值（可注入短值供测试）
    linkPingMs = 30000, linkStaleMs = 60000,
    // 引擎 dead 后的重启冷却：冷却内的手机帧直接 ERR_UNHANDLED，不 spawn
    bridgeCooldownMs = 30000,
    // 桥重启预算参数（透传 AppServerBridge，可注入供测试）
    bridgeMaxRestarts = 5, bridgeRestartDelayMs = 1000, bridgeRestartWindowMs = 5 * 60 * 1000,
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
  let linkWatchTimer = null;
  let bridgeDeadAt = 0;
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
    // 对齐 relay 侧同款保护：慢消费链路（bufferedAmount 堆积）fail-fast
    // terminate 触发统一重连，防出站帧在内核缓冲无限堆积成僵尸链路
    if (ws.bufferedAmount > MAX_PAYLOAD * 2) {
      log('send-slow-link-terminate', String(ws.bufferedAmount));
      ws.terminate();
      return false;
    }
    ws.send(json);
    return true;
  }

  function startBridge() {
    if (bridgeStarted) return;
    // 引擎 dead（重启预算耗尽）后的冷却：冷却内的手机帧不再立刻 spawn 一个
    // 全新 bridge（其预算是全新的，等于绕过预算无限快拉），直接走 !bridge
    // 分支回 ERR_UNHANDLED；冷却过后才允许整体重试。
    if (bridgeDead && Date.now() - bridgeDeadAt < bridgeCooldownMs) return;
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
      env: {
        ...process.env, ANTHROPIC_API_KEY: token,
        // Electron 壳（companion_app）内 process.execPath 是 GUI exe：不设
        // 此开关，spawn 出来的会是一个 Chromium 实例而非 stdio node 子进程
        // （桌面 TS 引擎同款处理，见 mobile-app-server-bridge.ts）。纯 node
        // CLI 下该字段不存在，env 保持原样。
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      maxRestarts: bridgeMaxRestarts, restartDelayMs: bridgeRestartDelayMs,
      restartWindowMs: bridgeRestartWindowMs,
      logger: (event, detail) => log(event, detail),
      onDead: () => {
        // 重启预算耗尽：记冷却起点，冷却内手机帧不重试；冷却后下一帧整体重试。
        bridge = null; bridgeStarted = false; bridgeDead = true; bridgeDeadAt = Date.now();
        log('bridge-dead', ''); onStateChange('app-server-dead');
      },
    });
    bridge.onFrame = handleAppServerFrame;
    // 新 app-server 进程的 server-N id 从头计数：作废旧 pending（只清定时器，
    // 不代答——旧进程已不在，写了也无人认领）。
    bridge.onRespawn = () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      // 本地扩展请求同样作废（等价语义：旧进程的应答不会再有）
      for (const entry of localPending.values()) { clearTimeout(entry.timer); entry.resolve(null); }
      localPending.clear();
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
    // 本地扩展请求的应答（x/model/* 等经桥请求）：不透传给手机
    if (frame.id != null && !frame.method && feedLocalResponse(frame)) return;
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
    // x/* 前缀 = companion 本地扩展方法：不进 app-server，由 companion 在
    // 本机执行真实 git/文件系统操作后直接应答。背景（2026-09-16 实测，见
    // probe-git.js 与 APP-SERVER.md）：app-server 协议不暴露 git 分支与
    // 工作区文件系统查询（官方桌面 App 的 git UI 由其 IDE 层自实现），手机端
    // 的分支选择器/工作区新鲜度需要 companion 侧扩展补齐。通道本身已被配对
    // 凭据门禁，且 agent 通道本就可在桌面执行任意代码，此处不额外收敛路径
    // 白名单；但所有命令一律数组参数禁 shell，分支名白名单校验防选项注入。
    if (typeof frame.method === 'string' && frame.method.startsWith('x/') && frame.id != null) {
      handleXMethod(frame);
      return;
    }
    // 手机端对反向请求的应答：无对应看护条目（已超时代答/进程重启作废/迟到）
    // 则静默丢弃，不向 app-server 转发重复响应（重复应答是协议错误源）。
    if (frame.id != null && (frame.result !== undefined || frame.error !== undefined) && !frame.method) {
      const timer = pending.get(frame.id);
      if (!timer) {
        // 迟到/重复应答（已超时代答/进程重启作废/relay 断开代答）：不转发
        // （重复应答是协议错误源），但零观测会变成「手机点了允许却没生效」
        // 的无头案，留日志（只记 id，不含载荷）。
        log('phone-response-late', String(frame.id));
        return;
      }
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
    if (bridge.write(frame)) {
      bridge.resetRestartBudget();
    } else if (frame.method && frame.id != null && matchedUp) {
      // 静默丢弃=缺陷（铁律 4）：引擎重启窗口/帧超限的写入失败必须有应答，
      // 手机端才能立即报错，而不是干等自身超时。
      log('bridge-write-dropped', String(frame.id));
      send({ type: 'data', payload: { id: frame.id, error: { code: ERR_UNHANDLED, message: 'companion 桥不可用：引擎正在重启或帧超限' } } });
    }
  }

  // ---- companion 本地扩展方法（x/*）----

  // git 分支名白名单：常规分支字符，禁止前导 -（选项注入）、..（区间）、
  // 结尾 .lock（git 保留）、空白与控制字符。覆盖个人项目的实际分支命名。
  const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
  const branchAllowed = (name) => BRANCH_RE.test(name) && !name.includes('..') && !name.endsWith('.lock');

  // ---- 模型目录/默认模型（x/model/*）----
  // 职责拆分：
  // - 可用模型来自引擎（session/list → 活跃会话 resume → settings.model.
  //   available，实测唯一可信目录源）；导入快照（companion_app 的
  //   import-snapshot.json）作为目录补充展示，标记 unavailable=false 待引擎证实。
  // - 默认模型是 companion 自己的配置（model-default.json，0600），绝不写
  //   ~/.zcode；新会话由手机端在建会后先 setModel 应用。
  const modelDefaultFile = path.join(path.dirname(midFile), 'model-default.json');
  let engineModelCatalog = []; // [{providerId,modelId}] 引擎实测可用
  let engineCatalogAt = 0;

  function readModelDefault() {
    try {
      const v = JSON.parse(fs.readFileSync(modelDefaultFile, 'utf8'));
      if (v && typeof v === 'object' && typeof v.providerId === 'string'
        && typeof v.modelId === 'string' && v.providerId && v.modelId) return v;
    } catch { /* 缺失/损坏视为未设置 */ }
    return null;
  }

  function writeModelDefault(providerId, modelId) {
    const tmp = `${modelDefaultFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providerId, modelId, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, modelDefaultFile);
  }

  // 读 companion_app 导入快照里的模型目录（快照与 CLI companion 共用数据目录）。
  // 结构见 zcode-importer.applyImport；缺失/损坏返回空（不算错误）。
  function readImportedModelCatalog() {
    try {
      const snap = JSON.parse(fs.readFileSync(
        path.join(path.dirname(midFile), 'import-snapshot.json'), 'utf8',));
      const models = snap && snap.categories && snap.categories.models;
      if (!models || typeof models !== 'object') return [];
      const providers = Array.isArray(models.providers) ? models.providers : [];
      return providers.flatMap((p) => (p && Array.isArray(p.modelIds)
        ? p.modelIds.map((m) => ({ providerId: p.id, modelId: m }))
        : []));
    } catch {
      return [];
    }
  }

  // 拉引擎可用目录：单飞 + 60s 缓存（目录基本静态，每请求拉一次太重）。
  // 通道：对活跃会话 resume。无活跃会话（如刚启动）时目录为空并返回
  // imported 作为兜底——手机端 UI 两种来源都展示。
  async function fetchEngineModelCatalog() {
    if (engineModelCatalog.length && Date.now() - engineCatalogAt < 60000) {
      return engineModelCatalog;
    }
    const list = await bridgeRequest({ id: nextLocalId(), method: 'session/list' });
    const sessions = list && list.result && Array.isArray(list.result.sessions)
      ? list.result.sessions : [];
    const active = sessions.find((s) => s && typeof s.sessionId === 'string');
    if (!active) {
      engineModelCatalog = [];
      engineCatalogAt = Date.now();
      return engineModelCatalog;
    }
    const resume = await bridgeRequest({
      id: nextLocalId(), method: 'session/resume',
      params: { sessionId: active.sessionId },
    });
    if (!resume || resume.error) throw safeError('X_MODEL_BRIDGE_DOWN');
    const settings = resume && resume.result && resume.result.settings;
    const available = settings && settings.model && Array.isArray(settings.model.available)
      ? settings.model.available : [];
    engineModelCatalog = available
      .map((e) => e && e.ref ? { providerId: e.ref.providerId, modelId: e.ref.modelId } : null)
      .filter((v) => v && v.providerId && v.modelId);
    engineCatalogAt = Date.now();
    return engineModelCatalog;
  }

  let localIdSeq = 0;
  function nextLocalId() { localIdSeq += 1; return `x-${localIdSeq}`; }
  const localPending = new Map();

  // 经既有桥发一帧并等应答（带 20s 看护；桥死/引擎重启作废时 reject）。
  // respawn 作废路径 resolve(null)：这里统一转成错误，调用方只需处理 reject。
  function bridgeRequest(frame) {
    return new Promise((resolve, reject) => {
      if (!bridge) { reject(safeError('X_MODEL_BRIDGE_DOWN')); return; }
      const timer = setTimeout(() => {
        localPending.delete(frame.id);
        reject(safeError('X_MODEL_TIMEOUT'));
      }, 20000);
      localPending.set(frame.id, { timer,
        resolve: (r) => (r && (r.result !== undefined || r.error !== undefined)
          ? resolve(r)
          : reject(safeError('X_MODEL_BRIDGE_DOWN'))) });
      if (!bridge.write(frame)) {
        clearTimeout(timer); localPending.delete(frame.id);
        reject(safeError('X_MODEL_BRIDGE_DOWN'));
      }
    });
  }

  function feedLocalResponse(frame) {
    const entry = localPending.get(frame.id);
    if (!entry) return false;
    localPending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.resolve(frame);
    return true;
  }

  function validateDir(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.length || rawPath.length > 500) {
      throw safeError('X_BAD_PARAMS');
    }
    const resolved = path.resolve(rawPath);
    let stat;
    try { stat = fs.statSync(resolved); } catch { throw safeError('X_BAD_PARAMS'); }
    if (!stat.isDirectory()) throw safeError('X_BAD_PARAMS');
    return resolved;
  }

  function spawnGit(args, cwdPath) {
    return new Promise((resolve, reject) => {
      // --no-optional-locks：只读查询不与 IDE/其它 git 进程争索引锁
      const child = spawn('git', ['--no-optional-locks', '-C', cwdPath, ...args],
        { windowsHide: true });
      let stdout = ''; let stderr = '';
      // 看护：挂住的 hook（post-checkout 卡网等）不能让 x/* 请求永不超时
      // （反向请求两档看护只覆盖 app-server 通道，不覆盖 x/*）
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        reject(Object.assign(new Error('git timed out (10s)'), { code: 'X_GIT_TIMEOUT' }));
      }, 10000).unref();
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(Object.assign(new Error(stderr.trim().split('\n')[0] || `git exit ${code}`), { code: 'X_GIT_FAILED' }));
      });
    });
  }

  async function handleXMethod(frame) {
    const reply = (payload) => send({ type: 'data', payload: payload });
    log('x-method', frame.method);
    try {
      switch (frame.method) {
        case 'x/git/status': {
          const dir = validateDir(frame.params && frame.params.path);
          const out = await spawnGit(['status', '--porcelain=v1', '-b'], dir);
          // 首行完整形状 `## <branch>...[<upstream>][ [ahead N, behind M]]`；
          // 无 upstream 退化为 `## <branch>`，detached 为 `## HEAD (no branch)`。
          // 必须先剥 `...tracking` 段再剥 `[ahead/behind]`——只剥后缀会把
          // upstream 带进分支名（本仓库实测踩坑：`feat/x...origin/feat/x`）。
          const lines = out.split('\n').filter((l) => l.length);
          const head = lines[0] || '';
          let branch = head.startsWith('## ') ? head.slice(3) : '';
          branch = branch.split('...')[0].replace(/\s*\[.*\]$/, '').trim();
          reply({ id: frame.id, result: { branch: branch === 'HEAD (no branch)' ? '' : branch, dirty: Math.max(0, lines.length - 1) } });
          return;
        }
        case 'x/git/branches': {
          const dir = validateDir(frame.params && frame.params.path);
          const out = await spawnGit(['for-each-ref', 'refs/heads',
            '--format=%(refname:short)%09%(HEAD)'], dir);
          const branches = out.split('\n').filter((l) => l.length).map((line) => {
            const idx = line.lastIndexOf('\t');
            return { name: line.slice(0, idx), current: line.slice(idx + 1) === '*' };
          });
          reply({ id: frame.id, result: { branches } });
          return;
        }
        case 'x/git/checkout': {
          const params = frame.params || {};
          const dir = validateDir(params.path);
          const branch = params.branch;
          if (typeof branch !== 'string' || !branchAllowed(branch)) {
            throw safeError('X_BAD_PARAMS');
          }
          // 注意不能加 `--` 分隔符：checkout 语义里 `--` 之后一律按 pathspec
          // 处理（`git checkout -- dev` 变成恢复路径 dev 的文件而非切分支）。
          // 选项注入已由 branchAllowed 白名单挡住（禁止前导 -）。
          const args = ['checkout', ...(params.create === true ? ['-b'] : []), branch];
          await spawnGit(args, dir);
          reply({ id: frame.id, result: { ok: true, branch } });
          return;
        }
        case 'x/fs/exists': {
          const paths = frame.params && frame.params.paths;
          if (!Array.isArray(paths) || paths.length > 50) throw safeError('X_BAD_PARAMS');
          reply({ id: frame.id, result: {
            exists: paths.map((p) => {
              try { return fs.statSync(path.resolve(String(p))).isDirectory(); } catch { return false; }
            }),
          } });
          return;
        }
        case 'x/model/catalog': {
          // 可用目录：引擎实测（settings.model.available，唯一可信源）+
          // 导入快照补充（标记 imported，未经引擎证实可用性）
          let engine = [];
          let degraded = false;
          try {
            engine = await fetchEngineModelCatalog();
          } catch {
            degraded = true; // 桥未起/未登录：仍返回导入目录，UI 提示降级
          }
          const imported = readImportedModelCatalog();
          const engineKeys = new Set(engine.map((m) => `${m.providerId}/${m.modelId}`));
          const models = [
            ...engine.map((m) => ({ ...m, available: true, source: 'engine' })),
            ...imported
              .filter((m) => !engineKeys.has(`${m.providerId}/${m.modelId}`))
              .map((m) => ({ ...m, available: false, source: 'imported' })),
          ];
          const def = readModelDefault();
          reply({ id: frame.id, result: {
            models,
            default: def ? { providerId: def.providerId, modelId: def.modelId } : null,
            degraded,
          } });
          return;
        }
        case 'x/model/configure': {
          const p = frame.params || {};
          if (typeof p.providerId !== 'string' || typeof p.modelId !== 'string'
            || !p.providerId || !p.modelId
            || /[/\s]/.test(p.providerId) || /[/\s]/.test(p.modelId)) {
            throw safeError('X_BAD_PARAMS');
          }
          writeModelDefault(p.providerId, p.modelId);
          // 对活跃会话即时生效：setModel 失败不回滚默认值（新会话仍会应用），
          // 如实返回 appliedToActive 供 UI 提示
          let appliedToActive = false;
          try {
            const list = await bridgeRequest({ id: nextLocalId(), method: 'session/list' });
            const sessions = list && list.result && Array.isArray(list.result.sessions)
              ? list.result.sessions : [];
            const active = sessions.find((s) => s && typeof s.sessionId === 'string');
            if (active) {
              const r = await bridgeRequest({
                id: nextLocalId(), method: 'session/setModel',
                params: { sessionId: active.sessionId,
                  model: { providerId: p.providerId, modelId: p.modelId } },
              });
              appliedToActive = Boolean(r && !r.error);
            }
          } catch { /* 桥不可用：默认值已落盘，新会话会应用 */ }
          reply({ id: frame.id, result: {
            ok: true, appliedToActive,
            default: { providerId: p.providerId, modelId: p.modelId },
          } });
          return;
        }
        case 'x/extensions/list': {
          // 导入快照的扩展摘要（只读）；快照缺失时如实返回 empty 而非报错
          let summary = null;
          let importedAt = null;
          try {
            const snap = JSON.parse(fs.readFileSync(
              path.join(path.dirname(midFile), 'import-snapshot.json'), 'utf8',));
            summary = snap && snap.categories && snap.categories.extensions;
            importedAt = snap && snap.importedAt || null;
          } catch { /* 未导入 */ }
          reply({ id: frame.id, result: {
            skills: summary && Array.isArray(summary.skills) ? summary.skills : [],
            plugins: summary && Array.isArray(summary.plugins) ? summary.plugins : [],
            commands: summary && Array.isArray(summary.commands) ? summary.commands : [],
            mcpCount: summary && typeof summary.mcpCount === 'number' ? summary.mcpCount : 0,
            importedAt,
          } });
          return;
        }
        default:
          reply({ id: frame.id, error: { code: ERR_UNHANDLED, message: `companion 未实现该扩展方法: ${frame.method}` } });
      }
    } catch (err) {
      const reason = err.code || '';
      const code = reason === 'X_BAD_PARAMS' ? ERR_X_BAD_PARAMS
        : reason === 'X_GIT_TIMEOUT' ? ERR_X_GIT_TIMEOUT
        : reason === 'X_MODEL_TIMEOUT' ? ERR_TIMEOUT
        : ERR_X_GIT_FAILED;
      reply({ id: frame.id, error: { code, message: String(err.message || err), data: { reason: reason || 'X_GIT_FAILED' } } });
    }
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
    // 自发保活看护：单向死亡链路（NAT/热点切换）下 relay 的 ping 未必到达
    // 我们，ws 却长期 OPEN、出站无限堆积。30s 自发 ping，60s 无任何入站
    // （pong/其他帧）即主动 terminate 走统一重连。（间隔可注入供测试）
    let lastInboundAt = Date.now();
    clearInterval(linkWatchTimer);
    linkWatchTimer = setInterval(() => {
      const cur = ws;
      if (!cur) return;
      if (Date.now() - lastInboundAt > linkStaleMs) {
        log('link-stale-terminate', '');
        cur.terminate();
        return;
      }
      try { cur.ping(); } catch { /* close 兜底重连 */ }
    }, linkPingMs).unref();
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
    ws.on('pong', () => { lastInboundAt = Date.now(); });
    ws.on('close', () => {
      if (ws !== conn) return; // 陈旧连接的迟到 close：不动当前状态
      clearInterval(linkWatchTimer);
      ws = null;
      authStage = 'idle';
      matchedUp = false;
      reattaching = false;
      // relay 断开（重部署/闪断）时桥通常仍在：对未应答的反向请求立即代答 -32022，
      // 维持"每个转发的反向请求最终必有应答"的不变量，避免桌面回合中途无限挂起。
      let answered = 0;
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        if (bridge && bridge.write({ id, error: { code: ERR_TIMEOUT, message: 'Client request timed out' } })) answered++;
      }
      pending.clear();
      // 观测：代答了几条（0 条不打）。app-server 侧由此可对上「谁被拒绝」。
      if (answered > 0) log('relay-closed-answer-pending', `count=${answered}`);
      onStateChange('disconnected');
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs).unref();
      }
    });
    ws.on('message', (raw, binary) => {
      if (ws !== conn) return; // 关闭握手期间或已换代：丢弃迟到帧
      if (binary) return;
      lastInboundAt = Date.now();
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
        if (authStage !== 'challenged' || !['matched', 'waiting'].includes(msg.pair_status)) {
          // 形状非法却只 return 会留下「relay 已记 device 认证、本端卡在
          // challenged 忽略一切 data」的僵尸链路——与 register_ack/challenge
          // 同口径关连接重连。
          conn.close(); return;
        }
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
        if (!['matched', 'waiting'].includes(msg.pair_status)) { conn.close(); return; }
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
    clearInterval(linkWatchTimer);
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

module.exports = { createCompanion, AppServerBridge, readModelAuth, derivePairingUrl, defaultZcodeCommand,
  resolveZcodeRuntime, runtimeProcessEnv, runRuntimeCommand, probeAppServer, probeZcodeRuntime,
  readRegistrationSecretFile };
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
