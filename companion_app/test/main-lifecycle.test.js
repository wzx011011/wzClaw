'use strict';

// main.js 生命周期回归（2026-09-19 评审）：
// - restart-connection 必须重建链路后重跑 runtime 预检并热注入 descriptor，
//   否则新实例永远停在 paired-no-model 而运行时面板仍显示 ready；
// - 配置写失败不得阻断窗口显示（托盘唤窗/形态切换必须永远可用）。
// main.js 顶层 require electron 与私有依赖，这里用 Module._load 注入替身；
// runtime-gate 用真实实现，预检链路（probe → ready → apply）原样走到。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const Module = require('node:module');

test('restart-connection 重跑预检并注入 descriptor；写配置失败不阻断唤窗', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-main-lifecycle-'));
  const userDataDir = path.join(tmpRoot, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });

  const handlers = new Map();
  let readyCallback = null;
  const app = {
    getPath: (name) => (name === 'userData' ? userDataDir : tmpRoot),
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (cb) => { readyCallback = cb; } }),
    setLoginItemSettings() {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    quit() {},
    on() {},
  };
  class FakeBrowserWindow {
    constructor() {
      this.showCalls = 0;
      this.webContents = { on() {}, send() {} };
      FakeBrowserWindow.created.push(this);
    }
    loadFile() {}
    on() {}
    show() { this.showCalls++; }
    focus() {}
    hide() {}
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
  }
  FakeBrowserWindow.created = [];

  const instances = [];
  let probeCalls = 0;
  let failConfigWrites = false;
  let configWriteAttempts = 0;

  const realLoad = Module._load;
  const stubs = new Map([
    ['electron', {
      app,
      ipcMain: { handle: (name, cb) => handlers.set(name, cb) },
      BrowserWindow: FakeBrowserWindow,
      Tray: class { setContextMenu() {} setToolTip() {} },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    }],
    ['qrcode', { toDataURL: async () => 'data:image/png;base64,' }],
    ['./cclient/companion', {
      createCompanion() {
        const instance = {
          descriptor: null,
          stopped: false,
          start() {},
          async stop() { this.stopped = true; },
          setRuntimeDescriptor(value) { this.descriptor = value; },
          get state() { return this.descriptor ? 'paired' : 'paired-no-model'; },
        };
        instances.push(instance);
        return instance;
      },
      resolveRegistrationSecret: () => undefined,
      probeZcodeRuntime: async () => {
        probeCalls++;
        return { category: 'ready', runtimeDescriptor: { command: 'stubbed-runtime' } };
      },
      fetchPlanModelIds: () => null,
    }],
    ['./zcode-integration', {
      detectZcode: () => ({
        installation: { status: 'found', source: 'installed' },
        metadata: { status: 'compatible', providers: [], skills: [], plugins: [], mcpCount: 0 },
        credentials: { status: 'available' },
      }),
      normalizeImportSelection: ({ selection }) => selection || {},
      buildImportManifest: () => ({}),
      bundledRuntimePath: () => null,
    }],
    ['./zcode-importer', { applyImport: () => ({}), snapshotSummary: () => null }],
  ]);
  // node:fs 只拦截配置写：其余（日志、目录）走真实实现
  stubs.set('node:fs', {
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    renameSync: fs.renameSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    appendFileSync: fs.appendFileSync,
    writeFileSync(p, data, opts) {
      if (failConfigWrites && String(p).endsWith('config.json.tmp')) {
        configWriteAttempts++;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return fs.writeFileSync(p, data, opts);
    },
  });
  Module._load = function (request, parent, isMain) {
    if (stubs.has(request)) return stubs.get(request);
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    require('../main.js');
  } finally {
    Module._load = realLoad;
  }

  readyCallback();
  // 启动路径的预检是 void 触发：等 descriptor 交付完成再验证重启语义
  await waitFor(() => probeCalls >= 1 && instances.length >= 1 && instances[0].descriptor != null);

  // ── 评审 P1：重启连接必须恢复引擎 ──
  await handlers.get('restart-connection')();
  assert.equal(instances.length, 2, '必须真的重建 companion 实例');
  assert.equal(instances[0].stopped, true);
  assert.equal(probeCalls, 2, '重启后必须重跑 runtime 预检');
  assert.notEqual(instances[1].descriptor, null, '新实例必须拿到 descriptor');
  const snapshot = await handlers.get('get-snapshot')();
  assert.equal(snapshot.state, 'paired', '重启后不得停在 paired-no-model');
  assert.equal(snapshot.runtime.category, 'ready');

  // ── 评审 P2：写配置失败不阻断唤窗 ──
  failConfigWrites = true;
  const fullWin = FakeBrowserWindow.created[0];
  const showCallsBefore = fullWin.showCalls;
  await assert.doesNotReject(async () => { handlers.get('switch-mode')(null, 'full'); });
  assert.ok(configWriteAttempts >= 1, '形态持久化确实尝试过写盘');
  assert.equal(fullWin.showCalls, showCallsBefore + 1, '写失败后窗口必须照常显示');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function waitFor(check, timeoutMs = 2000) {
  for (let waited = 0; waited < timeoutMs; waited += 5) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('waitFor 超时');
}
