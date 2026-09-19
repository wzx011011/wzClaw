'use strict';
// ============================================================
// wzxClaw Companion App（Windows 桌面壳）
//
// 构建前从 relay/zcode 唯一源码生成 cclient 核心，通过 createCompanion
// 回调驱动两个形态：
// - 完整形态：状态 + 配对二维码 + 设置（relay/工作目录/自启）+ 日志
// - 桌面宠物形态：透明置顶小窗，状态变色，双击/菜单回到完整形态
// 托盘常驻；关闭窗口 = 缩到托盘。配对凭据与 CLI companion 共享同一
// 数据目录（~/.wzxclaw/zcode-companion/），互斥靠 companion.lock——
// 与旧计划任务二选一，同数据目录下换码不发生、手机不用重新配对。
// ============================================================

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const QRCode = require('qrcode');
const { createCompanion, resolveRegistrationSecret, probeZcodeRuntime, fetchPlanModelIds } = require('./cclient/companion');
const { detectZcode, normalizeImportSelection, buildImportManifest, bundledRuntimePath } = require('./zcode-integration');
const { applyImport, snapshotSummary } = require('./zcode-importer');
const { createRuntimeGate } = require('./runtime-gate');

// 进程级兜底：托盘常驻节点不允许静默死亡。取证后继续存活——桥的
// spawn/重启逻辑自身有状态机，未处理异常多来自已防护边界的偶发竞态。
process.on('uncaughtException', (error) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'),
      `${new Date().toISOString()} uncaught ${error.stack || error}\n`);
  } catch { /* 尽力取证 */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'),
      `${new Date().toISOString()} unhandledRejection ${reason && reason.stack ? reason.stack : reason}\n`);
  } catch { /* 尽力取证 */ }
});

// 默认连接我们自己的 NAS relay（安装即连；设置里可改）
const DEFAULT_RELAY_URL = 'wss://zcode.5945.top/ws';
const RELAY_RE = /^wss?:\/\/.+\/ws$/;

let cfg = null;
let configPath = null;
let companion = null;
let lastState = 'disconnected';
let pairingUrl = null;
let qrDataUrl = null;
let mode = 'full'; // 'full' | 'pet'
let fullWin = null;
let petWin = null;
let tray = null;
let quitting = false;
// 最近一次 companion 启动错误（评审 #17）：null = 无；进快照供渲染层展示
let companionError = null;
let runtimeStatus = { category: 'checking', source: null, version: null, detailCode: null };
let runtimeGate = null;
const logTail = [];

const isPortable = () => Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

// ---- 配置 ----

function loadConfig() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, 'config.json');
  logFilePath = path.join(dir, 'companion.log');
  const defaults = {
    schemaVersion: 2,
    relayUrl: DEFAULT_RELAY_URL,
    cwd: app.getPath('home'),
    mode: 'full',
    firstRun: { completed: false },
  };
  try {
    cfg = { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    cfg = defaults;
  }
  if (!RELAY_RE.test(cfg.relayUrl)) cfg.relayUrl = DEFAULT_RELAY_URL;
  if (!cfg.firstRun || typeof cfg.firstRun !== 'object') cfg.firstRun = { completed: false };
  cfg.schemaVersion = 2;
  mode = cfg.mode === 'pet' ? 'pet' : 'full';
}

