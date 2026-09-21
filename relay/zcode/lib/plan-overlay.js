'use strict';

// 模型目录 overlay：把「BigModel 个人」账号 provider（与桌面端同组名/同模型/
// 同顺序）物化进「个人 provider 配置副本」，引擎 spawn 时经
// ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 注入，使独立 runtime 的模型组与桌面端
// 完全一致——不依赖桌面端推送账号权益（provider/updateAccountConfig 对独立
// 引擎不物化，2026-09-18 实测）。
// 2026-09-21 改版：直接注入桌面同款账号 provider（account:bigmodel-individual-
// coding-plan，GLM-5.3 / GLM-5.3-Flash / GLM-5.3-Flashx，大小写与桌面一致，
// 端点实测服务大写 ID），取代旧的「API 拉清单 + custom provider」方案——
// 顺带消灭冷启动竞态（旧方案要等 API 拉取完成才注入，手机先到引擎就裸跑，
// 目录整体缺套餐模型）。
// 实测配方（probe-personal-plan.js，全部字段均经真机引擎验证）：
// - providerRules 条目【不得带 enabled 字段】——带上整个 provider 静默失效；
// - personalModelIds/modelOrder = 模型 ID 原样（大小写敏感）；
// - 每模型一条 providerModelRules（config.properties 空对象即可），
//   label/ctx/reasoning 等元数据由 builtin release 的正则规则自动补全；
// - access 用 api-key + 套餐 token（计费随套餐 key 走）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 旧方案的自建 provider（2026-09-21 起废弃）：保留常量仅为 overlay 构建时
// 清除历史残留规则，防止新旧两个 BigModel 组并存。
const PLAN_PROVIDER_ID = 'custom:zcode-bigmodel-plan';
const PLAN_PROVIDER_NAME = 'BigModel';

// 0.16.9 实测（probe-modeldefault --overlay 二分）：providerRule 必须带
// api.{type,baseUrl}，否则该 provider 整体静默失效（目录里一个模型都不
// 出现）；api.type 非法更狠——整个个人配置文件被拒，连导入 provider 一起
// 消失。合法 type 枚举：anthropic-messages | openai-chat-completions |
// openai-responses。计费端点 = 套餐 key 的 Anthropic 兼容端点。
const PLAN_API = {
  type: 'anthropic-messages',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
};

// 桌面端「BigModel 个人」组的同款投影：组名/模型/顺序对齐桌面选择器
// （GLM-5.3 / GLM-5.3-Flash / GLM-5.3-Flashx，小写 ID 为套餐 API 空间，
// 生产实测可服务；显示 label 由 builtin 正则规则自动补全为桌面同款大小写）。
// 计划模型变更时更新此列表即可。
const PLAN_DISPLAY_MODEL_IDS = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'];
const PLAN_DISPLAY_PROVIDER_NAME = 'BigModel 个人';

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
  // 目标 provider 的旧规则替换掉；旧方案自建 provider（custom:zcode-*）一并
  // 清除，防止升级后「BigModel 个人」与历史「BigModel」两组并存。
  pcr.providerRules = pcr.providerRules.filter((r) => r && r.providerId !== providerId
    && r.providerId !== PLAN_PROVIDER_ID);
  // 注意：条目不带 enabled 字段（实测配方）；api 字段 0.16.9 起必填。
  pcr.providerRules.push({
    providerId,
    providerName,
    config: {
      group: 'standard-personal',
      personalModelIds: [...modelIds],
      modelOrder: [...modelIds],
      api: { ...PLAN_API },
      // account:* 固定 provider 禁止携带 access（schema superRefine 硬约束：
      // 「固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明」，
      // 违规 = 整份个人配置被拒、目录归零——2026-09-21 实测踩坑）。账号认证
      // 由引擎读用户 zhipu 登录态解析；非 account provider 保留 api-key 注入。
      ...(providerId.startsWith('account:') ? {} : { access: { type: 'api-key', apiKey: token } }),
    },
  });
  const mcr = overlay.config.modelConfigRules = overlay.config.modelConfigRules
    && typeof overlay.config.modelConfigRules === 'object' ? overlay.config.modelConfigRules : {};
  mcr.providerModelRules = Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : [];
  mcr.providerModelRules = mcr.providerModelRules.filter((r) => r && r.providerId !== providerId
    && r.providerId !== PLAN_PROVIDER_ID);
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
  PLAN_PROVIDER_ID, PLAN_PROVIDER_NAME, PLAN_API,
  PLAN_DISPLAY_MODEL_IDS, PLAN_DISPLAY_PROVIDER_NAME,
  buildPlanOverlay, defaultPersonalConfigPath, writePlanOverlay,
};
