'use strict';
// ============================================================
// wzxClaw Companion App（Windows 桌面壳）
//
// 内嵌 relay/zcode/companion.js（cclient/ 原样拷贝，require('./server')
// 仅取 MAX_PAYLOAD），通过 createCompanion 回调驱动两个形态：
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
const { createCompanion, readRegistrationSecretFile } = require('./cclient/companion');
const { detectZcode, normalizeImportSelection } = require('./zcode-integration');

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
const logTail = [];

// ---- 配置 ----

function loadConfig() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, 'config.json');
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
  const detected = detectZcode();
  // renderer 只需要状态和计数；启动路径、文件名、原始配置均留在主进程。
  return {
    installation: { status: detected.installation.status, source: detected.installation.source },
    metadata: detected.metadata,
    credentials: detected.credentials,
  };
}

function firstRunSnapshot() {
  return {
    completed: cfg.firstRun.completed === true,
    selection: normalizeImportSelection({ selection: cfg.firstRun.selection }),
    detected: safeDetectionSnapshot(),
  };
}

function saveConfig() {
  try {
    persistConfig();
  } catch {
    /* 配置写失败不致命：下次启动用默认值 */
  }
}

// ---- 日志与广播 ----

function pushLog(event, detail) {
  logTail.push({ t: Date.now(), event, detail: detail || '' });
  if (logTail.length > 300) logTail.splice(0, logTail.length - 300);
  broadcast('log', { event, detail: detail || '' });
}

function broadcast(type, payload) {
  for (const w of [fullWin, petWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('companion-ev', { type, payload });
  }
}

// ---- companion 生命周期 ----

function startCompanion() {
  if (companion) {
    try { companion.stop(); } catch { /* 首次启动无实例 */ }
    companion = null;
  }
  pairingUrl = null;
  qrDataUrl = null;
  // 注册共享密钥：与 CLI companion 同源（~/.wzxclaw/zcode-companion/relay-
  // secret）。NAS relay 设了 REGISTRATION_SECRET，注册必须携带 proof——
  // 不读这个文件，旧房间过期后的重注册会被 AUTH_FAILED 拒绝，陷入
  // 「连接即断」的重连循环（2026-09-16 首启实测踩坑）。
  const registrationSecret = readRegistrationSecretFile() || undefined;
  try {
    companion = createCompanion({
      relayUrl: cfg.relayUrl,
      cwd: cfg.cwd,
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
      onStateChange: (state) => {
        lastState = state;
        broadcast('state', { state });
        updateTray();
      },
    });
    companion.start();
    pushLog('app-companion-started', cfg.relayUrl);
  } catch (e) {
    // 典型：ALREADY_RUNNING（旧计划任务 companion 还在跑）——如实上屏
    pushLog('app-companion-error', e.code || String(e.message || e));
    broadcast('companion-error', { message: e.code || String(e.message || e) });
  }
}

// ---- 窗口 ----

const preloadPath = () => path.join(__dirname, 'preload.js');

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
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
}

function showFull() {
  mode = 'full';
  saveConfig();
  if (!fullWin || fullWin.isDestroyed()) createFull();
  fullWin.show();
  fullWin.focus();
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  updateTray();
}

function showPet() {
  mode = 'pet';
  saveConfig();
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
    { label: '重启连接', click: () => startCompanion() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
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
    state: lastState,
    stateText: stateText(lastState),
    pairingUrl,
    qrDataUrl,
    mode,
    config: { relayUrl: cfg.relayUrl, cwd: cfg.cwd },
    autoStart: app.getLoginItemSettings().openAtLogin,
    logs: logTail.slice(-200),
    companionError: null,
  }));
  ipcMain.handle('get-first-run-status', () => firstRunSnapshot());
  ipcMain.handle('detect-zcode', () => safeDetectionSnapshot());
  ipcMain.handle('apply-first-run', (_e, next) => {
    const valid = validateCompanionSetup(next || {});
    if (!valid.ok) return valid;
    try {
      const selection = normalizeImportSelection(next);
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
      app.setLoginItemSettings({ openAtLogin: !!next.autoStart });
      startCompanion();
      return { ok: true, firstRun: firstRunSnapshot() };
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
  ipcMain.handle('switch-mode', (_e, m) => (m === 'pet' ? showPet() : showFull()));
  ipcMain.handle('pet-menu', (_e, x, y) => {
    const menu = Menu.buildFromTemplate([
      { label: '完整形态', click: showFull },
      { label: '重启连接', click: () => startCompanion() },
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
  ipcMain.handle('save-config', (_e, next) => {
    const valid = validateCompanionSetup(next || {});
    if (!valid.ok) return valid;
    cfg.relayUrl = valid.relayUrl;
    cfg.cwd = valid.cwd;
    saveConfig();
    app.setLoginItemSettings({ openAtLogin: !!next.autoStart });
    startCompanion(); // 换 relay/目录后重启连接（配对凭据不变则码不变）
    return { ok: true };
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
    startCompanion();
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