function persistConfig() {
  cfg.mode = mode;
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

function validateCompanionSetup(next) {
  if (!RELAY_RE.test(String(next.relayUrl || ''))) {
    return { ok: false, error: 'relay 地址必须是 wss://…/ws 形式' };
  }
  const cwd = String(next.cwd || '');
  try {
    if (!cwd || !fs.statSync(cwd).isDirectory()) {
      return { ok: false, error: '工作目录不存在' };
    }
  } catch {
    return { ok: false, error: '工作目录不存在' };
  }
  return { ok: true, relayUrl: next.relayUrl.trim(), cwd };
}

function safeDetectionSnapshot() {
  const detected = detectZcode({
    // 打包态内嵌 runtime 路径（官方安装存在时探测层永远优先官方）
    bundledRuntime: bundledRuntimePath(process.resourcesPath || null),
  });
  // renderer 只需要状态和计数；启动路径、文件名、原始配置均留在主进程。
  return {
    installation: { status: detected.installation.status, source: detected.installation.source },
    metadata: detected.metadata,
    credentials: detected.credentials,
  };
}

// ---- 导入快照（Companion 自己的 userData，绝不写 ~/.zcode） ----

function companionStateDir() {
  return path.join(app.getPath('home'), '.wzxclaw', 'zcode-companion');
}

function importSnapshotPath() {
  return path.join(companionStateDir(), 'import-snapshot.json');
}

function importSnapshotSummary() {
  return snapshotSummary(importSnapshotPath());
}

function firstRunSnapshot() {
  return {
    completed: cfg.firstRun.completed === true,
    selection: normalizeImportSelection({ selection: cfg.firstRun.selection }, {
      useDefaults: cfg.firstRun.completed !== true,
    }),
    detected: safeDetectionSnapshot(),
  };
}

function saveConfig() {
  // 持久化失败上抛（评审 #16）：吞掉错误会假成功，重启后悄悄回到旧配置。
  // 调用方负责回滚与反馈。
  persistConfig();
}

// ---- 日志与广播 ----

// 持久化日志上限：单文件 1MB，超过即截断重写（托盘常驻进程不允许
// 只留内存日志——本次排障证明窗口一关证据就丢）。
const LOG_FILE_MAX_BYTES = 1024 * 1024;
let logFilePath = null;

function appendLogFile(line) {
  if (!logFilePath) return;
  try {
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > LOG_FILE_MAX_BYTES) {
      fs.writeFileSync(logFilePath, '');
    }
    fs.appendFileSync(logFilePath, `${line}\n`);
  } catch { /* 日志落盘失败不影响主流程 */ }
}

function pushLog(event, detail) {
  const text = detail || '';
  logTail.push({ t: Date.now(), event, detail: text });
  if (logTail.length > 300) logTail.splice(0, logTail.length - 300);
  appendLogFile(`${new Date().toISOString()} ${event}${text ? ` ${text}` : ''}`);
  broadcast('log', { event, detail: text });
}

