'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const TEST_PORT = 18765;
const TEST_TOKEN = 'test-secret-token';

/**
 * Helper: connect a WebSocket client and wait for it to open.
 * @param {string} path - Query string path (e.g., '?token=xxx&role=desktop')
 * @param {number} timeout - Connection timeout in ms
 * @returns {Promise<WebSocket>}
 */
function connectClient(path, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${path}`);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Helper: wait for a message on a WebSocket.
 * @param {WebSocket} ws
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<object>} Parsed JSON message
 */
function waitForMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Helper: wait for a WebSocket to close.
 * @param {WebSocket} ws
 * @param {number} timeout
 * @returns {Promise<{code: number, reason: string}>}
 */
function waitForClose(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Close timeout')), timeout);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Helper: wait for a non-system application message on a WebSocket.
 * Skips system:* events (system:desktop_connected, etc.).
 * @param {WebSocket} ws
 * @param {number} timeout
 * @returns {Promise<object>}
 */
function waitForAppMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App message timeout')), timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event && msg.event.startsWith('system:')) return; // skip system messages
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      } catch (e) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        reject(e);
      }
    };
    ws.on('message', handler);
  });
}

describe('Relay Integration Tests', () => {
  let serverModule;

  beforeEach(() => {
    // Set up environment for the server.
    process.env.AUTH_TOKEN = TEST_TOKEN;
    process.env.PORT = String(TEST_PORT);

    // Fresh require to pick up new env vars.
    delete require.cache[require.resolve('../server')];
    delete require.cache[require.resolve('../lib/auth')];
    serverModule = require('../server');
  });

  afterEach(async () => {
    // Clean up server.
    if (serverModule) {
      clearInterval(serverModule.statusInterval);
      serverModule.roomManager.closeAll();
      await new Promise((resolve) => {
        serverModule.wss.close(() => {
          serverModule.server.close(resolve);
        });
      });
    }
    delete process.env.AUTH_TOKEN;
    delete process.env.PORT;
  });

  it('rejects connection without token with code 4001', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/`);
    const closeEvent = await waitForClose(ws);
    assert.equal(closeEvent.code, 4001);
    assert.equal(closeEvent.reason, 'missing token');
  });

  it('rejects connection with wrong token with code 4001', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=wrong-token&role=mobile`);
    const closeEvent = await waitForClose(ws);
    assert.equal(closeEvent.code, 4001);
    assert.equal(closeEvent.reason, 'invalid token');
  });

  it('accepts desktop and mobile with correct token and forwards messages', async () => {
    // Connect desktop.
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Connect mobile.
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Desktop sends connected event -> mobile receives it.
    desktop.send(JSON.stringify({ event: 'connected', data: { status: 'ok' } }));
    const msg1 = await waitForAppMessage(mobile);
    assert.equal(msg1.event, 'connected');
    assert.deepEqual(msg1.data, { status: 'ok' });

    // Mobile sends command -> desktop receives it.
    mobile.send(JSON.stringify({ event: 'command:send', data: { content: 'hello' } }));
    const msg2 = await waitForAppMessage(desktop);
    assert.equal(msg2.event, 'command:send');
    assert.deepEqual(msg2.data, { content: 'hello' });

    // Clean up.
    desktop.close();
    mobile.close();
  });

  it('does not forward ping messages to the other side', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Drain system messages first (more events now with desktop_list/mobile_list).
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Attach listeners AFTER draining system messages.
    const received = [];
    mobile.on('message', (data) => received.push(data.toString()));
    desktop.on('message', (data) => received.push(data.toString()));

    // Desktop sends ping.
    desktop.send(JSON.stringify({ event: 'ping' }));

    // Mobile sends pong.
    mobile.send(JSON.stringify({ event: 'pong' }));

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Filter out system messages for the assertion.
    const nonSystem = received
      .map(r => {
        try {
          return JSON.parse(r);
        } catch {
          return null;
        }
      })
      .filter(msg => msg && !String(msg.event || '').startsWith('system:') && msg.event !== 'pong');
    assert.equal(nonSystem.length, 0, 'No non-system messages should have been forwarded');

    desktop.close();
    mobile.close();
  });

  it('ignores non-JSON messages without crashing', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Drain system messages.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send non-JSON.
    desktop.send('this is not json');

    // Wait briefly.
    const received = [];
    mobile.on('message', (data) => received.push(data.toString()));

    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(received.length, 0, 'Non-JSON should be ignored');

    // Server should still be functional: send a valid message.
    desktop.send(JSON.stringify({ event: 'connected', data: {} }));
    const msg = await waitForAppMessage(mobile);
    assert.equal(msg.event, 'connected');

    desktop.close();
    mobile.close();
  });

  it('notifies mobile with system:desktop_disconnected when desktop closes', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Drain system messages from connection.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close desktop.
    desktop.close();

    // Mobile should receive system notification.
    const msg = await waitForMessage(mobile);
    assert.equal(msg.event, 'system:desktop_disconnected');

    mobile.close();
  });

  it('notifies desktop with system:mobile_disconnected when mobile closes', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Drain system messages from connection.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close mobile.
    mobile.close();

    // Desktop should receive mobile_list + mobile_disconnected.
    const msgs = [];
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      desktop.on('message', (data) => {
        try { msgs.push(JSON.parse(data.toString())); } catch (_) {}
        if (msgs.some(m => m.event === 'system:mobile_disconnected')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.ok(msgs.some(m => m.event === 'system:mobile_disconnected'),
      `Expected system:mobile_disconnected in ${msgs.map(m => m.event)}`);

    desktop.close();
  });

  it('multiple desktops coexist and broadcast to mobiles', async () => {
    const desktop1 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Connect a second desktop — both should coexist.
    const desktop2 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Neither desktop should be closed.
    assert.equal(desktop1.readyState, WebSocket.OPEN);
    assert.equal(desktop2.readyState, WebSocket.OPEN);

    // Both desktops can send to mobile.
    desktop1.send(JSON.stringify({ event: 'test:from_d1', data: 'hello' }));
    const msg1 = await waitForAppMessage(mobile);
    assert.equal(msg1.event, 'test:from_d1');

    desktop2.send(JSON.stringify({ event: 'test:from_d2', data: 'world' }));
    const msg2 = await waitForAppMessage(mobile);
    assert.equal(msg2.event, 'test:from_d2');

    desktop1.close();
    desktop2.close();
    mobile.close();
  });

  it('defaults role to mobile when role param is missing', async () => {
    // Connect without role param.
    const client = await connectClient(`?token=${TEST_TOKEN}`);

    // Connect a desktop.
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Desktop sends message -> client (default mobile) receives it.
    desktop.send(JSON.stringify({ event: 'connected', data: {} }));
    const msg = await waitForAppMessage(client);
    assert.equal(msg.event, 'connected');

    desktop.close();
    client.close();
  });

  it('rejects invalid role with code 4003', async () => {
    const client = await connectClient(`?token=${TEST_TOKEN}&role=hacker`);
    const { code, reason } = await waitForClose(client);
    assert.equal(code, 4003);
    assert.match(reason, /invalid role/);
  });
});
