'use strict';

// 套餐模型 overlay：把 API 实时拉到的套餐模型清单物化进「个人 provider 配置
// 副本」，引擎 spawn 时经 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 注入，使独立
// runtime 原生可选套餐模型（glm-5.3-flash 等）——不依赖桌面端推送账号权益
// （provider/updateAccountConfig 对独立引擎不物化，2026-09-18 实测）。
// 实测配方（probe-personal-plan.js，全部字段均经真机引擎验证）：
// - providerRules 条目【不得带 enabled 字段】——带上整个 provider 静默失效；
// - personalModelIds/modelOrder = API 返回的模型 ID 原样（大小写敏感）；
// - 每模型一条 providerModelRules（config.properties 空对象即可），
//   label/ctx/reasoning 等元数据由 builtin release 的正则规则自动补全；
// - access 用 api-key + 套餐 token（计费随套餐 key 走）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLAN_PROVIDER_ID = 'custom:zcode-bigmodel-plan';
const PLAN_PROVIDER_NAME = 'BigModel';
const PLAN_MODELS_URL = 'https://open.bigmodel.cn/api/anthropic/v1/models';
const PLAN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时：套餐目录基本静态

// 拉套餐模型 ID 列表。token 即桌面登录态（与 ANTHROPIC_API_KEY 同源），
// 只经 header 注入，绝不打印/落日志。
async function fetchPlanModelIds({ token, fetchApi = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof token !== 'string' || !token) {
    throw Object.assign(new Error('plan token missing'), { code: 'PLAN_NO_TOKEN' });
  }
  let res;
  try {
    res = await fetchApi(PLAN_MODELS_URL, {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(`plan models fetch failed: ${error.message}`), { code: 'PLAN_FETCH_FAILED' });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`plan models http ${res.status}`), { code: `PLAN_HTTP_${res.status}` });
  }
  let json;
  try { json = await res.json(); } catch (error) {
    throw Object.assign(new Error('plan models bad json'), { code: 'PLAN_BAD_JSON' });
  }
  const ids = (Array.isArray(json.data) ? json.data : [])
    .map((m) => (m && typeof m.id === 'string' ? m.id : ''))
    .filter((id) => id.length);
  if (!ids.length) {
    throw Object.assign(new Error('plan models empty'), { code: 'PLAN_EMPTY' });
  }
  return ids;
}

// 在基础个人配置（文本）上合入套餐条目，返回 overlay 对象。
// baseRaw 缺失/损坏时从空骨架起步（此时导入 provider 会缺席——调用方应尽量
// 传入真实基础文件）。
function buildPlanOverlay({ baseRaw, modelIds, token, providerId = PLAN_PROVIDER_ID, providerName = PLAN_PROVIDER_NAME } = {}) {
  if (!Array.isArray(modelIds) || !modelIds.length) {
    throw Object.assign(new Error('overlay needs modelIds'), { code: 'PLAN_NO_MODELS' });
  }
  let overlay;
  try { overlay = baseRaw ? JSON.parse(baseRaw) : null; } catch { overlay = null; }
  if (!overlay || typeof overlay !== 'object') {
    overlay = { schemaVersion: 1, config: {} };
  }
  overlay.schemaVersion = 1;
  overlay.config = overlay.config && typeof overlay.config === 'object' ? overlay.config : {};
  const pcr = overlay.config.providerConfigRules = overlay.config.providerConfigRules
    && typeof overlay.config.providerConfigRules === 'object' ? overlay.config.providerConfigRules : {};
  pcr.providerRules = Array.isArray(pcr.providerRules) ? pcr.providerRules : [];
  pcr.providerRules = pcr.providerRules.filter((r) => r && r.providerId !== providerId);
  // 注意：条目不带 enabled 字段（实测配方）。
  pcr.providerRules.push({
    providerId,
    providerName,
    config: {
      group: 'standard-personal',
      personalModelIds: [...modelIds],
      modelOrder: [...modelIds],
      access: { type: 'api-key', apiKey: token },
    },
  });
  const mcr = overlay.config.modelConfigRules = overlay.config.modelConfigRules
    && typeof overlay.config.modelConfigRules === 'object' ? overlay.config.modelConfigRules : {};
  mcr.providerModelRules = Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : [];
  mcr.providerModelRules = mcr.providerModelRules.filter((r) => r && r.providerId !== providerId);
  for (const modelId of modelIds) {
    mcr.providerModelRules.push({ providerId, modelId, config: { properties: {} } });
  }
  return overlay;
}

// 引擎读取个人配置的解析顺序：显式 env 优先，否则桌面默认路径。
function defaultPersonalConfigPath(env = process.env, homeDir = os.homedir()) {
  return (env && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)
    || path.join(homeDir, '.zcode', 'v2', 'provider_config.json');
}

// overlay 原子落盘（0600，含套餐 key，凭据纪律与 relay-secret 同级）。
function writePlanOverlay({ overlay, stateDir }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const out = path.join(stateDir, 'personal-plan-overlay.json');
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(overlay), { mode: 0o600 });
  fs.renameSync(tmp, out);
  return out;
}

module.exports = {
  PLAN_PROVIDER_ID, PLAN_PROVIDER_NAME, PLAN_MODELS_URL, PLAN_CACHE_TTL_MS,
  fetchPlanModelIds, buildPlanOverlay, defaultPersonalConfigPath, writePlanOverlay,
};
