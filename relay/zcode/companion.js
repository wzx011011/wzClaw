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
const { MAX_PAYLOAD } = require('./lib/constants');
const { deriveProof, deriveRegisterProof } = require('./lib/proof');
const { ERR_UNHANDLED, ERR_FRAME_TOO_LARGE, ERR_TIMEOUT, ERR_X_BAD_PARAMS,
  ERR_X_GIT_TIMEOUT, ERR_X_GIT_FAILED, ERR_X_NOT_FOUND, ERR_X_FAILED,
  isFastMethod } = require('./lib/protocol');
const { resolveCompanionStatePaths } = require('./lib/state-path');
const { resolveZcodeRuntime: resolveRuntime, publicRuntimeDescriptor } = require('./lib/runtime-resolver');
const { PLAN_PROVIDER_ID, PLAN_DISPLAY_MODEL_IDS, PLAN_DISPLAY_PROVIDER_NAME,
  buildPlanOverlay, defaultPersonalConfigPath, writePlanOverlay } = require('./lib/plan-overlay');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeError = (code) => Object.assign(new Error(code), { code });

// 单条 app-server NDJSON 不能无限积累。上限必须高于 relay 1MiB：companion 会先
// 收到并截断大型 session/resume（实测可达约 26MiB）再走 relay；32MiB 允许这条
// 正常恢复路径，同时阻止无换行坏流吃尽常驻进程内存。
const MAX_NDJSON_BUFFER = 32 * 1024 * 1024;

// 已验证 runtime 协议基线（架构审查 P2-8 版本锁）：预检只接受这些前缀的
// 版本。0.16.9 全量接口面实测（probe-surface-0169）钉在 0.16 线上；官方
// 升级后必须先跑全量探针复核契约，再把新前缀加进来——预检对未知版本
// 显式 unsupported-version，不做「能启动就算兼容」的假设。
const SUPPORTED_RUNTIME_PREFIXES = ['0.16.'];

// ---- 官方开源协议契约层（third_party/zcode，Apache-2.0，vendor bundle）----
// 方法名/通知表/错误码/帧校验 schema 一律以 vendor/zcode-protocol.cjs 为唯一
// 事实源（scripts/build-zcode-protocol.mjs 从官方源码构建，升级流程见其头注）；
// 此前的手写字符串常量与探测猜测全部废弃。
const zc = require('./vendor/zcode-protocol.cjs');
const OFFICIAL_METHODS = zc.zcodeProtocolMethods;
// 官方 host 控制面通知词汇表（zcodeProtocolNotifications）：存储握手/MCP 遥测/
// 资源采样等进程级控制面通知是引擎→宿主域，不是会话事件流——不向手机转发
// （手机端无从消费，转发即噪音），留观测计数。
const HOST_CONTROL_NOTIFICATIONS = new Set(Object.values(zc.zcodeProtocolNotifications));

// 运行时偏好的宿主代答值：形状由官方 result schema（strict）钉死——关闭搜索
// 增强与记忆，AskUser 自动裁决与 modelContextBudgetStrategy 取官方默认。
// 此前只答单字段靠引擎侧 zod default 兜底；现在经同一 schema parse 出规范全量。
const RUNTIME_PREFERENCES_METHOD = OFFICIAL_METHODS.sessionRequestRuntimePreferences;
const RUNTIME_PREFERENCES_RESULT =
  zc.zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });

// companion 本地代答的反向请求白名单（官方源码语义 + probe-surface-0169 /
// probe-storagestate 实测双锚定）：
// - session/requestRuntimePreferences：官方 result schema 钉形（见上）；
// - startup/storageState / process/mcpTelemetry：官方形态是通知
//   （zcodeProtocolNotifications 表，engine→host 推进度、不等应答）；0.16.9
//   引擎实测以带 id 请求形态发（答与不答 create 均完整）——对请求形态保留
//   幂等空答（官方 zcodeProtocolEmptyResultSchema 同形）防 120s 看护堆积，
//   通知形态由 HOST_CONTROL_NOTIFICATIONS 观测消化。
const LOCALLY_ANSWERED_REVERSE = {
  [RUNTIME_PREFERENCES_METHOD]: RUNTIME_PREFERENCES_RESULT,
  [zc.zcodeProtocolNotifications.storageStartup]:
    zc.zcodeProtocolEmptyResultSchema.parse({}),
  [zc.zcodeProtocolNotifications.mcpTelemetry]:
    zc.zcodeProtocolEmptyResultSchema.parse({}),
};

// 默认解析本机 ZCode 安装（可被 options.zcodeCommand 覆盖，测试注入假进程用）。
// 必须与 runtime 预检复用同一解析结果，否则预检与长期 bridge 的运行时宿主可能不一致。
function defaultZcodeCommand(env = process.env, opts = {}) {
  const resolved = resolveZcodeRuntime(env, opts);
  if (resolved.category === 'resolved') return { command: resolved.command, args: resolved.args };
  return { command: 'zcode', args: [] };
}

// 运行时预检只产生脱敏的状态码，绝不向调用者返回命令行、token 或原始 stderr。
// opts 直通 lib 的注入参数（fsApi/platform 等）：官方安装探测按设计仅认
// win32 布局，测试必须显式钉 platform 才能在任意宿主上复现 win32 分支。
function resolveZcodeRuntime(env = process.env, opts = {}) {
  return resolveRuntime({ env, ...opts });
}

// 引擎自举套餐配置发现（2026-09-20 EXIT_1 事故修复）：ZCode 桌面端会把
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 注入其子进程——companion 从桌面启动时
// 靠继承就能启动引擎；但从 Explorer/计划任务等干净环境启动时没有该变量，
// 引擎在默认路径找不到 zcode-builtin.json 直接退 1（GUI 预检 EXIT_1 根因）。
// 此处在 env 无该变量时自动发现桌面端生成的最新 endpoint 配置并注入。
function discoverBuiltinProviderConfig(env = process.env) {
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return null; // 已有：交给继承值
  try {
    const root = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider',
      'windows-x86_64');
    let best = null; let bestMtime = -1;
    for (const versionDir of fs.readdirSync(root)) {
      const versionPath = path.join(root, versionDir);
      try { if (!fs.statSync(versionPath).isDirectory()) continue; } catch { continue; }
      for (const endpointDir of fs.readdirSync(versionPath)) {
        if (!endpointDir.startsWith('endpoint-')) continue;
        const candidate = path.join(versionPath, endpointDir, 'zcode-builtin.json');
        try {
          if (!fs.statSync(candidate).isFile()) continue;
          const mtime = fs.statSync(candidate).mtimeMs;
          if (mtime > bestMtime) { bestMtime = mtime; best = candidate; }
        } catch { /* 单个候选不可读：跳过 */ }
      }
    }
    return best;
  } catch { return null; }
}

