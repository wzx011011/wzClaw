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
  const installedHost = platform === 'win32' && localAppData
    ? path.join(localAppData, 'Programs', 'ZCode', 'ZCode.exe') : null;
  const bundled = env.WZXCLAW_BUNDLED_RUNTIME || bundledRuntimePath(resourcesPath);
  const commandForRuntime = () => electron && installedHost && isFile(fsApi, installedHost)
    ? installedHost : execPath;

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

function installationSummary(resolved) {
  if (!resolved || resolved.category !== 'resolved' || resolved.source === 'path') {
    return { status: 'not-found', source: null };
  }
  return { status: 'found', source: resolved.source };
}

module.exports = { bundledRuntimePath, resolveZcodeRuntime, publicRuntimeDescriptor, installationSummary };