function broadcast(type, payload) {
  for (const w of [fullWin, petWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('companion-ev', { type, payload });
  }
}

// ---- companion 生命周期 ----

function publicRuntimeStatus(status = runtimeStatus) {
  return {
    category: status.category,
    source: status.source || null,
    version: status.version || null,
    detailCode: status.detailCode || null,
    doctorWarning: status.doctorWarning || null,
  };
}

// relay/device 控制面与 runtime 健康解耦（2026-09-18 定）：companion 一旦
// 创建就保持注册在线——引擎预检失败只降级为「已配对（引擎未就绪）」，不再
// 整机下线（此前 probe 失败被当成整机开关，手机端因此反复断线重连）。
// 只有 relay/工作目录配置变化才重建链路；重试运行时永不触碰已在线连接。
let companionCfgKey = null;
let lifecycleQueue = Promise.resolve();
function serializedLifecycle(fn) {
  const run = lifecycleQueue.then(fn, fn);
  lifecycleQueue = run.then(() => {}, () => {});
  return run;
}
const currentCfgKey = () => `${cfg.relayUrl}|${cfg.cwd}`;

async function stopCompanionUnlocked() {
  const running = companion;
  companion = null;
  companionCfgKey = null;
  pairingUrl = null;
  qrDataUrl = null;
  broadcast('pairing', { url: null, qr: null });
  if (running) {
    try { await running.stop(); } catch { /* 尽力停止旧链路 */ }
  }
}

async function stopCompanion() {
  return serializedLifecycle(stopCompanionUnlocked);
}

function initRuntimeGate() {
  runtimeGate = createRuntimeGate({
    probe: (snapshot) => probeZcodeRuntime({ cwd: snapshot.cwd }),
    // 预检成功只交付 descriptor：同一条在线链路上热启引擎，不重连不重注册。
    apply: async (descriptor) => {
      if (!companion) throw new Error('companion-not-running');
      companion.setRuntimeDescriptor(descriptor);
    },
    onStatus: (status) => {
      if (status.category !== runtimeStatus.category
        || status.detailCode !== runtimeStatus.detailCode) {
        const fields = [status.category];
        if (status.source) fields.push(`source=${status.source}`);
        if (status.detailCode) fields.push(`detail=${status.detailCode}`);
        if (status.doctorWarning) fields.push(`doctor=${status.doctorWarning}`);
        if (status.stderrTail) fields.push(`stderr=${status.stderrTail}`);
        if (status.diag) fields.push(status.diag);
        if (status.attempts > 1) fields.push(`attempts=${status.attempts}`);
        pushLog('runtime-status', fields.join(' '));
      }
      runtimeStatus = status;
      broadcast('runtime-status', publicRuntimeStatus());
    },
    onFailure: (status) => {
      // 只更新 runtime 面板；连接状态由 onStateChange 独立驱动，引擎预检
      // 失败不再改写 lastState/托盘（设备保持在线）。
      pushLog('runtime-preflight-failed', status.category);
    },
  });
}

function ensureRuntimeThenStart() {
  if (!runtimeGate) initRuntimeGate();
  // 先保证设备在线（引擎未就绪也注册可配对），再跑预检；预检结果只决定
  // 引擎何时可用，不决定设备是否在线。
  return startCompanion()
    .then(() => runtimeGate.check({ relayUrl: cfg.relayUrl, cwd: cfg.cwd }))
    .then(() => {
      armRuntimeReprobe();
      return publicRuntimeStatus();
    });
}

// 未就绪周期性重探（2026-09-20 事故修复）：安装新包后的首次启动，预检会
// 因新 exe 被 Defender 扫描/安装器锁未释放而 EXIT_1，且 gate 只在配置
// 变化时重探——「稍后自动可用」成空头支票，设备永远 paired-no-model。
// 未就绪期间每 60s 重探一次；ready 后停表（配置变化由现有 check 流程覆盖）。
let runtimeReprobeTimer = null;
function armRuntimeReprobe() {
  if (runtimeReprobeTimer) return;
  if (runtimeStatus && runtimeStatus.category === 'ready') return;
  runtimeReprobeTimer = setInterval(() => {
    if (runtimeReprobeTimer && runtimeStatus && runtimeStatus.category === 'ready') {
      clearInterval(runtimeReprobeTimer);
      runtimeReprobeTimer = null;
      return;
    }
    if (!companion || !cfg || !cfg.relayUrl) return;
    pushLog('runtime-reprobe', '');
    void runtimeGate.check({ relayUrl: cfg.relayUrl, cwd: cfg.cwd }).then(() => {
      if (runtimeStatus && runtimeStatus.category === 'ready' && runtimeReprobeTimer) {
        clearInterval(runtimeReprobeTimer);
        runtimeReprobeTimer = null;
      }
    });
  }, 60_000);
}

function startCompanion() {
  return serializedLifecycle(async () => {
    if (companion && companionCfgKey === currentCfgKey()) return; // 在线且配置未变：直接复用
    if (companion) await stopCompanionUnlocked(); // 配置变化才重建链路
    pairingUrl = null;
    qrDataUrl = null;
    // 注册共享密钥：与 CLI companion 同源（~/.wzxclaw/zcode-companion/relay-
    // secret）。NAS relay 设了 REGISTRATION_SECRET，注册必须携带 proof——
    // 不读这个文件，旧房间过期后的重注册会被 AUTH_FAILED 拒绝，陷入
    // 「连接即断」的重连循环（2026-09-16 首启实测踩坑）。
    const registrationSecret = resolveRegistrationSecret() || undefined;
    try {
      companion = createCompanion({
        relayUrl: cfg.relayUrl,
        cwd: cfg.cwd,
        // 受管 runtime：descriptor 由预检热注入；未就绪时设备保持在线
        // （paired-no-model），引擎可用后自动起桥。
        runtimeManaged: true,
        // 套餐模型注入：起桥前拉套餐目录生成 overlay（失败降级为现状）
        planModelFetch: fetchPlanModelIds,
        stateDir: companionStateDir(),
        snapshotPath: importSnapshotPath(),
        registrationSecret,
        logger: (event, detail) => pushLog(event, detail),
        onPairing: (url) => {
          pairingUrl = url;
          QRCode.toDataURL(url, { width: 480, margin: 1 })
            .then((qr) => {
              qrDataUrl = qr;
              broadcast('pairing', { url, qr });
            })
            .catch(() => broadcast('pairing', { url, qr: null }));
        },
        onStateChange: () => {
          // 状态以 core 的 state getter 为唯一投影（评审 #18）：此前缓存
          // 回调参数，桥未起时 core 回调仍发 paired，顶栏/托盘谎报健康
          lastState = companion ? companion.state : 'disconnected';
          broadcast('state', { state: lastState });
          updateTray();
        },
      });
      companion.start();
      companionCfgKey = currentCfgKey();
      companionError = null; // 启动成功：清掉上一次的启动错误（评审 #17）
      pushLog('app-companion-started', cfg.relayUrl);
    } catch (e) {
      // 典型：ALREADY_RUNNING（旧计划任务 companion 还在跑）——如实上屏
      // 并保留在快照里（评审 #17：错误只进日志 = 用户看不见）
      companionError = e.code || String(e.message || e);
      pushLog('app-companion-error', companionError);
      broadcast('companion-error', { message: companionError });
    }
  });
}

// ---- 窗口 ----

const preloadPath = () => path.join(__dirname, 'preload.js');

// renderer 黑窗取证（2026-09-16 间歇复现两次）：加载失败/进程死亡必须有
// 落盘日志与运行日志，不允许静默黑屏；同时做有限自愈（最多重载 2 次）。
function logRendererFault(kind, detail) {
  const line = `${new Date().toISOString()} ${kind} ${detail}`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `${line}\n`);
  } catch { /* 尽力取证 */ }
  pushLog(kind, String(detail).slice(0, 200));
}

