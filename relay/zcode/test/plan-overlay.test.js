'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPlanOverlay, defaultPersonalConfigPath, writePlanOverlay,
  PLAN_PROVIDER_ID, PLAN_PROVIDER_NAME, PLAN_API, ACCOUNT_PROVIDER_ID,
  ACCOUNT_PROVIDER_NAME, ACCOUNT_DISPLAY_MODEL_IDS } = require('../lib/plan-overlay');

test('buildPlanOverlay 账号 provider：组名/模型/顺序对齐桌面，旧套餐规则清除', () => {
  const base = JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [
        // 桌面物化的账号规则（模型只剩 Flashx）+ 旧方案自建 provider 残留
        { providerId: 'account:bigmodel-individual-coding-plan',
          config: { personalModelIds: ['GLM-5.3-Flashx'],
            modelOrder: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flashx'] } },
        { providerId: 'custom:zcode-bigmodel-plan', config: { personalModelIds: ['glm-4.5'] } },
      ] },
      modelConfigRules: { providerModelRules: [
        { providerId: 'custom:zcode-bigmodel-plan', modelId: 'glm-4.5', config: { properties: {} } },
      ] },
    },
  });
  const overlay = buildPlanOverlay({
    baseRaw: base, modelIds: [...ACCOUNT_DISPLAY_MODEL_IDS], token: 'tok',
    providerId: ACCOUNT_PROVIDER_ID, providerName: ACCOUNT_PROVIDER_NAME,
  });
  const rules = overlay.config.providerConfigRules.providerRules;
  const account = rules.find((r) => r.providerId === ACCOUNT_PROVIDER_ID);
  assert.ok(account, '账号条目存在');
  assert.equal(account.providerName, ACCOUNT_PROVIDER_NAME, '组名与桌面一致');
  // 桌面 modelOrder 三模型补齐（base 只持久化了 Flashx）
  assert.deepEqual(account.config.personalModelIds, ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flashx']);
  assert.deepEqual(account.config.modelOrder, ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flashx']);
  assert.equal(account.config.access.type, 'api-key');
  assert.equal(account.config.access.apiKey, 'tok');
  assert.deepEqual(account.config.api, PLAN_API);
  assert.equal(rules.some((r) => r.providerId === 'custom:zcode-bigmodel-plan'), false,
    '旧自建 provider 规则清除，防双 BigModel 组并存');
  const accountModelRules = overlay.config.modelConfigRules.providerModelRules
    .filter((r) => r.providerId === ACCOUNT_PROVIDER_ID);
  assert.deepEqual(accountModelRules.map((r) => r.modelId),
    ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flashx']);
  assert.equal(overlay.config.modelConfigRules.providerModelRules
    .some((r) => r.providerId === 'custom:zcode-bigmodel-plan'), false, '旧模型规则清除');
});

test('buildPlanOverlay：追加规则不改既有条目；不带 enabled；模型规则逐条；幂等', () => {
  const base = JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [
        { providerId: 'imported:x:1', providerName: 'X', config: { personalModelIds: ['m1'] } },
      ] },
      modelConfigRules: { providerModelRules: [
        { providerId: 'imported:x:1', modelId: 'm1', config: { properties: {} } },
      ] },
    },
  });
  const overlay = buildPlanOverlay({ baseRaw: base, modelIds: ['glm-5.3', 'glm-5.3-flash'], token: 'tok' });
  const rules = overlay.config.providerConfigRules.providerRules;
  assert.equal(rules.filter((r) => r.providerId === 'imported:x:1').length, 1, '既有条目保留');
  const plan = rules.find((r) => r.providerId === PLAN_PROVIDER_ID);
  assert.ok(plan, '套餐条目存在');
  assert.equal(plan.providerName, PLAN_PROVIDER_NAME);  // 实测配方：条目带 enabled 字段会导致整个 provider 静默失效
  assert.equal('enabled' in plan, false);
  assert.deepEqual(plan.config.personalModelIds, ['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(plan.config.modelOrder, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(plan.config.access.type, 'api-key');
  assert.equal(plan.config.access.apiKey, 'tok');
  // 0.16.9 实测：api 字段必填（缺失 → provider 整体静默失效；type 非法 →
  // 整个个人配置文件被拒，连导入 provider 一起消失）
  assert.deepEqual(plan.config.api, PLAN_API);
  const pmr = overlay.config.modelConfigRules.providerModelRules;
  assert.equal(pmr.length, 3, '既有 1 条 + 新 2 条');
  assert.deepEqual(pmr.filter((r) => r.providerId === PLAN_PROVIDER_ID).map((r) => r.modelId),
    ['glm-5.3', 'glm-5.3-flash']);

  // 幂等：以 overlay 为基础重建不产生重复
  const again = buildPlanOverlay({ baseRaw: JSON.stringify(overlay), modelIds: ['glm-5.3'], token: 'tok' });
  assert.equal(again.config.providerConfigRules.providerRules
    .filter((r) => r.providerId === PLAN_PROVIDER_ID).length, 1);
  assert.equal(again.config.modelConfigRules.providerModelRules
    .filter((r) => r.providerId === PLAN_PROVIDER_ID).length, 1);
});

test('buildPlanOverlay：基础配置损坏时从空骨架起步；空模型列表显式拒绝', () => {
  const overlay = buildPlanOverlay({ baseRaw: '{broken', modelIds: ['m1'], token: 't' });
  assert.equal(overlay.schemaVersion, 1);
  assert.equal(overlay.config.providerConfigRules.providerRules.length, 1);
  assert.throws(() => buildPlanOverlay({ baseRaw: '{}', modelIds: [], token: 't' }),
    (e) => e.code === 'PLAN_NO_MODELS');
});

test('writePlanOverlay：原子落盘、内容一致、POSIX 下 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-overlay-'));
  const out = writePlanOverlay({ overlay: { a: 1 }, stateDir: dir });
  assert.equal(path.basename(out), 'personal-plan-overlay.json');
  assert.equal(fs.readFileSync(out, 'utf8'), '{"a":1}');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultPersonalConfigPath：env 优先，缺省 ~/.zcode/v2/provider_config.json', () => {
  assert.equal(defaultPersonalConfigPath({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:/x.json' }, '/h'), 'C:/x.json');
  assert.equal(defaultPersonalConfigPath({}, path.join('/h')),
    path.join('/h', '.zcode', 'v2', 'provider_config.json'));
});
