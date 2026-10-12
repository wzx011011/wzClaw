'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zc = require('../vendor/zcode-protocol.cjs');

// vendor 契约层自动化锚（scripts/build-zcode-protocol.mjs 第 4 步宣称的
// 「npm test 含 vendor 契约测试」由此兑现）：方法表/通知表/schema 三类
// 导出可用性钉死，bundle 损坏或误删导出时 npm test 直接有声。

test('vendor 契约层：方法表/通知表关键项存在，schema 可 parse', () => {
  // 关键方法名抽查：relay/companion/手机端契约依赖的实测面
  const methods = zc.zcodeProtocolMethods;
  for (const key of ['sessionRequestRuntimePreferences', 'interactionRequestPermission',
    'interactionRequestUserInput', 'sessionList', 'sessionSubscribe', 'sessionFork',
    'sessionSetThoughtLevel', 'skillsReferenceCatalog']) {
    assert.equal(typeof methods[key], 'string', `methods.${key} 必须是字符串方法名`);
  }
  assert.equal(methods.sessionRequestRuntimePreferences, 'session/requestRuntimePreferences');
  assert.equal(methods.sessionFork, 'session/fork');

  // host 控制面通知词汇表：companion 的转发过滤据此判定——内容必须钉住
  const notifications = Object.values(zc.zcodeProtocolNotifications);
  for (const expected of ['startup/storageState', 'process/mcpTelemetry']) {
    assert.ok(notifications.includes(expected), `notifications 必须含 ${expected}`);
  }
  // 会话事件流方法绝不能混进控制面通知表（否则过滤会吞掉手机端核心事件流）
  for (const n of notifications) {
    assert.ok(!n.startsWith('session/'), `控制面通知不得含会话流方法: ${n}`);
  }

  // strict schema 可 parse（companion 加载期对 RUNTIME_PREFERENCES_RESULT
  // 的同款断言；bundle 损坏时 companion require 即抛，这里是独立复核）
  const parsed = zc.zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });
  assert.equal(parsed.nativeSearchEnhancementsEnabled, false);
  assert.equal(parsed.memoryEnabled, false);
});
