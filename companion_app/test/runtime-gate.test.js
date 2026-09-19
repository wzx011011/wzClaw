'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeGate } = require('../runtime-gate');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('旧配置检查迟到完成时不得交付给新配置', async () => {
  const first = deferred();
  const probes = [];
  const applies = [];
  const gate = createRuntimeGate({
    probe: (cfg) => {
      probes.push(cfg);
      return probes.length === 1 ? first.promise : Promise.resolve({ category: 'ready', runtimeDescriptor: { command: 'n', args: ['b'], source: 'installed' } });
    },
    apply: async (d) => { applies.push(d); },
    onStatus: () => {},
    onFailure: () => {},
  });

  const a = gate.check({ relayUrl: 'wss://a/ws', cwd: 'A' });
  await Promise.resolve();
  const b = gate.check({ relayUrl: 'wss://b/ws', cwd: 'B' });
  await b;
  first.resolve({ category: 'ready', runtimeDescriptor: { command: 'old', args: ['x'], source: 'installed' } });
  await a;

  assert.equal(applies.length, 1); // 只有新配置的检查交付
});

test('ready 的 descriptor 交付给 apply；失败走 onFailure 且不交付', async () => {
  const applies = [];
  const failures = [];
  const descriptor = Object.freeze({ command: 'ZCode.exe', args: ['zcode.cjs'], source: 'installed' });
  let flip = false;
  const gate = createRuntimeGate({
    probe: async () => (flip
      ? { category: 'version-failed', source: 'installed', version: null, detailCode: 'EXIT_1' }
      : { category: 'ready', runtimeDescriptor: descriptor }),
    apply: async (d) => { applies.push(d); },
    onStatus: () => {},
    onFailure: (status) => failures.push(status.category),
  });

  await gate.check({ relayUrl: 'wss://relay/ws', cwd: 'C' });
  assert.deepEqual(applies, [descriptor]);
  assert.deepEqual(failures, []);

  // 预检失败：不交付，也不触碰控制面（gate 没有 stop/start 概念——
  // 设备在线由宿主管理，引擎失败只报状态）。
  flip = true;
  await gate.check({ relayUrl: 'wss://relay/ws', cwd: 'C' });
  assert.equal(applies.length, 1);
  assert.deepEqual(failures, ['version-failed']);
});

test('ready 但缺 descriptor 必须按失败处理而非静默跳过', async () => {
  const applies = [];
  const failures = [];
  const gate = createRuntimeGate({
    probe: async () => ({ category: 'ready', runtimeDescriptor: undefined }),
    apply: async (d) => { applies.push(d); },
    onStatus: () => {},
    onFailure: (status) => failures.push(status),
  });

  await gate.check({ relayUrl: 'wss://relay/ws', cwd: 'C' });
  assert.deepEqual(applies, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].detailCode, 'BAD_DESCRIPTOR');
});
