'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeGate } = require('../runtime-gate');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('旧配置检查迟到完成时不得启动新配置', async () => {
  const first = deferred();
  const probes = [];
  const starts = [];
  let stops = 0;
  const gate = createRuntimeGate({
    probe: (cfg) => { probes.push(cfg); return probes.length === 1 ? first.promise : Promise.resolve({ category: 'ready' }); },
    start: async (cfg) => { starts.push(cfg); },
    stop: async () => { stops += 1; },
    onStatus: () => {},
    onFailure: () => {},
  });

  const a = gate.check({ relayUrl: 'wss://a/ws', cwd: 'A' });
  await Promise.resolve();
  const b = gate.check({ relayUrl: 'wss://b/ws', cwd: 'B' });
  await b;
  first.resolve({ category: 'ready' });
  await a;

  assert.equal(stops, 2);
  assert.deepEqual(starts, [{ relayUrl: 'wss://b/ws', cwd: 'B' }]);
});

test('重新检查失败先停止旧 companion 且不重启', async () => {
  let running = true;
  const starts = [];
  const failures = [];
  const gate = createRuntimeGate({
    probe: async () => ({ category: 'version-failed', detailCode: 'EXIT_1' }),
    start: async (cfg) => { running = true; starts.push(cfg); },
    stop: async () => { running = false; },
    onStatus: () => {},
    onFailure: (status) => failures.push(status.category),
  });

  await gate.check({ relayUrl: 'wss://relay/ws', cwd: 'C' });
  assert.equal(running, false);
  assert.deepEqual(starts, []);
  assert.deepEqual(failures, ['version-failed']);
});
