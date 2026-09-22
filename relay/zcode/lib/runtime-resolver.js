'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isFile(fsApi, filePath) {
  try { return fsApi.statSync(filePath).isFile(); } catch { return false; }
}

function bundledRuntimePath(resourcesPath) {
  return resourcesPath ? path.join(resourcesPath, 'zcode-runtime', 'glm', 'zcode.cjs') : null;
}

function resolveZcodeRuntime({ env = process.env, fsApi = fs, platform = process.platform,
  execPath = process.execPath, electron = process.versions.electron,
  resourcesPath = process.resourcesPath } = {}) {
  const localAppData = env.LOCALAPPDATA || '';
  const installedRuntime = platform === 'win32' && localAppData
    ? path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs') : null;
  const bundled = env.WZXCLAW_BUNDLED_RUNTIME || bundledRuntimePath(resourcesPath);
  // 宿主一律自托管：当前进程 exe 的 Node 模式（Electron 壳为 E41，含
  // node:sqlite；node CLI 即 node 自身）。不再用官方 ZCode.exe 当宿主——
  // 它作为 Electron 父进程的子进程会静默 exit 1（2026-09-17 GUI 预检事故，
  // stderr/stdout 全空、重试均复现），作为 node 父进程的子进程又要求桌面端
  // 专门注入的 ZCODE_* 环境才可用。自托管与 bundled 形态同路，行为最可预测。
  const commandForRuntime = () => execPath;

  if (env.ZCODE_BIN) {
    if (!isFile(fsApi, env.ZCODE_BIN)) return { category: 'invalid-override' };
    return { category: 'resolved', source: 'environment', command: commandForRuntime(), args: [env.ZCODE_BIN] };
  }
  if (installedRuntime && isFile(fsApi, installedRuntime)) {
    return { category: 'resolved', source: 'installed', command: commandForRuntime(), args: [installedRuntime] };
  }
  if (bundled && isFile(fsApi, bundled)) {
    return { category: 'resolved', source: 'bundled', command: execPath, args: [bundled] };
  }
  return { category: 'resolved', source: 'path', command: 'zcode', args: [] };
}

function publicRuntimeDescriptor(resolved) {
  if (!resolved || resolved.category !== 'resolved') return null;
  return Object.freeze({ command: resolved.command, args: [...resolved.args], source: resolved.source });
}

module.exports = { bundledRuntimePath, resolveZcodeRuntime, publicRuntimeDescriptor };