function runtimeProcessEnv(resolved, env = process.env) {
  // Electron host（包括独立安装的 ZCode.exe）执行 cjs runtime 时必须切 Node 模式；
  // 直接 PATH CLI 与其他可执行文件参数均不携带该变量。
  const runtimeScript = resolved.args[0];
  const runsCjsRuntime = typeof runtimeScript === 'string' && runtimeScript.toLowerCase().endsWith('.cjs');
  // 剥离宿主进程注入的 Chromium/Electron 内部变量（ELECTRON-spawns-ELECTRON
  // 时的 crashpad 管道等串扰）；ZCODE_* 必须保留——桌面端会为子进程设置
  // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 等必需配置，剥掉会让 runtime 因
  // 「无法定位 Built-in Provider Config」直接退 1（2026-09-17 实测矩阵）。
  const sanitized = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(CHROME_|ELECTRON_)/i.test(key)) continue;
    sanitized[key] = value;
  }
  // 套餐配置发现（见 discoverBuiltinProviderConfig）：继承缺失时注入最新配置
  const discoveredBuiltin = discoverBuiltinProviderConfig(env);
  return {
    ...sanitized,
    ...(runsCjsRuntime && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(discoveredBuiltin ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: discoveredBuiltin } : {}),
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
    let stderrTail = ''; let stdoutTail = '';
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child) try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.kill(); } catch { /* 已退出 */ }
      // 失败时附两端输出尾部（限长、压成单行）供本地 GUI 日志归因；
      // 官方 CLI 的崩溃输出是路径/异常文本，不含凭据（token 不落 stdio）。
      if (!result.ok) {
        const tail = `${stderrTail}\n[out] ${stdoutTail}`.replace(/\s+/g, ' ').trim();
        if (tail) result.stderrTail = tail.slice(-300);
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs).unref();
    try {
      child = spawn(resolved.command, [...resolved.args, 'app-server', '--cwd', cwd], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true,
        env: runtimeProcessEnv(resolved, env),
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdoutTail = (stdoutTail + chunk).slice(-4096); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-4096);
      });
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
          } else if (frame.id === 1) {
            return Array.isArray(frame.result?.sessions)
              ? finish({ ok: true })
              : finish({ ok: false, code: frame.error ? 'APP_SERVER_ERROR' : 'BAD_RESPONSE' });
          }
        }
      });
      child.on('error', (error) => finish({ ok: false, code: error.code || 'SPAWN_ERROR' }));
      child.on('exit', (code) => finish({ ok: false, code: `EXIT_${code ?? 'UNKNOWN'}` }));
      child.stdin.on('error', () => finish({ ok: false, code: 'WRITE_FAILED' }));
      child.stdin.write('{"id":1,"method":"session/list","params":{}}\n');
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
  // 版本锁（架构审查 P2-8）：健康探针只能证明可启动，不能证明协议兼容——
  // 未知前缀显式拒绝，要求先跑探针复核并更新基线
  if (!SUPPORTED_RUNTIME_PREFIXES.some((prefix) => versionText.startsWith(prefix))) {
    return { category: 'unsupported-version', source: resolved.source, version: versionText, detailCode: 'BASELINE_MISMATCH' };
  }
  const doctor = await runRuntimeCommand(resolved, ['doctor'], { timeoutMs: 10000, env });
  if (!doctor.ok) {
    return { category: 'doctor-failed', source: resolved.source, version: versionText,
      detailCode: doctor.code, doctorWarning: null };
  }
  let token;
  try { token = readModelAuth(v2ConfigPath || path.join(os.homedir(), '.zcode/v2/config.json')); }
  catch (error) { return { category: error.code === 'NOT_LOGGED_IN' ? 'not-logged-in' : 'auth-store-unreadable', source: resolved.source, version: versionText, detailCode: error.code, doctorWarning: doctor.ok ? null : doctor.code }; }
  // app-server 探针失败可能是偶发（子进程启动竞态/与桌面引擎的资源瞬时冲突，
  // 2026-09-17 GUI 实测同环境时通时断）：短间隔重试，偏向「多等」而非一票否决。
  // 探针失败只延迟 descriptor 就绪（设备保持在线），最坏 6×2.5s≈15s 后如实上报。
  let probe = null; let attempt = 0; const maxAttempts = 6;
  for (;;) {
    attempt += 1;
    probe = await probeAppServer(resolved, {
      cwd,
      env: { ...env, ANTHROPIC_API_KEY: token },
    });
    if (probe.ok || attempt >= maxAttempts) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500).unref());
  }
  if (probe.attempts === undefined) probe.attempts = attempt;
  return probe.ok
    ? { category: 'ready', source: resolved.source, version: versionText, detailCode: null,
        doctorWarning: doctor.ok ? null : doctor.code,
        // 预检成功后把同一解析结果绑定给长期 bridge，避免两次解析跨更新/环境变化。
        runtimeDescriptor: publicRuntimeDescriptor(resolved) }
    : { category: probe.code === 'TIMEOUT' ? 'app-server-timeout' : 'app-server-failed',
        source: resolved.source, version: versionText, detailCode: probe.code,
        doctorWarning: doctor.ok ? null : doctor.code,
        // 归因观测透传（2026-09-20）：此前 stderrTail 在此被丢弃，
        // GUI 日志只剩裸 EXIT_1，无法区分「秒退零输出」与「跑后自退」
        ...(probe.stderrTail ? { stderrTail: probe.stderrTail } : {}) };
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
    restartWindowMs = 5 * 60 * 1000, stableAliveMs = 60 * 1000 }) {
    this.command = command; this.args = args; this.cwd = cwd;
    // env 支持工厂函数（审查 P2-7）：每次 spawn 现读认证与套餐 overlay，
    // respawn 不再复用构造期快照（「认证存储更新后重启仍用旧值」缺陷）
    this.envProvider = typeof env === 'function' ? env : () => env;
    this.logger = logger || (() => {});
    this.maxRestarts = maxRestarts; this.restartDelayMs = restartDelayMs;
    // 预算按时间滑窗计（默认 5 分钟 5 次）：固定计数 + 每帧重置预算会被
    // 「崩溃循环 + 持续手机流量」打成约 1 次/秒的无限快拉。
    this.restartWindowMs = restartWindowMs; this.restartTimes = [];
    // 稳定运行证据阈值（审查 P2-7）：本代存活满阈值后死亡视为偶发而非
    // 崩溃循环，预算清零重新起算——替代旧「每帧写入成功即清预算」（那会
    // 被「崩溃循环 + 持续手机流量」打成约 1 次/秒的无限快拉）
    this.stableAliveMs = stableAliveMs; this.spawnedAt = 0;
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
    // detached：Electron 壳（GUI）父进程下，非 detached 的子 runtime 会出现
    // stdio 黑洞——进程活着但不吐任何帧（2026-09-17 实测 session/list 35s
    // 超时、gate 预检静默 EXIT_1）；detached 给子进程独立进程组后消失。
    // node CLI 父进程下该标志无副作用。宿主 GUI 关闭时 stop() 会显式杀子进程。
    const env = this.envProvider();
    if (!env) {
      // 认证环境暂不可读（桌面正在重写 config 等）：定延迟重试，不计入
      // 崩溃预算——这不是引擎故障，烧预算会让可恢复的认证空窗变 dead
      this.logger('appserver-env-missing', '');
      setTimeout(() => { if (!this.stopped && this.child === null) this.spawnChild(); },
        this.restartDelayMs).unref();
      return;
    }
    const child = spawn(this.command, [...this.args, 'app-server', '--cwd', this.cwd], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: true, windowsHide: true,
    });
    this.child = child; this.buffer = ''; this.spawnedAt = Date.now();
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
      // 稳定运行证据：存活满阈值后死亡是偶发（引擎升级/机器休眠等），
      // 清空崩溃预算重新起算
      const aliveMs = this.spawnedAt > 0 ? Date.now() - this.spawnedAt : 0;
      if (aliveMs >= this.stableAliveMs) {
        this.restartTimes = [];
        this.logger('appserver-stable-run', `aliveMs=${aliveMs}`);
      }
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
    // 受管 runtime（GUI 门禁）：relay 在线与 runtime 健康解耦——设备先注册
    // 上线（引擎未就绪时 paired-no-model），预检成功后经 setRuntimeDescriptor
    // 热注入并起桥。CLI 模式（默认）维持 zcodeCommand/本机即时解析。
    runtimeManaged = false,
    stateDir, midFile, snapshotPath,
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
    bridgeStableAliveMs = 60 * 1000,
    // 宿主活动钩子（可选，2026-09-21 桌面宠物集成）：把「值得通知的事」
    // 投给宿主 UI（需要确认/需要回答/回答摘要/已处理），内容逻辑与手机端
    // 通知一致。纯只读观测，回调异常被吞掉，绝不影响桥的转发与应答。
    onActivity = null,
  } = options;
  if (typeof relayUrl !== 'string' || !/^wss?:\/\/.+\/ws$/.test(relayUrl)) throw safeError('INVALID_RELAY_URL');
  if (registrationSecret !== undefined && (typeof registrationSecret !== 'string' || !registrationSecret.length)) {
    throw safeError('INVALID_REGISTRATION_SECRET');
  }

  const statePaths = resolveCompanionStatePaths({ stateDir, midFile, snapshotPath });

  let stopped = false;
  let ws = null;
  let bridge = null;
  let bridgeStarted = false;
  let bridgeDead = false; // 重启预算耗尽后为真,直到下一次成功起桥
  // 受管 runtime 的已验证 descriptor（setRuntimeDescriptor 注入）：
  // null = 预检未完成，起桥需等待。
  let managedDescriptor = null;
  let pairing = null; // { sid, passHash, url }
  let authStage = 'idle'; // idle → registered → challenged → authenticated
  let reconnectTimer = null;
  let linkWatchTimer = null;
  let bridgeDeadAt = 0;
  // 上次注册成功的凭据；重连时优先用它接管原房间（sid 不变，手机端配对不失效）。
  let creds = null;
  let reattaching = false;
  let matchedUp = false; // 房间当前是否手机+设备齐全（决定 app-server 出站是否放行）
  // 反向请求 wireId 代次化（2026-09-19 评审修复）：app-server 子进程重启后
  // server-N id 从头复用，直接透传原生 id 会让旧进程请求的迟到应答命中
  // 新进程同 id 的新请求（=一次未经确认的批准）。每次引擎（重）启递增
  // 代次，对外发全局唯一 wireId，应答按映射还原回原生 id。
  let bridgeGeneration = 0;
  let nextReverseWireId = 0;
  // wireId → { timer, nativeId, gen }：反向请求超时看护 + 应答还原映射
  // （按 method 分档，见 handleAppServerFrame）
  // wireId → { timer, nativeId, gen, requestId }：反向请求超时看护 + 应答
  // 还原映射。requestId = 官方交互业务身份——同一交互的重宣告共享它，
  // 应答/超时后兄弟 wireId 一并清理，防止幽灵 -32022 打到引擎已 settle
  // 的请求上（pendingRequestGroups：requestId → wireId 集合）。
  const pending = new Map();
  const pendingRequestGroups = new Map();

  function dropRequestEntry(wireId) {
    const entry = pending.get(wireId);
    if (!entry) return;
    pending.delete(wireId);
    clearTimeout(entry.timer);
    if (entry.requestId) {
      const group = pendingRequestGroups.get(entry.requestId);
      if (group) {
        group.delete(wireId);
        if (!group.size) pendingRequestGroups.delete(entry.requestId);
      }
    }
  }

  // 清除同一业务交互的兄弟 wireId（已应答/已超时后，其余宣告不再看护）
  function dropSiblingWireIds(requestId, keepWireId) {
    if (!requestId) return;
    const group = pendingRequestGroups.get(requestId);
    if (!group) return;
    for (const wireId of [...group]) {
      if (wireId === keepWireId) continue;
      dropRequestEntry(wireId);
    }
  }

  // 分组显示名：个人配置里各 provider 的 providerName（Claude CLI/BigModel/
  // Codex/DeepSeek），目录透传给手机端做层级分组；缺失时手机端回退 providerId。
  let providerNameMap = {};
  try {
    const base = JSON.parse(fs.readFileSync(defaultPersonalConfigPath(), 'utf8'));
    for (const rule of ((base.config || {}).providerConfigRules || {}).providerRules || []) {
      if (rule && typeof rule.providerId === 'string' && typeof rule.providerName === 'string') {
        providerNameMap[rule.providerId] = rule.providerName;
      }
    }
  } catch { /* 基础配置缺失：回退 providerId 显示 */ }

  // 手机附件分块上传会话表（x/file/*）：uploadId → {tmpPath,finalPath,
  // size,received,createdAt}。30 分钟过期清理——中断的上传不留永久临时文件
  const fileUploads = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [id, up] of fileUploads) {
      if (now - up.createdAt > 30 * 60 * 1000) {
        fileUploads.delete(id);
        try { fs.unlinkSync(up.tmpPath); } catch { /* best effort */ }
      }
    }
  }, 5 * 60 * 1000).unref();

  // 手机文件下载会话表（x/file/download/*）：downloadId → {fd,absPath,size,
  // createdAt}。begin 时以 realpath 校验包含关系并打开固定句柄（评审 #20：
  // 字面路径校验可被 symlink/junction 绕过；固定 fd 还保证传输期间目标被
  // 替换不影响本次一致性）；chunk 只认 id 从 fd 读；eof/abort/过期/stop
  // 统一关句柄——中断的下载不留悬挂会话与句柄。
  const DOWNLOAD_CHUNK_BYTES = 256 * 1024; // base64 后 ~349KB，低于 relay 1MB 帧限
  const fileDownloads = new Map();
  function closeDownload(downloadId) {
    const dl = fileDownloads.get(downloadId);
    if (!dl) return;
    fileDownloads.delete(downloadId);
    if (dl.fd != null) { try { fs.closeSync(dl.fd); } catch { /* best effort */ } }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [id, dl] of fileDownloads) {
      if (now - dl.createdAt > 30 * 60 * 1000) closeDownload(id);
    }
  }, 5 * 60 * 1000).unref();

  function log(event, detail) { logger(event, detail); }

  // ---- 宿主活动投影（onActivity 可选）----
  // 只观察两类流：① engine→手机的反向请求（权限/提问 = 「需要你处理」）；
  // ② session/event 文本流的头部累计（turn.terminal 时给出回答摘要）。
  // 与手机端通知同内容逻辑；宿主不传 onActivity 时零开销零行为变化。
  const emitActivity = (kind, title) => {
    if (typeof onActivity !== 'function') return;
    try { onActivity({ kind, title }); } catch { /* 宿主回调异常不影响桥 */ }
  };

  // 回答头部累计器：sessionId → 已累计文本（截到 400 字符，摘要取开头）。
  // turn.terminal 后清空；error/中断同样由 terminal 兜底清理。
  const answerHeads = new Map();
  function trackSessionEventActivity(params) {
    if (!isObject(params) || typeof params.sessionId !== 'string') return;
    const sessionId = params.sessionId;
    const events = Array.isArray(params.events) ? params.events : [];
    for (const event of events) {
      const payload = isObject(event) ? event.payload : null;
      const kind = payload ? payload.kind : null;
      if (kind === 'text_delta' && typeof payload.delta === 'string') {
        const current = answerHeads.get(sessionId) || '';
        if (current.length < 400) {
          answerHeads.set(sessionId, (current + payload.delta).slice(0, 400));
        }
      } else if (kind === 'turn.terminal') {
        const head = (answerHeads.get(sessionId) || '').trim();
        answerHeads.delete(sessionId);
        if (head) emitActivity('answer', head.slice(0, 140));
      }
    }
  }


  function ensureMid() {
    fs.mkdirSync(statePaths.stateDir, { recursive: true });
    try { return fs.readFileSync(statePaths.midFile, 'utf8').trim(); } catch { /* 首次运行 */ }
    const mid = `companion-${randomBytes(16).toString('hex')}`;
    fs.writeFileSync(statePaths.midFile, mid, { mode: 0o600 });
    return mid;
  }
  const mid = ensureMid();

  // 注册口令持久化（与 mid 同目录）：配合 relay 的确定性 sid（由 pass_hash+mid 派生），
  // 进程重启/开机自启动/掉线重连都得到同一配对码，手机端无需重扫。
  function ensurePassHash() {
    fs.mkdirSync(statePaths.stateDir, { recursive: true });
    try {
      const saved = fs.readFileSync(statePaths.passHashFile, 'utf8').trim();
      if (/^[A-Za-z0-9+/]{43}=$/.test(saved)) return saved;
    } catch { /* 首次运行 */ }
    const generated = randomBytes(32).toString('base64');
    fs.writeFileSync(statePaths.passHashFile, generated, { mode: 0o600 });
    return generated;
  }
  const passHash = ensurePassHash();

  // 单实例锁（与 mid 同目录）：自启动实例与手动实例并存会互踢（同 mid+口令
  // 派生同一房间，注册互为 owner 接管）。持锁进程死亡后锁可被新实例接管。
  const lockFile = statePaths.lockFile;
  const isPidAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  (function acquireInstanceLock() {
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10); } catch { /* 首次运行 */ }
    // 同进程的第二个实例 pid 相同，同样视为已持有锁（stop() 会删锁，正常重取不受影响）
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) {
      throw safeError('ALREADY_RUNNING');
    }
    // 原子获取（审查 P2 其他确认项）：O_EXCL 语义下 create 为独占步骤——
    // 两个实例同时通过「读 pid→写文件」的旧竞态窗口（双 PID 交错均可成功）
    // 在此被文件系统原子性挡住；EEXIST 时重读 pid 复核（陈旧锁接管路径）
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // EEXIST：锁文件存在但读到的 pid 已死（陈旧锁）——接管：删后重走原子创建
    if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) {
      try { fs.unlinkSync(lockFile); } catch { /* 并发接管者已删 */ }
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (error2) {
        if (error2.code === 'EEXIST') throw safeError('ALREADY_RUNNING');
        throw error2;
      }
    }
    // 锁在且持有者活着（含本进程重复启动）
    throw safeError('ALREADY_RUNNING');
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
    // 受管 runtime：descriptor 未就绪（预检未完成/失败）时不起桥，设备保持
    // 在线（paired-no-model），稍后 setRuntimeDescriptor 热启；CLI 模式维持
    // 即时解析（zcodeCommand 注入或本机默认解析）。
    const resolved = runtimeManaged ? managedDescriptor
      : (zcodeCommand || defaultZcodeCommand());
    if (runtimeManaged && !resolved) {
      log('bridge-waiting-runtime', '');
      return;
    }
    // 桥环境工厂（审查 P2-7）：每次 spawn 现读认证与套餐 overlay——respawn
    // 复用构造期快照会让「认证存储更新后重启仍用旧值」。读失败复用上一份
    // 好环境（瞬时写窗/未登录不空转）；从未成功返回 null（保持原「不置位
    // bridgeStarted，下次手机帧重试」语义）。
    let lastGoodBridgeEnv = null;
    const buildBridgeEnv = () => {
      try {
        const freshToken = readModelAuth(v2ConfigPath || path.join(os.homedir(), '.zcode/v2/config.json'));
        let planEnv = null;
        // 模型目录 overlay（2026-09-21 改版）：注入与桌面「BigModel 个人」组
        // 同名同款的三模型（见 lib/plan-overlay.js 头注）。构建只依赖本地
        // base 配置 + 登录态 token，无网络拉取——旧「先拉 API 再 spawn」的
        // 冷启动竞态（手机先到 → 引擎裸跑 → 目录缺套餐模型）从根上消除。
        // base 缺失/损坏只丢套餐组，不阻塞起桥。
        try {
          const baseRaw = fs.readFileSync(defaultPersonalConfigPath(), 'utf8');
          planEnv = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: writePlanOverlay({
            overlay: buildPlanOverlay({
              baseRaw,
              modelIds: [...PLAN_DISPLAY_MODEL_IDS],
              token: freshToken,
              providerName: PLAN_DISPLAY_PROVIDER_NAME,
            }),
            stateDir: statePaths.stateDir,
          }) };
        } catch (error) {
          log('plan-overlay-failed', error.code || '');
        }
        lastGoodBridgeEnv = runtimeProcessEnv(resolved, { ...process.env, ANTHROPIC_API_KEY: freshToken, ...planEnv });
      } catch (error) {
        log('model-auth-missing', error.code);
      }
      return lastGoodBridgeEnv;
    };
    if (!buildBridgeEnv()) return;
    bridgeStarted = true;
    bridgeDead = false;
    bridge = new AppServerBridge({
      command: resolved.command, args: resolved.args, cwd,
      // 统一经 runtimeProcessEnv：Electron 壳内注入 ELECTRON_RUN_AS_NODE（否则
      // spawn 出来的是 Chromium 实例而非 stdio node 子进程），并剥离宿主
      // CHROME_/ELECTRON_ 内部变量（crashpad 管道串扰）。ZCODE_* 必须保留——
      // 桌面端为子进程设置的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 等是必需配置，
      // 剥掉会让 runtime 因「无法定位 Built-in Provider Config」直接退 1
      // （2026-09-17 实测矩阵）。env 传工厂：respawn 现读（见上）。
      env: buildBridgeEnv,
      maxRestarts: bridgeMaxRestarts, restartDelayMs: bridgeRestartDelayMs,
      restartWindowMs: bridgeRestartWindowMs, stableAliveMs: bridgeStableAliveMs,
      logger: (event, detail) => log(event, detail),
      onDead: () => {
        // 重启预算耗尽：记冷却起点，冷却内手机帧不重试；冷却后下一帧整体重试。
        bridge = null; bridgeStarted = false; bridgeDead = true; bridgeDeadAt = Date.now();
        log('bridge-dead', ''); onStateChange('app-server-dead');
      },
    });
    bridge.onFrame = handleAppServerFrame;
    // 新 app-server 进程的 server-N id 从头计数：作废旧 pending（只清定时器，
    // 不代答——旧进程已不在，写了也无人认领），并递增反向请求代次——
    // 旧代次 wireId 的迟到应答由此永远无法命中新进程的请求。
    bridge.onRespawn = () => {
      bridgeGeneration++;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      pendingRequestGroups.clear();
      // 本地扩展请求同样作废（等价语义：旧进程的应答不会再有）
      for (const entry of localPending.values()) { clearTimeout(entry.timer); entry.resolve(null); }
      localPending.clear();
      // 引擎换代必须让手机端知道：relay 链路未断，但新进程已丢失旧进程内的
      // 激活/订阅状态——手机端收到后作废全部会话的物化/订阅/事件水位。
      // 未配对时静默丢弃（sendToPhone 门禁）：手机下次配对自然全新物化。
      sendToPhone({ method: 'x/engine/generation', params: { generation: bridgeGeneration } });
    };
    bridge.start();
    // spawnChild 首发即触发 onRespawn（代次递增 + x/engine/generation 推送，
    // 见桥构造处闭包），这里不再二次递增/二次推送——旧实现每桥发两帧，
    // wireId 代次标记与 payload.generation 短暂不一致（评审 P3-5）。
    log('bridge-started', `generation=${bridgeGeneration}`);
    onStateChange(currentState()); // 桥真实就绪才报 paired（评审 #18）
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
  // 对外 id 一律改写为代次化 wireId（见 pending 声明处注释），应答时还原。
  function handleAppServerFrame(frame) {
    // 本地扩展请求的应答（x/model/* 等经桥请求）：不透传给手机
    if (frame.id != null && !frame.method) {
      if (feedLocalResponse(frame)) return;
      // 引擎 respawn 已作废 localPending（onRespawn 清空），旧进程迟到的
      // x-* 应答若落到底部 sendToPhone 会以孤立响应发给手机——丢弃留观测。
      if (typeof frame.id === 'string' && frame.id.startsWith('x-')) {
        log('local-response-late', String(frame.id));
        return;
      }
    }
    if (frame.method && frame.id != null) {
      if (Object.prototype.hasOwnProperty.call(LOCALLY_ANSWERED_REVERSE, frame.method)) {
        bridge.write({ id: frame.id, result: LOCALLY_ANSWERED_REVERSE[frame.method] });
        return;
      }
      // 活动投影：要转发给手机的交互请求 = 「需要用户处理」
      if (frame.method === OFFICIAL_METHODS.interactionRequestPermission) {
        const toolName = isObject(frame.params) && typeof frame.params.toolName === 'string'
          ? frame.params.toolName : '工具调用';
        emitActivity('confirm', `需要确认：${toolName}`);
      } else if (frame.method === OFFICIAL_METHODS.interactionRequestUserInput) {
        const questions = isObject(frame.params) && Array.isArray(frame.params.questions)
          ? frame.params.questions : [];
        const first = isObject(questions[0]) ? questions[0] : null;
        const text = (first && typeof first.question === 'string' && first.question)
          || (isObject(frame.params) && typeof frame.params.prompt === 'string' && frame.params.prompt)
          || '需要你的回答';
        emitActivity('ask', `需要回答：${text.slice(0, 120)}`);
      }
      const nativeId = frame.id;
      const wireId = `srv-${++nextReverseWireId}@g${bridgeGeneration}`;
      // 官方交互业务身份：同 requestId 的重宣告归入同组（应答/超时后兄弟清理）
      const requestId = isObject(frame.params) && typeof frame.params.requestId === 'string'
        ? frame.params.requestId : null;
      const timeoutMs = isFastMethod(frame.method) ? requestTimeoutMs : permissionRequestTimeoutMs;
      const timer = setTimeout(() => {
        const timedOut = pending.get(wireId);
        if (timedOut && pending.delete(wireId) && bridge) {
          emitActivity('clear', '');
          dropSiblingWireIds(timedOut.requestId, wireId);
          bridge.write({ id: timedOut.nativeId, error: { code: ERR_TIMEOUT, message: 'Client request timed out' } });
        }
      }, timeoutMs).unref();
      // 未决反向请求保存完整载荷与送达状态（审查 P2-6）：手机离席时
      // sendToPhone 被门禁丢弃，但条目留在 pending——手机回席统一补投，
      // 不再让「离席期间产生的权限」无声丢失到 120s 看护超时。
      const entry = { timer, nativeId, gen: bridgeGeneration, delivered: false, requestId, frame: { ...frame, id: wireId } };
      pending.set(wireId, entry);
      if (requestId) {
        const group = pendingRequestGroups.get(requestId) ?? new Set();
        group.add(wireId);
        pendingRequestGroups.set(requestId, group);
      }
      deliverReverse(entry);
      return;
    }
    // 活动投影：session/event 通知流的回答摘要累计（转发不受影响）
    if (onActivity && frame.method === 'session/event' && frame.id == null) {
      trackSessionEventActivity(frame.params);
    }
    // host 控制面通知（官方 zcodeProtocolNotifications 词汇表）：引擎→宿主域
    // 的进程级通知，手机端无从消费，不转发、留观测——与常量注释的承诺一致
    // （0.16.9 实测这些以带 id 请求形态发、已被本地代答；这里是通知形态的防线）
    if (frame.method != null && frame.id == null
      && HOST_CONTROL_NOTIFICATIONS.has(frame.method)) {
      log('host-control-notification', frame.method);
      return;
    }
    sendToPhone(frame);
  }

  // 反向请求送达：手机在席才真正出站；离席时保留未送达标记，回席补投。
  // 只补投「从未送达」的条目——已送达的重复投递会让手机端旧挂起 completer
  // 被拒绝（=向引擎代答拒绝），绝不允许。
  function deliverReverse(entry) {
    if (!matchedUp) return;
    entry.delivered = true;
    sendToPhone(entry.frame);
  }

  // 手机回席：补投全部未送达的未决反向请求（wireId 顺序即产生顺序）
  function flushUndeliveredReverse() {
    for (const entry of pending.values()) {
      if (!entry.delivered) deliverReverse(entry);
    }
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
      const entry = pending.get(frame.id);
      if (!entry) {
        // 迟到/重复应答（已超时代答/进程重启作废/relay 断开代答）：不转发
        // （重复应答是协议错误源），但零观测会变成「手机点了允许却没生效」
        // 的无头案，留日志（只记 id，不含载荷）。
        log('phone-response-late', String(frame.id));
        return;
      }
      // 代次防御：旧代次 wireId 正常已被 onRespawn 清出 pending，这里兜底
      // 拒绝一切非当前代次的应答——绝不让旧批准命中新进程的请求。
      if (entry.gen !== bridgeGeneration) {
        clearTimeout(entry.timer); pending.delete(frame.id);
        log('phone-response-stale-generation', String(frame.id));
        return;
      }
      clearTimeout(entry.timer); pending.delete(frame.id);
      // 已处理（批准/拒绝/回答都算）：宿主活动清除，气泡回落到连接状态；
      // 同一交互的兄弟 wireId（重宣告）一并撤看护，防幽灵 -32022
      emitActivity('clear', '');
      dropSiblingWireIds(entry.requestId, frame.id);
      // 还原引擎原生 id 再转发（对外 wireId 只存在于手机↔companion 段）
      frame = { ...frame, id: entry.nativeId };
    }
    startBridge();
    if (!bridge) {
      // 桥不可用（未登录/spawn 失败/重启预算耗尽/runtime 预检未完成）：
      // 回明确错误而非静默挂起。
      if (frame.method && frame.id != null && matchedUp) {
        const waiting = runtimeManaged && !managedDescriptor;
        send({ type: 'data', payload: { id: frame.id, error: { code: ERR_UNHANDLED, message: waiting
          ? 'companion 引擎预检未完成：设备已在线，稍后自动可用，请稍候重试'
          : 'companion 桥不可用：app-server 未启动或桌面未登录 ZCode' } } });
      }
      return;
    }
    // 不再按「写入成功」清重启预算（审查 P2-7）：那会被崩溃循环期间的
    // 正常手机流量持续重置，预算永远烧不完；预算恢复只能来自
    // stableAliveMs 的稳定运行证据。
    if (!bridge.write(frame) && frame.method && frame.id != null && matchedUp) {
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
  //   available，实测唯一可信目录源）；导入快照（import-snapshot.json，
  //   历史 companion_app 迁入数据，与 CLI companion 共用数据目录）作为目录
  //   补充展示，标记 unavailable=false 待引擎证实。
  // - 默认模型是 companion 自己的配置（model-default.json，0600），绝不写
  //   ~/.zcode；语义对齐官方「选择即全局」：每次选择都更新默认，手机端
  //   建会后 setModel 应用（含 reasoningLevel，imported 模型必填）。
  const modelDefaultFile = statePaths.modelDefaultFile;
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

  function writeModelDefault(providerId, modelId, reasoningLevel) {
    // reasoningLevel：imported 模型 setModel 必填推理档位（0.16.9 实测，
    // 缺失 -32603）；随默认值落盘，应用端建会后 setModel 时携带
    const tmp = `${modelDefaultFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providerId, modelId, ...(reasoningLevel ? { reasoningLevel } : {}), updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, modelDefaultFile);
  }

  // 读导入快照里的模型目录（历史 companion_app 迁入；快照与 CLI companion
  // 共用数据目录）。结构见 zcode-importer.applyImport；缺失/损坏返回空（不算错误）。
  function readImportSnapshot() {
    try {
      const snapshot = JSON.parse(fs.readFileSync(statePaths.snapshotPath, 'utf8'));
      return snapshot && typeof snapshot === 'object' && snapshot.schemaVersion === 1
        ? snapshot : null;
    } catch { return null; }
  }

  function readImportedModelCatalog() {
    try {
      const snap = readImportSnapshot();
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
  // R07：会话有单运行时归属，session/list 首条可能被桌面等其他运行时
  // 持有（resume -32004）——依次尝试后续会话，不能因首条不可访问就判定
  // 整个节点无目录；全部不可访问才降级。
  async function fetchEngineModelCatalog() {
    if (engineModelCatalog.length && Date.now() - engineCatalogAt < 60000) {
      return engineModelCatalog;
    }
    const list = await bridgeRequest({ id: nextLocalId(), method: 'session/list' });
    const sessions = list && list.result && Array.isArray(list.result.sessions)
      ? list.result.sessions : [];
    let sawEngineReply = false;
    for (const s of sessions) {
      if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue;
      let resume = null;
      try {
        resume = await bridgeRequest({
          id: nextLocalId(), method: 'session/resume',
          params: { sessionId: s.sessionId },
        });
      } catch { resume = null; }
      if (!resume || resume.error || !resume.result) {
        sawEngineReply = sawEngineReply || Boolean(resume && resume.error);
        continue;
      }
      sawEngineReply = true;
      const settings = resume.result.settings;
      // settings.model.available 是引擎投影的可用目录（实测权威）。
      // settings.model.current 只证明「该会话当前正用这个模型」，不是可选目录
      // 证据（current 可指向已失效模型），不得并入 available——手机端把
      // current 冒充可选项会让选择打到不可用模型上。
      const available = settings && settings.model && Array.isArray(settings.model.available)
        ? settings.model.available : [];
      if (!available.length) continue;
      // 透传手机端层级弹层所需元数据（label/providerLabel/ctx/视觉/reasoning），
      // 显示名优先级：引擎 providerLabel → 个人配置 providerName → providerId。
      engineModelCatalog = available
        .map((e) => {
          if (!e || !e.ref || typeof e.ref.providerId !== 'string' || !e.ref.providerId
            || typeof e.ref.modelId !== 'string' || !e.ref.modelId) return null;
          return {
            providerId: e.ref.providerId,
            modelId: e.ref.modelId,
            label: typeof e.label === 'string' && e.label ? e.label : e.ref.modelId,
            providerLabel: typeof e.providerLabel === 'string' && e.providerLabel
              ? e.providerLabel : (providerNameMap[e.ref.providerId] || e.ref.providerId),
            contextWindow: Number.isFinite(e.contextWindow) ? e.contextWindow : null,
            maxOutputTokens: Number.isFinite(e.maxOutputTokens) ? e.maxOutputTokens : null,
            vision: Boolean(e.properties && e.properties.inputFormat && e.properties.inputFormat.supportsImage),
            reasoning: (e.reasoning && Array.isArray(e.reasoning.levels))
              ? { levels: e.reasoning.levels, defaultLevel: e.reasoning.defaultLevel ?? null }
              : null,
          };
        })
        .filter(Boolean);
      engineCatalogAt = Date.now();
      return engineModelCatalog;
    }
    if (sawEngineReply) throw safeError('X_MODEL_BRIDGE_DOWN');
    engineModelCatalog = [];
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

  function spawnGit(args, cwdPath, opts = {}) {
    return new Promise((resolve, reject) => {
      // --no-optional-locks：只读查询不与 IDE/其它 git 进程争索引锁
      const child = spawn('git', ['--no-optional-locks', '-C', cwdPath, ...args],
        { windowsHide: true });
      let stdout = ''; let stderr = '';
      // 看护：挂住的 hook（post-checkout 卡网等）不能让 x/* 请求永不超时
      // （反向请求两档看护只覆盖 app-server 通道，不覆盖 x/*）。
      // push 走网络/凭据，默认 10s 不够，允许放宽（交互式凭据提示会
      // 挂到超时——无终端 TTY 时 git 会直接失败，属可接受边界）。
      const timeoutMs = opts.timeoutMs ?? 10000;
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        reject(Object.assign(new Error(`git timed out (${timeoutMs / 1000}s)`), { code: 'X_GIT_TIMEOUT' }));
      }, timeoutMs).unref();
      // 累积上限：巨型 diff（数百 MB 生成物）不设限会吃尽常驻进程内存；
      // 16MiB 远超全部消费方的实际用量（filediff 应答侧只取 128KB 头部）
      const MAX_GIT_STREAM = 16 * 1024 * 1024;
      child.stdout.on('data', (c) => { stdout = (stdout + c).slice(0, MAX_GIT_STREAM); });
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(0, MAX_GIT_STREAM); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else {
          // commit/push 的失败说明常在 stdout（如 nothing to commit），
          // stderr 为空时回落 stdout 首行，避免只剩 "git exit 1"
          const firstLine = (stderr.trim() || stdout.trim()).split('\n')[0];
          reject(Object.assign(
            new Error(firstLine || `git exit ${code}`),
            { code: opts.code ?? 'X_GIT_FAILED', details: (stderr + stdout).trim() },
          ));
        }
      });
    });
  }

  // 工作区根解析（评审 #19）：x/file/* 接受可选 workspacePath（会话自己的
  // 工作区——会话允许任意工作区，附件/下载边界必须跟随会话而非启动目录）。
  // 无论显式还是缺省，一律 realpath 规范化（junction/symlink 一并还原）：
  // 文件侧同样 realpath，两侧同表示比较，工作区根本身是链接时合法文件
  // 不再被误判越界（2026-09-19 评审 P2）。根不可解析宁可报错，绝不静默
  // 回退 cwd。
  function resolveWorkspaceRoot(workspacePath) {
    const raw = workspacePath == null || String(workspacePath).trim() === ''
      ? cwd
      : path.resolve(String(workspacePath).trim());
    try {
      const real = fs.realpathSync(raw);
      if (!fs.statSync(real).isDirectory()) throw new Error('not-a-directory');
      return real;
    } catch {
      throw safeError('X_BAD_PARAMS');
    }
  }

  async function handleXMethod(frame) {
    // x/* 应答与 app-server 应答同受 relay 1MiB 帧上限约束（铁律 4：静默
    // 丢弃=缺陷）。send 超限会静默 return false，手机端 RPC 只能干等自身
    // 超时——这里先测体积，超限显式回 ERR_FRAME_TOO_LARGE 错误帧；其余
    // 发送失败（链路已断/慢链 terminate）由断线重连流程统一善后。
    const reply = (payload) => {
      let json = null;
      try { json = JSON.stringify({ type: 'data', payload }); } catch { /* 不可序列化 */ }
      if (json === null) {
        // 与超限分开报：排查时「序列化失败」与「体积超限」是两类问题
        log('x-reply-unserializable', frame.method);
        send({ type: 'data', payload: { id: frame.id, error: { code: ERR_X_FAILED,
          message: 'x/* 应答不可序列化' } } });
        return;
      }
      if (Buffer.byteLength(json) > MAX_PAYLOAD) {
        log('x-reply-too-large', `${frame.method} bytes=${Buffer.byteLength(json)}`);
        send({ type: 'data', payload: { id: frame.id, error: { code: ERR_FRAME_TOO_LARGE,
          message: 'x/* 应答超出中继帧上限' } } });
        return;
      }
      send({ type: 'data', payload });
    };
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
        case 'x/git/pushinfo': {
          // 提交/推送对话框数据：分支、upstream、领先/落后
          const dir = validateDir(frame.params && frame.params.path);
          const branch = (await spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
          if (!branch || branch === 'HEAD') {
            throw Object.assign(new Error('当前处于 detached HEAD，无法推送'), { code: 'X_FAILED' });
          }
          const remotes = (await spawnGit(['remote'], dir)).split('\n').filter((s) => s.trim());
          const hasRemote = remotes.includes('origin');
          let upstream = '';
          let ahead = 0;
          let behind = 0;
          if (hasRemote) {
            const up = await spawnGit(
              ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir,
            ).catch(() => '');
            upstream = up.trim();
            if (upstream) {
              const cc = await spawnGit(
                ['rev-list', '--left-right', '--count', `${upstream}...${branch}`], dir,
              ).catch(() => '');
              const parts = cc.trim().split(/\s+/);
              behind = Number.parseInt(parts[0], 10) || 0;
              ahead = Number.parseInt(parts[1], 10) || 0;
            }
          }
          reply({ id: frame.id, result: { branch, hasRemote, upstream, ahead, behind } });
          return;
        }
        case 'x/git/commit': {
          // 提交：默认只提交已暂存；includeUnstaged=true 时先 add -A。
          // 身份预检给出可读错误，而非 git 原始失败。
          const p = frame.params || {};
          const dir = validateDir(p.path);
          const message = typeof p.message === 'string' ? p.message.trim() : '';
          if (!message || message.includes('\0')) {
            throw Object.assign(new Error('请先输入提交消息'), { code: 'X_FAILED' });
          }
          const email = await spawnGit(['config', 'user.email'], dir).catch(() => '');
          const name = await spawnGit(['config', 'user.name'], dir).catch(() => '');
          if (!email.trim() || !name.trim()) {
            throw Object.assign(
              new Error('当前没有可用的 Git 提交身份，请先配置 user.name 和 user.email'),
              { code: 'X_FAILED' },
            );
          }
          if (p.includeUnstaged === true) await spawnGit(['add', '-A'], dir);
          const out = await spawnGit(['commit', '-m', message], dir);
          const hash = (out.match(/[0-9a-f]{7,40}/i) || [])[0] || '';
          reply({ id: frame.id, result: { ok: true, hash } });
          return;
        }
        case 'x/git/push': {
          // 推送：无 upstream 时必须 setUpstream=true（-u origin <branch>）。
          // 网络往返 10s 不够，放宽到 60s。
          const p = frame.params || {};
          const dir = validateDir(p.path);
          const branch = (await spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
          if (!branch || branch === 'HEAD') {
            throw Object.assign(new Error('当前处于 detached HEAD，无法推送'), { code: 'X_FAILED' });
          }
          const args = ['push'];
          if (p.setUpstream === true) args.push('-u', 'origin', branch);
          await spawnGit(args, dir, { timeoutMs: 60000 });
          reply({ id: frame.id, result: { ok: true, branch } });
          return;
        }
        case 'x/git/diffstat': {
          // 状态面板「更改 +N -M」：staged + unstaged 的行级增删汇总
          //（官方对齐：git diff [--cached] --numstat 后求和）。
          // numstat 行 = "added\tremoved\tpath"；二进制文件两列为 "-"，
          // parseInt 得 NaN 按 0 行计但仍计入 files。
          const dir = validateDir(frame.params && frame.params.path);
          const parseNumstat = (out) => {
            let added = 0; let removed = 0; let files = 0;
            for (const line of out.split('\n')) {
              if (!line.trim()) continue;
              const cols = line.split('\t');
              const a = Number.parseInt(cols[0], 10);
              const r = Number.parseInt(cols[1], 10);
              if (!Number.isNaN(a)) added += a;
              if (!Number.isNaN(r)) removed += r;
              files++;
            }
            return { added, removed, files };
          };
          const [staged, unstaged] = await Promise.all([
            spawnGit(['diff', '--cached', '--numstat', '--find-renames'], dir),
            spawnGit(['diff', '--numstat', '--find-renames'], dir),
          ]);
          const s = parseNumstat(staged);
          const u = parseNumstat(unstaged);
          reply({ id: frame.id, result: {
            added: s.added + u.added,
            removed: s.removed + u.removed,
            files: s.files + u.files,
          } });
          return;
        }
        case 'x/git/filediff': {
          // 审查 sheet 按文件 diff（对齐官方审查标签）：staged/unstaged 二选一。
          // path 必填且为单文件；--find-renames 保持与 diffstat 同口径。
          // 返回 unified patch 原文（截断到 128KB 防单文件巨型生成物撑爆 1MiB 帧）。
          const params = frame.params || {};
          const dir = validateDir(params.path);
          const file = params.file;
          if (typeof file !== 'string' || !file.trim() || file.includes('\n')) {
            throw safeError('X_BAD_PARAMS');
          }
          const staged = params.staged === true;
          const args = ['diff', ...(staged ? ['--cached'] : []), '--find-renames', '--', file.trim()];
          const out = await spawnGit(args, dir);
          const MAX_DIFF = 128 * 1024;
          const truncated = Buffer.byteLength(out, 'utf8') > MAX_DIFF;
          reply({ id: frame.id, result: {
            file: file.trim(),
            staged,
            patch: truncated ? Buffer.from(out, 'utf8').subarray(0, MAX_DIFF).toString('utf8') : out,
            truncated,
          } });
          return;
        }
        case 'x/git/changedfiles': {
          // 审查 sheet 文件列表：staged/unstaged 的 numstat 明细（含每文件增删）。
          const params = frame.params || {};
          const dir = validateDir(params.path);
          const staged = params.staged === true;
          const out = await spawnGit(
            ['diff', ...(staged ? ['--cached'] : []), '--numstat', '--find-renames'], dir);
          const files = [];
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            const cols = line.split('	');
            if (cols.length < 3) continue;
            const a = Number.parseInt(cols[0], 10);
            const r = Number.parseInt(cols[1], 10);
            files.push({
              path: cols.slice(2).join('	'),
              added: Number.isNaN(a) ? null : a, // 二进制文件为 null
              removed: Number.isNaN(r) ? null : r,
            });
          }
          reply({ id: frame.id, result: { files, staged } });
          return;
        }
        case 'x/git/restore': {
          // 撤销更改（危险操作，手机端 UI 双确认后才调用）：
          // staged=true → git restore --staged --worktree -- <file>（整体撤销）；
          // 否则只撤工作区。单文件；路径白名单无 shell。
          const params = frame.params || {};
          const dir = validateDir(params.path);
          const file = params.file;
          if (typeof file !== 'string' || !file.trim() || file.includes('\n')) {
            throw safeError('X_BAD_PARAMS');
          }
          const args = ['restore', ...(params.staged === true ? ['--staged', '--worktree'] : ['--worktree']), '--', file.trim()];
          await spawnGit(args, dir);
          reply({ id: frame.id, result: { ok: true, file: file.trim(), staged: params.staged === true } });
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
        case 'x/fs/dirs': {
          // 手机端目录选择器（新建会话自选工作区）：列出目录的直接子目录。
          // path 缺省 = 根模式（枚举盘符 + 主目录入口）。只返回目录名，
          // 不读内容；symlink/junction 跳过（防环）；系统垃圾目录过滤。
          // 实测前提：session/create 接受任意未注册路径（probe-wscreate.js），
          // 但引擎不校验存在性——本方法只列真实存在的目录，从源头兜住。
          const raw = String((frame.params && frame.params.path) || '').trim();
          const home = os.homedir();
          if (!raw) {
            const dirs = [];
            if (process.platform === 'win32') {
              for (let i = 65; i <= 90; i++) {
                const drive = `${String.fromCharCode(i)}:\\`;
                try { if (fs.existsSync(drive)) dirs.push({ name: drive, path: drive }); } catch { }
              }
            } else {
              dirs.push({ name: '/', path: '/' });
            }
            reply({ id: frame.id, result: { path: '', parent: null, home, dirs } });
            return;
          }
          if (!path.isAbsolute(raw)) throw safeError('X_BAD_PARAMS');
          const resolved = path.resolve(raw);
          let st;
          try { st = fs.statSync(resolved); } catch { throw safeError('X_BAD_PARAMS'); }
          if (!st.isDirectory()) throw safeError('X_BAD_PARAMS');
          let entries;
          try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
          } catch (e) {
            // 权限/IO 失败显性上浮，不静默返回空列表
            throw Object.assign(new Error(String(e.message || e).slice(0, 200)), { code: 'X_FAILED' });
          }
          const JUNK = new Set(['$RECYCLE.BIN', 'System Volume Information', 'Config.Msi']);
          const dirs = entries
            .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !JUNK.has(d.name))
            .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
          const parent = path.dirname(resolved);
          reply({ id: frame.id, result: {
            path: resolved,
            parent: parent === resolved ? null : parent, // 盘符根没有上级
            home,
            dirs,
          } });
          return;
        }
        case 'x/model/catalog': {
          // 可用目录：引擎实测（settings.model.available，唯一可信源）+
          // 导入快照补充（标记 imported，未经引擎证实可用性）。
          // 条目透传层级弹层元数据；BigModel 个人组带 planGroup 供手机端置顶。
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
            ...engine.map((m) => ({
              ...m,
              available: true,
              source: 'engine',
              // BigModel 个人组：置顶标记 + 组名兜底（引擎 providerLabel 缺失时）
              ...(m.providerId === PLAN_PROVIDER_ID ? {
                planGroup: true,
                ...(m.providerLabel ? {} : { providerLabel: PLAN_DISPLAY_PROVIDER_NAME }),
              } : {}),
            })),
            ...imported
              .filter((m) => !engineKeys.has(`${m.providerId}/${m.modelId}`))
              .map((m) => ({
                ...m,
                available: false,
                source: 'imported',
                providerLabel: providerNameMap[m.providerId] || m.providerId,
              })),
          ];
          const def = readModelDefault();
          reply({ id: frame.id, result: {
            models,
            default: def ? { providerId: def.providerId, modelId: def.modelId,
              ...(def.reasoningLevel ? { reasoningLevel: def.reasoningLevel } : {}) } : null,
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
          writeModelDefault(p.providerId, p.modelId,
            typeof p.reasoningLevel === 'string' && p.reasoningLevel.trim()
              ? p.reasoningLevel.trim() : null);
          // 审查 P2-9：「设节点默认」与「改指定会话模型」语义分离——只有
          // 调用方显式给 applySessionTarget（目标 sessionId）才对已有会话
          // setModel；绝不自作主张改 session/list 第一项（那可能是用户
          // 正在跑的无关会话）。默认行为 = 只落盘默认值，新会话生效。
          let appliedToActive = false;
          let appliedTarget = null;
          if (typeof p.applySessionTarget === 'string' && p.applySessionTarget.trim()) {
            appliedTarget = p.applySessionTarget.trim();
            try {
              const reasoningLevel = typeof p.reasoningLevel === 'string' && p.reasoningLevel.trim()
                ? p.reasoningLevel.trim() : null;
              const r = await bridgeRequest({
                id: nextLocalId(), method: 'session/setModel',
                params: { sessionId: appliedTarget,
                  model: { providerId: p.providerId, modelId: p.modelId,
                    ...(reasoningLevel ? { options: { reasoningLevel } } : {}) } },
              });
              appliedToActive = Boolean(r && !r.error);
            } catch { /* setModel 失败不回滚默认值（新会话仍会应用） */ }
          }
          reply({ id: frame.id, result: {
            ok: true, appliedToActive,
            default: { providerId: p.providerId, modelId: p.modelId },
          } });
          return;
        }
        case 'x/workspaces/list': {
          const snap = readImportSnapshot();
          const workspaces = snap?.categories?.workspaces;
          reply({ id: frame.id, result: {
            workspaces: Array.isArray(workspaces) ? workspaces : [],
            importedAt: snap?.importedAt || null,
          } });
          return;
        }
        case 'x/preferences/summary': {
          const snap = readImportSnapshot();
          const preferences = snap?.categories?.preferences;
          const keys = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
            ? Object.keys(preferences).sort() : [];
          reply({ id: frame.id, result: {
            count: keys.length, keys, importedAt: snap?.importedAt || null,
          } });
          return;
        }
        case 'x/extensions/list': {
          // 导入快照的扩展摘要（只读）；快照缺失时如实返回 empty 而非报错
          const snap = readImportSnapshot();
          const summary = snap?.categories?.extensions;
          reply({ id: frame.id, result: {
            skills: summary && Array.isArray(summary.skills) ? summary.skills : [],
            plugins: summary && Array.isArray(summary.plugins) ? summary.plugins : [],
            commands: summary && Array.isArray(summary.commands) ? summary.commands : [],
            mcpCount: summary && typeof summary.mcpCount === 'number' ? summary.mcpCount : 0,
            importedAt: snap?.importedAt || null,
          } });
          return;
        }
        case 'x/file/begin': {
          // 手机附件上传（三段式：begin→chunk*→commit）。落盘工作区
          // .wzxclaw-attachments/，返回节点绝对路径供消息引用（引擎 Read
          // →视觉管线自洽，APP-SERVER.md「附件入口实测」）。
          // 安全：文件名只取末段并做字符白名单，杜绝路径穿越。
          // 工作区身份（评审 #19）：可选 workspacePath 指定落盘根——
          // 会话允许任意工作区，附件必须落进消息所属会话的工作区而非
          // 启动目录；缺省回退 cwd（兼容旧调用）。
          const p = frame.params || {};
          const rawName = String(p.name || '').trim();
          const safeName = rawName.replace(/[\\\/]/g, '_').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
          if (!safeName || safeName === '.' || safeName === '..'
            || safeName.length > 120) {
            throw safeError('X_BAD_PARAMS');
          }
          if (!Number.isInteger(p.size) || p.size < 0 || p.size > 200 * 1024 * 1024) {
            throw safeError('X_BAD_PARAMS');
          }
          const root = resolveWorkspaceRoot(p.workspacePath);
          const dir = path.join(root, '.wzxclaw-attachments');
          fs.mkdirSync(dir, { recursive: true });
          const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const stamp = new Date().toISOString().slice(0, 10);
          // 目标名带日期+上传 id 前缀防同名校验；手机引用返回的完整路径
          const fileName = `${stamp}-${uploadId}-${safeName}`;
          const tmpPath = path.join(dir, `${fileName}.part`);
          fs.writeFileSync(tmpPath, Buffer.alloc(0));
          fileUploads.set(uploadId, { tmpPath, finalPath: path.join(dir, fileName),
            size: p.size, received: 0, createdAt: Date.now() });
          reply({ id: frame.id, result: {
            uploadId,
            // 手机拼接进消息文本的引用（引擎工作区内的绝对路径）
            filePath: path.join(dir, fileName),
          } });
          return;
        }
        case 'x/file/chunk': {
          const p = frame.params || {};
          const up = fileUploads.get(String(p.uploadId || ''));
          if (!up) throw safeError('X_NO_UPLOAD');
          if (typeof p.data !== 'string' || p.data.length === 0) {
            throw safeError('X_BAD_PARAMS');
          }
          const buf = Buffer.from(p.data, 'base64');
          up.received += buf.length;
          if (up.received > up.size) { // 声明尺寸不符：截断拒绝，防塞大文件
            fileUploads.delete(String(p.uploadId));
            try { fs.unlinkSync(up.tmpPath); } catch { /* best effort */ }
            throw safeError('X_BAD_PARAMS');
          }
          fs.appendFileSync(up.tmpPath, buf);
          reply({ id: frame.id, result: { received: up.received } });
          return;
        }
        case 'x/file/commit': {
          const p = frame.params || {};
          const up = fileUploads.get(String(p.uploadId || ''));
          if (!up) throw safeError('X_NO_UPLOAD');
          fileUploads.delete(String(p.uploadId));
          if (up.received !== up.size) { // 不完整：删除并如实报错，不留半个文件
            try { fs.unlinkSync(up.tmpPath); } catch { /* best effort */ }
            throw safeError('X_BAD_PARAMS');
          }
          fs.renameSync(up.tmpPath, up.finalPath);
          reply({ id: frame.id, result: {
            ok: true,
            filePath: up.finalPath,
            size: up.size,
          } });
          return;
        }
        case 'x/file/abort': {
          // 手机端上传失败/取消的对称清理（此前手机端一直在调、companion
          // 却没有这个 case，落入未实现分支）。幂等：会话不存在也回 ok。
          const p = frame.params || {};
          const up = fileUploads.get(String(p.uploadId || ''));
          fileUploads.delete(String(p.uploadId || ''));
          if (up) {
            try { fs.unlinkSync(up.tmpPath); } catch { /* best effort */ }
          }
          reply({ id: frame.id, result: { ok: true } });
          return;
        }
        case 'x/file/download/begin': {
          // 手机端文件下载（begin→chunk*→eof|abort，上传族的镜像）。
          // 安全边界：只允许工作区内文件（含 .wzxclaw-attachments）——
          // 以 realpath 解析后的真实路径做包含校验（评审 #20：字面
          // path.relative 检查可被 symlink/junction 绕过），再以固定句柄
          // 读取，杜绝「校验后目标被换」；工作区外/不存在/非普通文件
          // 一律 X_NOT_FOUND/X_OUT_OF_WORKSPACE，不区分透露细节。
          // 工作区身份（评审 #19）：可选 workspacePath 指定校验根
          // （会话工作区），缺省回退启动 cwd。
          const p = frame.params || {};
          if (typeof p.path !== 'string' || p.path.trim().length === 0
            || p.path.length > 500) {
            throw safeError('X_BAD_PARAMS');
          }
          const root = resolveWorkspaceRoot(p.workspacePath);
          // realpath 还原 symlink/junction 后，与同样 realpath 过的工作区根
          // 做包含校验（评审 #20）。不做字面预检（2026-09-19 评审 P2）：
          // 工作区根本身是链接时，字面表示与真实表示不一致会把合法文件
          // 误判越界；realpath + 真实根的包含比较与调用方路径表示无关，
          // 是唯一既防逃逸（`..` 穿越被 realpath 解析、工作区内链接指向
          // 外部被还原）又不误判的权威检查。不存在 → X_NOT_FOUND。
          let abs;
          try { abs = fs.realpathSync(path.resolve(p.path.trim())); }
          catch { throw safeError('X_NOT_FOUND'); }
          const rel = path.relative(root, abs);
          if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            // 与「文件不存在」分开报 reason（同一 -32103 码）：手机端给
            // 「仅限工作区内」与「文件不存在请重试」两种不同指引
            throw safeError('X_OUT_OF_WORKSPACE');
          }
          let st;
          try { st = fs.statSync(abs); } catch { throw safeError('X_NOT_FOUND'); }
          if (!st.isFile()) throw safeError('X_NOT_FOUND');
          if (st.size > 200 * 1024 * 1024) throw safeError('X_BAD_PARAMS');
          let fd;
          try { fd = fs.openSync(abs, 'r'); } catch { throw safeError('X_NOT_FOUND'); }
          const downloadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          // 手机本地文件名：末段 + 字符白名单（同 x/file/begin 落盘名规则）
          const safeName = path.basename(abs).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_') || 'file';
          fileDownloads.set(downloadId, { fd, absPath: abs, size: st.size, createdAt: Date.now() });
          reply({ id: frame.id, result: { downloadId, name: safeName, size: st.size } });
          return;
        }
        case 'x/file/download/chunk': {
          const p = frame.params || {};
          const dl = fileDownloads.get(String(p.downloadId || ''));
          if (!dl) throw safeError('X_NOT_FOUND');
          // offset ∈ [0, size)；size===0 的空文件允许 offset 0（直接 eof）
          if (!Number.isInteger(p.offset) || p.offset < 0
            || (dl.size > 0 && p.offset >= dl.size)) {
            throw safeError('X_BAD_PARAMS');
          }
          const want = Math.min(DOWNLOAD_CHUNK_BYTES, dl.size - p.offset);
          const buf = Buffer.alloc(want);
          let bytesRead = 0;
          try {
            // 从 begin 时打开的固定句柄读：文件在会话期间被改小/替换，
            // bytesRead 如实反映，eof 判定跟着 received 走，不回填零字节
            bytesRead = fs.readSync(dl.fd, buf, 0, want, p.offset);
          } catch { throw safeError('X_FAILED'); }
          const received = p.offset + bytesRead;
          const eof = received >= dl.size;
          if (eof) closeDownload(String(p.downloadId));
          reply({ id: frame.id, result: {
            data: buf.subarray(0, bytesRead).toString('base64'),
            received,
            eof,
          } });
          return;
        }
        case 'x/file/download/abort': {
          // 幂等清理：会话不存在也回 ok（手机端取消/失败路径无需区分）
          const p = frame.params || {};
          closeDownload(String(p.downloadId || ''));
          reply({ id: frame.id, result: { ok: true } });
          return;
        }
        default:
          reply({ id: frame.id, error: { code: ERR_UNHANDLED, message: `companion 未实现该扩展方法: ${frame.method}` } });
      }
    } catch (err) {
      // x/* 错误码显式枚举（与 lib/protocol.js 的常量一一对应）；
      // 未知 reason 兜底 ERR_X_FAILED，绝不借用 git/超时的语义
      const reason = err.code || '';
      const code = reason === 'X_BAD_PARAMS' ? ERR_X_BAD_PARAMS
        : reason === 'X_NOT_FOUND' || reason === 'X_OUT_OF_WORKSPACE' || reason === 'X_NO_UPLOAD'
          ? ERR_X_NOT_FOUND
        : reason === 'X_GIT_TIMEOUT' ? ERR_X_GIT_TIMEOUT
        : reason === 'X_GIT_FAILED' ? ERR_X_GIT_FAILED
        : reason === 'X_MODEL_TIMEOUT' ? ERR_TIMEOUT
        : ERR_X_FAILED;
      reply({ id: frame.id, error: { code, message: String(err.message || err), data: { reason: reason || 'X_FAILED' } } });
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
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        if (bridge && bridge.write({ id: entry.nativeId, error: { code: ERR_TIMEOUT, message: 'Client request timed out' } })) answered++;
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
        if (msg.pair_status === 'matched') { startBridge(); flushUndeliveredReverse(); onStateChange(currentState()); }
        else onStateChange('waiting-pairing');
        return;
      }
      if (msg.type === 'pair_status_ack') {
        if (authStage !== 'authenticated') return;
        if (!['matched', 'waiting'].includes(msg.pair_status)) { conn.close(); return; }
        matchedUp = msg.pair_status === 'matched';
        if (msg.pair_status === 'matched') { startBridge(); flushUndeliveredReverse(); onStateChange(currentState()); }
        else onStateChange('waiting-pairing');
        return;
      }
      if (msg.type === 'data') {
        if (authStage !== 'authenticated' || !isObject(msg.payload)) return;
        handlePhoneFrame(msg.payload);
      }
    });
  }

  // 状态投影唯一实现：getter 与 onStateChange 回调共用（评审 #18）。
  // 此前回调无条件发 'paired'（桥未起/预检未完成也发），宿主缓存后
  // 与 getter 的 paired-no-model 漂移，托盘/顶栏谎报健康。
  function currentState() {
    if (!ws) return 'disconnected';
    if (authStage !== 'authenticated') return 'connecting';
    // 以房间实际配对状态为准：手机离席时如实报告 waiting-pairing 而非残留 paired。
    if (!matchedUp) return 'waiting-pairing';
    if (bridgeDead) return 'app-server-dead';
    return bridgeStarted && bridge ? 'paired' : 'paired-no-model';
  }

  return {
    start() {
      if (stopped) throw safeError('ALREADY_STOPPED');
      connect();
    },
    // 受管 runtime：门禁预检成功后热注入已验证 descriptor 并按需起桥。
    // 同一条 relay 链路上生效——不重连、不重注册、配对身份不变。
    setRuntimeDescriptor(descriptor) {
      if (!runtimeManaged) throw safeError('INVALID_STATE');
      if (!isObject(descriptor) || typeof descriptor.command !== 'string' || !descriptor.command
        || !Array.isArray(descriptor.args) || !descriptor.args.every((a) => typeof a === 'string')) {
        throw safeError('INVALID_RUNTIME_DESCRIPTOR');
      }
      managedDescriptor = { command: descriptor.command, args: [...descriptor.args] };
      log('runtime-descriptor-set', typeof descriptor.source === 'string' ? descriptor.source : '');
      if (matchedUp) startBridge();
    },
    get pairingUrl() { return pairing ? pairing.url : null; },
    get state() {
      return currentState();
    },
  stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(linkWatchTimer);
    // 下载会话的固定句柄一并关闭（评审 #20）：中断的下载不留悬挂 fd
    for (const [id] of fileDownloads) closeDownload(id);
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

function resolveRegistrationSecret({ explicit, env = process.env,
  homeDir = os.homedir() } = {}) {
  return explicit || env.REGISTRATION_SECRET || readRegistrationSecretFile(homeDir);
}

module.exports = { createCompanion, AppServerBridge, readModelAuth, derivePairingUrl, defaultZcodeCommand,
  resolveZcodeRuntime, runtimeProcessEnv, runRuntimeCommand, probeAppServer, probeZcodeRuntime,
  readRegistrationSecretFile, resolveRegistrationSecret };
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
      try {
        await qrcodeLib.toFile(target, url, { width: 600, margin: 2 });
        // 与 pair-url.txt 同一纪律：QR PNG 载荷就是完整配对 URL（凭据），
        // 统一 0600（Windows 下 no-op，POSIX 宿主上是实际防线）
        try { fs.chmodSync(target, 0o600); } catch { /* 平台不支持时忽略 */ }
      } catch { /* 尽力而为 */ }
    }
  }
  console.error(`[companion] 配对码已更新：${pngTargets[0]}（文本链接 ${dataDir}${path.sep}pair-url.txt）`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const relayIdx = args.indexOf('--relay');
  const cwdIdx = args.indexOf('--cwd');
  const noQrIdx = args.indexOf('--no-qr');
  const midFileIdx = args.indexOf('--mid-file');
  const qrPngIdx = args.indexOf('--qr-png');
  const midFile = midFileIdx !== -1 && args[midFileIdx + 1] ? args[midFileIdx + 1] : undefined;
  const qrPngPath = qrPngIdx !== -1 && args[qrPngIdx + 1] ? args[qrPngIdx + 1] : undefined;
  // 密钥来源统一为环境变量 > 0600 文件；不提供命令行参数入口，避免凭据
  // 暴露在 shell history 和进程列表。都未提供时兼容开放注册 relay。
  const registrationSecret = resolveRegistrationSecret();
  if (relayIdx === -1 || !args[relayIdx + 1]) {
    console.error('用法: node companion.js --relay ws://127.0.0.1:18884/ws [--cwd <工作目录>] [--no-qr] [--mid-file <路径>] [--qr-png <路径>]');
    process.exitCode = 1;
  } else {
    void (async () => {
    // R09（版本锁全入口）：CLI 与 GUI 共用同一运行时基线。确认「不支持
    // 的版本前缀」→ fail-fast 拒绝启动（锁定已验证版本是 AGENTS 明文
    // 要求）；版本读取失败只告警不阻塞（与 GUI 预检 version-failed 分
    // 级一致，不把基础设施抖动一票否决）。
    try {
      const resolvedCli = resolveZcodeRuntime(process.env);
      if (resolvedCli.category === 'resolved') {
        const v = await runRuntimeCommand(resolvedCli, ['--version'], { env: process.env });
        const versionText = (v.versionText || v.stdout).match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null;
        if (versionText && !SUPPORTED_RUNTIME_PREFIXES.some((prefix) => versionText.startsWith(prefix))) {
          console.error(`[companion] 运行时版本 ${versionText} 不在已验证基线 [${SUPPORTED_RUNTIME_PREFIXES.join(', ')}]，拒绝启动（R09 版本锁；先跑探针复核并更新基线）`);
          process.exitCode = 1;
          return;
        }
      }
    } catch { /* 版本探测失败：不阻塞启动 */ }
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
          // R01（P0）：--no-qr 是自启动/无人值守入口，stdout/stderr 会被
          // 重定向进普通日志；配对 URL 含持有者凭据（sid/hash），绝不入
          // 日志——只落受保护产物文件，人去固定路径取码。
          if (noQrIdx !== -1) {
            console.error('配对 URL 已写入配对产物文件（不在日志中出现）');
          } else {
            console.log('配对 URL（扫码或粘贴到手机 App）:');
            console.log('');
            // 必须以方法形式调用（内部依赖 this.error 取纠错级别）
            if (qrTerminal) {
              qrTerminal.generate(url, { small: true });
            }
            console.log(url);
          }
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
    })();
  }
}
