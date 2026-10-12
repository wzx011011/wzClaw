'use strict';

// companion 链路保活与协议卫生测试：需要一个「可注入畸形帧」的假 relay
// （真 relay 不会发非法 auth_ack，这类缺陷因此曾长期潜伏——见
// companion.js auth_ack 分支的僵尸链路修复）。同时覆盖自发 ping。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { createCompanion } = require('../companion');

function cleanup(t, steps) {
  t.after(async () => {
    for (const step of steps) await step();
  });
}

function waitFor(getValue, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (getValue()) { clearInterval(timer); resolve(getValue()); }
    }, 20);
    setTimeout(() => { clearInterval(timer); reject(new Error('waitFor timeout')); }, timeoutMs).unref();
  });
}

/** 假 relay：可脚本化每一帧的应答；记录 register_init 次数与收到的 ping */
function fakeRelay(script) {
  const state = { registerInits: 0, pings: 0, connections: 0, authResponses: 0 };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const urlPromise = new Promise((resolve) => {
    wss.on('listening', () => resolve(`ws://127.0.0.1:${wss.address().port}/ws`));
  });
  wss.on('connection', (conn) => {
    state.connections += 1;
    conn.on('ping', () => { state.pings += 1; });
    conn.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'device_register_init') {
        state.registerInits += 1;
        conn.send(JSON.stringify({ type: 'device_register_ack', device_sid: 'sid-fake' }));
        return;
      }
      if (msg.type === 'auth_init') {
        conn.send(JSON.stringify({ type: 'auth_challenge', nonce: 'nonce-fake' }));
        return;
      }
      if (msg.type === 'auth_response') {
        script.onAuthResponse(conn, state);
      }
    });
  });
  return {
    url: urlPromise,
    state,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

function makeCompanion(relayUrl, logs, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-link-'));
  const companion = createCompanion({
    relayUrl,
    cwd: dir,
    zcodeCommand: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    v2ConfigPath: (() => {
      const f = path.join(dir, 'v2.json');
      // readModelAuth 只认 builtin:bigmodel-coding-plan 这个 provider 键
      fs.writeFileSync(f, JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': { options: { apiKey: 'k', baseURL: 'https://x' } },
        },
      }));
      return f;
    })(),
    midFile: path.join(dir, 'mid'),
    logger: (event, detail) => logs.push(`${event}${detail ? ` ${detail}` : ''}`),
    ...overrides,
  });
  return {
    companion,
    cleanup: async () => {
      await companion.stop();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('非法 auth_ack（未知 pair_status）必须关连接重连，不留僵尸已认证链路', async (t) => {
  // 第一次 auth_response 发垃圾 pair_status；重连接管（不重注册！）后的
  // 第二次发合法 matched——若关闭/重连/接管任一环断了就会卡死
  const relay = fakeRelay({
    onAuthResponse(conn, state) {
      state.authResponses += 1;
      if (state.authResponses <= 1) {
        conn.send(JSON.stringify({ type: 'auth_ack', pair_status: 'garbage' }));
      } else {
        conn.send(JSON.stringify({ type: 'auth_ack', pair_status: 'matched' }));
      }
    },
  });
  const logs = [];
  const url = await relay.url;
  const { companion, cleanup: done } = makeCompanion(url, logs, {
    reconnectDelayMs: 150,
    onStateChange: (s) => logs.push(`state:${s}`),
  });
  cleanup(t, [done, () => relay.close()]);
  companion.start();

  // 垃圾 ack 触发 conn.close() → 重连接管 → 第二次 auth_response 合法 → paired
  await waitFor(() => logs.some((l) => l.startsWith('state:paired')), 4000).catch((e) => {
    console.log('DBG-LINK', JSON.stringify({ ...relay.state, logs }));
    throw e;
  });
  assert.ok(relay.state.authResponses >= 2);
  assert.equal(relay.state.connections >= 2, true);
});

test('自发链路保活：按 linkPingMs 周期向 relay 发 ping', async (t) => {
  const relay = fakeRelay({
    onAuthResponse(conn) {
      conn.send(JSON.stringify({ type: 'auth_ack', pair_status: 'matched' }));
    },
  });
  const logs = [];
  const url = await relay.url;
  const { companion, cleanup: done } = makeCompanion(url, logs, { linkPingMs: 60 });
  cleanup(t, [done, () => relay.close()]);
  companion.start();

  // matched 后 ping 每隔 60ms 一发；500ms 足够积累多个
  await waitFor(() => relay.state.pings >= 3, 4000);
  assert.ok(relay.state.pings >= 3, `pings=${relay.state.pings}`);
});