function attachRendererDiagnostics(win) {
  const wc = win.webContents;
  let reloads = 0;
  const boundedReload = (reason) => {
    if (reloads >= 2) return;
    reloads += 1;
    logRendererFault('renderer-reload', `${reason} 第${reloads}次`);
    setTimeout(() => { try { wc.reload(); } catch { /* 窗口已销毁 */ } }, 800);
  };
  wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    logRendererFault('renderer-load-failed', `${code}:${description}`);
    boundedReload(`load-failed ${code}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    logRendererFault('renderer-gone', `${details.reason} exit=${details.exitCode}`);
    if (details.reason !== 'clean-exit') boundedReload(`gone ${details.reason}`);
  });
  wc.on('did-finish-load', () => pushLog('renderer-loaded', ''));
  wc.on('console-message', (_e, _level, message) => {
    pushLog('renderer-console', String(message).slice(0, 200));
  });
}

function createFull() {
  fullWin = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    backgroundColor: '#101210',
    autoHideMenuBar: true,
    icon: trayIcon(32),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererDiagnostics(fullWin);
  fullWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 关窗 = 缩到托盘（退出走托盘菜单）
  fullWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      fullWin.hide();
    }
  });
}

function createPet() {
  petWin = new BrowserWindow({
    width: 220,
    height: 250,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererDiagnostics(petWin);
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
}

// 形态切换的持久化：写失败不得阻断窗口显示（2026-09-19 评审 P2）——
// 托盘唤窗/宠物切回必须永远可用，写失败留观测，下次保存成功时覆盖
function trySaveMode() {
  try {
    saveConfig();
  } catch (e) {
    pushLog('app-companion-error', `persist mode ${e && e.code ? e.code : e}`);
  }
}

function showFull() {
  mode = 'full';
  trySaveMode();
  if (!fullWin || fullWin.isDestroyed()) createFull();
  fullWin.show();
  fullWin.focus();
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  updateTray();
}

function showPet() {
  mode = 'pet';
  trySaveMode();
  if (!petWin || petWin.isDestroyed()) createPet();
  petWin.show();
  if (fullWin && !fullWin.isDestroyed()) fullWin.hide();
  updateTray();
}

// ---- 托盘 ----

function trayIcon(size) {
  const p = path.join(__dirname, 'assets', `icon-${size}.png`);
  if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  return nativeImage.createEmpty();
}

function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '完整形态', click: showFull },
    { label: '桌面宠物形态', click: showPet },
    { type: 'separator' },
    { label: '重试运行时', click: () => { void ensureRuntimeThenStart(); } },
    {
      label: '开机自启',
      type: 'checkbox',
      enabled: !isPortable(),
      checked: !isPortable() && app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        if (!isPortable()) app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`wzxClaw Companion — ${stateText(lastState)}`);
}

function stateText(s) {
  switch (s) {
    case 'paired': return '已配对';
    case 'paired-no-model': return '已配对（引擎未就绪）';
    case 'waiting-pairing': return '等待手机配对';
    case 'app-server-started': return '已配对';
    case 'app-server-dead': return '桥异常';
    case 'disconnected': return '未连接';
    default: return s;
  }
}

// ---- IPC ----

function registerIpc() {
  ipcMain.handle('get-snapshot', () => ({
    // 状态投影以 core state getter 为准（评审 #18）；core 不在时才回落缓存
    state: companion ? companion.state : lastState,
    stateText: stateText(companion ? companion.state : lastState),
    pairingUrl,
    qrDataUrl,
    mode,
    config: { relayUrl: cfg.relayUrl, cwd: cfg.cwd },
    autoStart: !isPortable() && app.getLoginItemSettings().openAtLogin,
    portable: isPortable(),
    logs: logTail.slice(-200),
    runtime: publicRuntimeStatus(),
    lastImport: importSnapshotSummary(),
    companionError,
  }));
  ipcMain.handle('get-first-run-status', () => firstRunSnapshot());
  ipcMain.handle('detect-zcode', () => safeDetectionSnapshot());
  // 导入预览：本机 ZCode 配置的脱敏清单 + 已有快照摘要。
  // 清单只含模型 ID/provider 名、工作区路径、白名单偏好与扩展名；
  // API Key 等凭据从 zcode-integration 边界内就不会出现。
  ipcMain.handle('zcode-import:preview', () => ({
    manifest: buildImportManifest(),
    snapshot: importSnapshotSummary(),
  }));
  ipcMain.handle('zcode-import:apply', (_e, selection) => {
    const receipt = applyImport({
      manifest: buildImportManifest(),
      selection,
      snapshotPath: importSnapshotPath(),
    });
    if (receipt.ok) {
      pushLog('zcode-import-applied',
        Object.entries(receipt.counts || {}).map(([k, v]) => `${k}:${v}`).join(' '),);
      cfg.lastImport = { importedAt: receipt.importedAt, counts: receipt.counts };
      try {
        saveConfig();
      } catch (e) {
        // 快照摘要持久化失败不推翻导入结果，但必须留观测（评审 #16 同源）
        pushLog('app-companion-error', `persist ${e && e.code ? e.code : e}`);
      }
    }
    return receipt;
  });
  ipcMain.handle('apply-first-run', async (_e, next) => {
    const valid = validateCompanionSetup(next || {});
    if (!valid.ok) return valid;
    try {
      const selection = normalizeImportSelection(next, { useDefaults: false });
      const detected = safeDetectionSnapshot();
      cfg.relayUrl = valid.relayUrl;
      cfg.cwd = valid.cwd;
      cfg.firstRun = {
        completed: true,
        completedAt: new Date().toISOString(),
        selection,
        // 仅存枚举状态，绝不落盘 provider、路径、配置内容或凭据状态细节。
        detected: {
          installation: detected.installation.status,
          metadata: detected.metadata.status,
          credentials: detected.credentials.status,
        },
      };
      persistConfig();
      if (!isPortable()) app.setLoginItemSettings({ openAtLogin: !!next.autoStart });
      await ensureRuntimeThenStart();
      return { ok: true, firstRun: firstRunSnapshot(), runtime: publicRuntimeStatus() };
    } catch {
      return { ok: false, error: '保存首启设置失败，未修改 ZCode 配置' };
    }
  });
  ipcMain.handle('dismiss-first-run', () => {
    try {
      cfg.firstRun = { completed: true, completedAt: new Date().toISOString(), selection: {} };
      persistConfig();
      return { ok: true };
    } catch {
      return { ok: false, error: '保存首启状态失败' };
    }
  });
  ipcMain.handle('retry-runtime', () => ensureRuntimeThenStart());
  // 显式重启连接（评审 #15）：「重启连接」必须真的重建链路（stop+start），
  // 与「重试运行时」区分——后者不触碰已在线连接。串行队列保证与其它
  // 生命周期操作互斥。
  ipcMain.handle('restart-connection', async () => {
    await stopCompanion();
    // 重建链路后必须重跑 runtime 预检：新建实例的 descriptor 为空
    // （runtimeManaged，等待热注入），只 start 不预检会永远停在
    // paired-no-model、普通会话请求全部失败，而运行时面板还显示旧的
    // ready（2026-09-19 评审 P1）
    await ensureRuntimeThenStart();
    return { ok: true, companionError, runtime: publicRuntimeStatus() };
  });
  ipcMain.handle('switch-mode', (_e, m) => (m === 'pet' ? showPet() : showFull()));
  ipcMain.handle('pet-menu', (_e, x, y) => {
    const menu = Menu.buildFromTemplate([
      { label: '完整形态', click: showFull },
      { label: '重试运行时', click: () => { void ensureRuntimeThenStart(); } },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    menu.popup({ x: Math.round(x), y: Math.round(y) });
  });
  ipcMain.handle('pick-cwd', async () => {
    const r = await dialog.showOpenDialog(fullWin, {
      properties: ['openDirectory'],
      defaultPath: cfg.cwd,
      title: '选择大脑工作目录',
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('save-config', async (_e, next) => {
    const valid = validateCompanionSetup(next || {});
    if (!valid.ok) return valid;
    const previous = { relayUrl: cfg.relayUrl, cwd: cfg.cwd };
    cfg.relayUrl = valid.relayUrl;
    cfg.cwd = valid.cwd;
    try {
      saveConfig();
    } catch (e) {
      // 持久化失败：回滚内存配置并如实报错（评审 #16：不再假成功——
      // 此前 ok:true 但重启后悄悄回到旧配置）
      cfg.relayUrl = previous.relayUrl;
      cfg.cwd = previous.cwd;
      return { ok: false, error: `配置写入失败（未生效）：${e && e.code ? e.code : e}` };
    }
    if (!isPortable()) app.setLoginItemSettings({ openAtLogin: !!next.autoStart });
    await ensureRuntimeThenStart(); // 换 relay/目录后先验证 runtime，再恢复连接
    return { ok: true, runtime: publicRuntimeStatus() };
  });
}

// ---- 入口 ----

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showFull());
  app.whenReady().then(() => {
    loadConfig();
    initRuntimeGate();
    registerIpc();
    if (mode === 'pet') {
      createPet();
      petWin.show();
      createFull();
      fullWin.hide();
    } else {
      createFull();
      fullWin.show();
    }
    tray = new Tray(trayIcon(16));
    updateTray();
    void ensureRuntimeThenStart();
  });
  app.on('window-all-closed', () => {
    // 托盘常驻：不随窗口关闭退出
  });
  app.on('before-quit', () => {
    quitting = true;
    if (companion) {
      try { companion.stop(); } catch { /* 尽力而为 */ }
    }
  });
}
