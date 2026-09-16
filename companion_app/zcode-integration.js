'use strict';

// ZCode 安装与配置发现只在主进程运行。这个模块刻意只产出脱敏摘要：
// 凭据的内容、长度、字段名和原始配置都不得离开本机文件访问边界。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_BYTES = 1024 * 1024;

function isRegularFile(fsApi, filePath) {
  try { return fsApi.statSync(filePath).isFile(); } catch { return false; }
}

function readJsonFile(fsApi, filePath) {
  if (!isRegularFile(fsApi, filePath)) return { status: 'missing' };
  try {
    if (fsApi.statSync(filePath).size > MAX_CONFIG_BYTES) return { status: 'too-large' };
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
    return { status: 'ok', value };
  } catch {
    return { status: 'invalid' };
  }
}

function resolveZcodeInstallation({ env = process.env, fsApi = fs, platform = process.platform } = {}) {
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    ['environment', env.ZCODE_BIN],
    ['installed', platform === 'win32' && localAppData
      ? path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
      : null],
  ];
  for (const [source, candidate] of candidates) {
    if (typeof candidate === 'string' && candidate.length && isRegularFile(fsApi, candidate)) {
      return { status: 'found', source, command: candidate };
    }
  }
  // PATH 只能证明“可能可调用”，首启页必须如实标记为未验证安装。
  return { status: 'not-found', source: null, command: null };
}

function inspectZcodeConfiguration({ fsApi = fs, homeDir = os.homedir() } = {}) {
  const root = path.join(homeDir, '.zcode');
  const cliPath = path.join(root, 'cli', 'config.json');
  const v2Path = path.join(root, 'v2', 'config.json');
  const cli = readJsonFile(fsApi, cliPath);
  const v2 = readJsonFile(fsApi, v2Path);

  const providers = [];
  if (v2.status === 'ok' && v2.value.provider && typeof v2.value.provider === 'object') {
    for (const [id, raw] of Object.entries(v2.value.provider)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const options = raw.options && typeof raw.options === 'object' ? raw.options : {};
      providers.push({
        id,
        name: typeof raw.name === 'string' ? raw.name : id,
        enabled: raw.enabled !== false,
        hasCredential: Object.keys(options).some((key) => /(?:key|token|secret|password|credential)/i.test(key)
          && typeof options[key] === 'string' && options[key].length > 0),
      });
    }
  }

  const cliValue = cli.status === 'ok' ? cli.value : {};
  const listNames = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').slice(0, 100)
    : [];
  const metadata = {
    status: cli.status === 'ok' || v2.status === 'ok' ? 'compatible'
      : (cli.status === 'missing' && v2.status === 'missing' ? 'missing' : 'invalid'),
    providers,
    activeModel: typeof cliValue.model === 'string' ? cliValue.model : null,
    skills: listNames(cliValue.skills),
    plugins: listNames(cliValue.plugins),
    commands: listNames(cliValue.commands),
    mcpCount: cliValue.mcp && typeof cliValue.mcp === 'object' ? Object.keys(cliValue.mcp).length : 0,
  };
  const credentialStatus = providers.some((provider) => provider.hasCredential)
    ? 'available'
    : (v2.status === 'missing' ? 'not-signed-in' : v2.status === 'ok' ? 'not-signed-in' : 'unreadable');
  return { metadata, credentials: { status: credentialStatus } };
}

function detectZcode(options = {}) {
  const installation = resolveZcodeInstallation(options);
  const configuration = inspectZcodeConfiguration(options);
  return { installation, ...configuration };
}

function normalizeImportSelection(input) {
  const selected = input && input.selection && typeof input.selection === 'object' ? input.selection : {};
  return {
    modelMetadata: selected.modelMetadata !== false,
    preferences: selected.preferences !== false,
    workspaces: selected.workspaces === true,
    extensions: selected.extensions === true,
  };
}

module.exports = { MAX_CONFIG_BYTES, resolveZcodeInstallation, inspectZcodeConfiguration, detectZcode, normalizeImportSelection };
