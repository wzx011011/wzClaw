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

function listNames(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').slice(0, 100)
    : [];
}

function readJsonFile(fsApi, filePath, { allowArray = false } = {}) {
  if (!isRegularFile(fsApi, filePath)) return { status: 'missing' };
  try {
    if (fsApi.statSync(filePath).size > MAX_CONFIG_BYTES) return { status: 'too-large' };
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || (!allowArray && Array.isArray(value))) {
      return { status: 'invalid' };
    }
    return { status: 'ok', value };
  } catch {
    return { status: 'invalid' };
  }
}

function resolveZcodeInstallation({ env = process.env, fsApi = fs, platform = process.platform, bundledRuntime = null } = {}) {
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    ['environment', env.ZCODE_BIN],
    ['installed', platform === 'win32' && localAppData
      ? path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
      : null],
    // Companion 安装包内嵌 runtime（extraResources）；官方安装存在时永远优先
    ['bundled', bundledRuntime],
  ];
  for (const [source, candidate] of candidates) {
    if (typeof candidate === 'string' && candidate.length && isRegularFile(fsApi, candidate)) {
      return { status: 'found', source, command: candidate };
    }
  }
  // PATH 只能证明“可能可调用”，首启页必须如实标记为未验证安装。
  return { status: 'not-found', source: null, command: null };
}

// 打包态内嵌 runtime 路径（resources/zcode-runtime/glm/zcode.cjs）。
// resourcesPath 由 Electron 主进程提供；非打包环境传 null。
function bundledRuntimePath(resourcesPath) {
  if (!resourcesPath) return null;
  return path.join(resourcesPath, 'zcode-runtime', 'glm', 'zcode.cjs');
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

// ---- 导入清单（只读扫描，产出可勾选的脱敏项） ----

// v2/setting.json 里允许导入的偏好键白名单。schema 未进任何契约的键
// 一律不导入（宁可显示「不支持」，不假装导入成功）。
const PREFERENCE_ALLOWLIST = [
  'locale',
  'terminalInheritSystemProfile',
  'taskAutoArchiveEnabled',
  'taskAutoArchiveOlderThanDays',
  'keepAwakeWhileRunning',
  'messageStreamShowReasoning',
  'messageStreamShowTodos',
  'nativeSearchEnhancementsEnabled',
  'closeToTrayOnWindows',
  'computerUseComposerEntryHidden',
];

const MAX_WORKSPACES = 50;

// v2/model-providers.json 的实测形状（2026-09-16 本机）：
// [{id,name,endpoints,apiKey,models:[模型ID字符串],providerMappings,...}]
// apiKey 是凭据本体，只允许导出「是否存在」布尔，值绝不离开本模块边界。
function extractProviderCatalog(value) {
  if (!Array.isArray(value)) return { providers: [], warning: 'model-providers.json 结构异常，已跳过' };
  const providers = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) continue;
    const modelIds = Array.isArray(raw.models)
      ? raw.models.filter((m) => typeof m === 'string' && m.length > 0).slice(0, 200)
      : [];
    providers.push({
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      hasCredential: typeof raw.apiKey === 'string' && raw.apiKey.length > 0,
      modelIds,
    });
  }
  return { providers };
}

function extractRecentWorkspaces(settingValue) {
  if (!settingValue || typeof settingValue !== 'object') return [];
  const raw = settingValue.recentProjects;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_WORKSPACES) break;
  }
  return out;
}

function extractPreferences(settingValue) {
  if (!settingValue || typeof settingValue !== 'object') return {};
  const prefs = {};
  for (const key of PREFERENCE_ALLOWLIST) {
    const value = settingValue[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      prefs[key] = value;
    }
  }
  return prefs;
}

// 汇总四类可导入内容。全部来自本机文件的脱敏投影：
// 模型目录（不含 key）、最近工作区路径、白名单偏好、扩展名摘要。
// 会话不在此列：会话列表由引擎连接后经 session/list 实时提供，
// 静态拷贝会过期误导，且会话文件格式不是稳定契约。
function buildImportManifest(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const fsApi = options.fsApi || fs;
  const warnings = [];

  const cli = readJsonFile(fsApi, path.join(homeDir, '.zcode', 'cli', 'config.json'));
  const v2 = readJsonFile(fsApi, path.join(homeDir, '.zcode', 'v2', 'config.json'));
  const setting = readJsonFile(fsApi, path.join(homeDir, '.zcode', 'v2', 'setting.json'));
  // model-providers.json 顶层是数组（实测形状），普通配置读取器会拒数组
  const modelProviders = readJsonFile(fsApi,
    path.join(homeDir, '.zcode', 'v2', 'model-providers.json'), { allowArray: true },);

  const catalog = modelProviders.status === 'ok'
    ? extractProviderCatalog(modelProviders.value)
    : { providers: [] };
  if (modelProviders.status !== 'ok') {
    warnings.push(`模型目录读取失败（${modelProviders.status}），模型类为空`);
  }
  if (catalog.warning) warnings.push(catalog.warning);

  // 兜底：model-providers.json 缺失时从 v2 config 的 provider 名单补名字
  let providers = catalog.providers;
  if (!providers.length && v2.status === 'ok' && v2.value.provider && typeof v2.value.provider === 'object') {
    providers = Object.entries(v2.value.provider)
      .filter(([, raw]) => raw && typeof raw === 'object')
      .map(([id, raw]) => ({
        id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : id,
        hasCredential: false,
        modelIds: [],
      }));
    if (providers.length) warnings.push('model-providers.json 不可用，已退回 v2 配置的 provider 名单（无模型明细）');
  }

  const cliValue = cli.status === 'ok' ? cli.value : {};
  const extensions = cli.status === 'ok'
    ? {
        skills: listNames(cliValue.skills),
        plugins: listNames(cliValue.plugins),
        commands: listNames(cliValue.commands),
        mcpCount: cliValue.mcp && typeof cliValue.mcp === 'object' ? Object.keys(cliValue.mcp).length : 0,
      }
    : { skills: [], plugins: [], commands: [], mcpCount: 0 };
  if (cli.status !== 'ok') warnings.push(`CLI 配置读取失败（${cli.status}），扩展类为空`);

  return {
    models: {
      selectedModel: typeof cliValue.model === 'string' ? cliValue.model : null,
      providers,
    },
    workspaces: extractRecentWorkspaces(setting.value),
    preferences: extractPreferences(setting.value),
    extensions,
    warnings,
  };
}

module.exports = {
  MAX_CONFIG_BYTES,
  PREFERENCE_ALLOWLIST,
  resolveZcodeInstallation,
  bundledRuntimePath,
  inspectZcodeConfiguration,
  detectZcode,
  normalizeImportSelection,
  buildImportManifest,
};
