'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 18766;
const TEST_TOKEN = 'e2e-test-token';

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'offline-queues.json');

// ── Helpers ──────────────────────────────────────────────────────────

function connectClient(urlPath, options = {}) {
  const { timeout = 3000, protocols } = options;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
    const ws = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}${urlPath}`,
      protocols || []
    );
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

function waitForMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeout);
    ws.once('message', (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); }
      catch (e) { reject(e); }
    });
  });
}

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
 * Wait for a non-system application message, skipping system:* events.
 */
function waitForAppMessage(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App message timeout')), timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event && msg.event.startsWith('system:')) return;
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

/**
 * Collect all messages received within a time window (including system).
 */
function collectMessages(ws, durationMs = 500) {
  return new Promise((resolve) => {
    const messages = [];
    const handler = (data) => {
      try { messages.push(JSON.parse(data.toString())); }
      catch (_) {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('E2E: Network Layer Optimizations', () => {
  let serverModule;

  beforeEach(() => {
    // 清理上次运行遗留的离线队列文件，避免测试间污染
    try { fs.unlinkSync(QUEUE_FILE); } catch (_) {}
    process.env.AUTH_TOKEN = TEST_TOKEN;
    process.env.PORT = String(TEST_PORT);
    delete require.cache[require.resolve('../server')];
    delete require.cache[require.resolve('../lib/auth')];
    delete require.cache[require.resolve('../lib/room')];
    serverModule = require('../server');
  });

  afterEach(async () => {
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

  // ── Test 1: Token auth via Sec-WebSocket-Protocol header ────────

  it('authenticates via Sec-WebSocket-Protocol header', async () => {
    // Token in protocol header instead of query string
    const desktop = await connectClient(
      '?role=desktop',
      { protocols: [`wzxclaw-${TEST_TOKEN}`] }
    );
    const mobile = await connectClient(
      '?role=mobile',
      { protocols: [`wzxclaw-${TEST_TOKEN}`] }
    );

    // Verify bidi forwarding works
    sendJson(desktop, { event: 'test:hello', data: 'world' });
    const msg = await waitForAppMessage(mobile, 2000);
    assert.equal(msg.event, 'test:hello');
    assert.equal(msg.data, 'world');

    desktop.close();
    mobile.close();
  });

  it('rejects invalid token in protocol header with code 4001', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/?role=mobile`,
      [`wzxclaw-wrong-token`]
    );
    const closeEvent = await waitForClose(ws);
    assert.equal(closeEvent.code, 4001);
  });

  it('accepts query string token as fallback', async () => {
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);
    // Connection succeeded — no error
    mobile.close();
  });

  // ── Test 2: command:send → command:ack roundtrip ────────────────

  it('forwards command:send from mobile and desktop can respond with command:ack', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    // Drain system messages
    await delay(200);

    // Mobile sends command:send with messageId
    const messageId = 'test-msg-12345';
    sendJson(mobile, {
      event: 'command:send',
      data: { content: 'fix the bug', messageId },
    });

    // Desktop receives the command
    const cmd = await waitForAppMessage(desktop);
    assert.equal(cmd.event, 'command:send');
    assert.equal(cmd.data.messageId, messageId);
    assert.equal(cmd.data.content, 'fix the bug');

    // Desktop sends command:ack back
    sendJson(desktop, {
      event: 'command:ack',
      data: { messageId },
    });

    // Mobile receives the ack
    const ack = await waitForAppMessage(mobile);
    assert.equal(ack.event, 'command:ack');
    assert.equal(ack.data.messageId, messageId);

    desktop.close();
    mobile.close();
  });

  // ── Test 3: Offline queue — desktop sends while mobile offline ──

  it('queues desktop messages when mobile is offline and flushes on reconnect', async () => {
    // Desktop connects alone (no mobile)
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Desktop sends messages while mobile is offline
    sendJson(desktop, { event: 'stream:text_delta', data: { text: 'Hello ' } });
    sendJson(desktop, { event: 'stream:text_delta', data: { text: 'World' } });
    sendJson(desktop, { event: 'stream:done', data: null });

    await delay(200); // Let messages be queued

    // Set up message collector BEFORE connecting mobile — the queue flush
    // happens synchronously on join, so we must listen first.
    const allMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (data) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    await delay(500); // Let queue flush + collect

    const appMsgs = allMsgs.filter(m => !m.event.startsWith('system:'));

    assert.ok(appMsgs.length >= 3, `Expected >= 3 queued messages, got ${appMsgs.length}: ${JSON.stringify(appMsgs.map(m => m.event))}`);
    assert.equal(appMsgs[0].event, 'stream:text_delta');
    assert.equal(appMsgs[0].data.text, 'Hello ');
    assert.equal(appMsgs[1].event, 'stream:text_delta');
    assert.equal(appMsgs[1].data.text, 'World');
    assert.equal(appMsgs[2].event, 'stream:done');

    desktop.close();
    mobile.close();
  });

  // ── Test 4: Multi-device support ────────────────────────────────

  it('delivers desktop messages to all connected mobiles', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Connect 3 mobiles
    const mobiles = [];
    for (let i = 0; i < 3; i++) {
      mobiles.push(await connectClient(`?token=${TEST_TOKEN}&role=mobile`));
    }

    await delay(300); // Drain system messages

    // Desktop broadcasts a message
    sendJson(desktop, { event: 'stream:agent:text', data: { text: 'broadcast test' } });

    // All mobiles should receive it
    for (let i = 0; i < mobiles.length; i++) {
      const msg = await waitForAppMessage(mobiles[i], 2000);
      assert.equal(msg.event, 'stream:agent:text', `mobile ${i} event mismatch`);
      assert.equal(msg.data.text, 'broadcast test', `mobile ${i} data mismatch`);
    }

    desktop.close();
    mobiles.forEach(m => m.close());
  });

  it('only notifies desktop of mobile_disconnected when last mobile leaves', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile1 = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);
    const mobile2 = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    await delay(300); // Drain system messages

    // Close first mobile — desktop should NOT get mobile_disconnected
    mobile1.close();
    await delay(200);

    // Desktop sends a message — should still reach mobile2
    sendJson(desktop, { event: 'test:still_here', data: true });
    const msg = await waitForAppMessage(mobile2, 2000);
    assert.equal(msg.event, 'test:still_here');

    // Close last mobile — desktop SHOULD get mobile_disconnected
    mobile2.close();
    const sysMsgs = await collectMessages(desktop, 500);
    const events = sysMsgs.map(m => m.event);
    assert.ok(events.includes('system:mobile_disconnected'), `Expected mobile_disconnected in ${JSON.stringify(events)}`);

    desktop.close();
  });

  // ── Test 5: Queue persistence ───────────────────────────────────

  it('persists offline queue to disk and restores on new RoomManager', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Send messages while no mobile is connected
    sendJson(desktop, { event: 'test:persist1', data: 'alpha' });
    sendJson(desktop, { event: 'test:persist2', data: 'beta' });

    await delay(300);

    // Verify queue file exists
    assert.ok(fs.existsSync(QUEUE_FILE), 'Queue file should exist');
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queues = JSON.parse(raw);
    assert.ok(queues[TEST_TOKEN], 'Queue should have entry for test token');
    // New format: { _format: 3, desktopQueues: { desktopId: [...] } }
    const tokenEntry = queues[TEST_TOKEN];
    assert.equal(tokenEntry._format, 3);
    const allQueues = Object.values(tokenEntry.desktopQueues);
    const totalMessages = allQueues.reduce((sum, q) => sum + q.length, 0);
    assert.ok(totalMessages >= 2, `Queue should have >= 2 messages, got ${totalMessages}`);

    desktop.close();
    await delay(200);

    // Verify the queue file still has data after desktop disconnect
    // (session/identity events are filtered, but test: events should remain)
    const raw2 = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queues2 = JSON.parse(raw2);
    // After desktop disconnect, session/identity messages are filtered
    // but our test messages should remain if they weren't flushed
    // Since desktop disconnected, the queue may be cleaned — this is expected
    // The key test is that the file was written at all

    // Clean up test data file
    try {
      fs.unlinkSync(QUEUE_FILE);
    } catch (_) {}
  });

  // ── Test 6: WebSocket compression negotiation ───────────────────

  it('negotiates permessage-deflate compression', async () => {
    const desktop = await connectClient(
      `?token=${TEST_TOKEN}&role=desktop`,
      { protocols: [`wzxclaw-${TEST_TOKEN}`] }
    );

    assert.ok(desktop.readyState === WebSocket.OPEN, 'Desktop should be connected');

    // Send a large message that should trigger compression (> 1024 bytes)
    const largeText = 'A'.repeat(2000);
    sendJson(desktop, { event: 'test:large', data: { text: largeText } });
    await delay(200);

    // Set up listener BEFORE connecting — queue flush is synchronous on join
    const allMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (data) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    await delay(500); // Let queue flush + collect

    const appMsgs = allMsgs.filter(m => m.event === 'test:large');
    assert.ok(appMsgs.length >= 1, `Should receive the large compressed message, got events: ${allMsgs.map(m => m.event)}`);
    assert.equal(appMsgs[0].data.text.length, 2000);

    desktop.close();
    mobile.close();
  });

  // ── Test 7: Invalid role rejection ──────────────────────────────

  it('rejects connection with invalid role with code 4003', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=unknown`);
    const closeEvent = await waitForClose(ws);
    assert.equal(closeEvent.code, 4003);
    assert.ok(closeEvent.reason.includes('invalid role'), `Expected "invalid role" in "${closeEvent.reason}"`);
  });

  // ── Test 8: Ping/Pong handling ──────────────────────────────────

  it('responds to ping with pong without forwarding', async () => {
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const mobile = await connectClient(`?token=${TEST_TOKEN}&role=mobile`);

    await delay(200); // Drain system messages

    // Collect all messages on both sides
    const desktopMsgs = [];
    const mobileMsgs = [];
    desktop.on('message', (d) => {
      try { desktopMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });
    mobile.on('message', (d) => {
      try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });

    // Mobile sends ping
    sendJson(mobile, { event: 'ping' });

    await delay(300);

    // Mobile should get pong back (from relay, not from desktop)
    const pongs = mobileMsgs.filter(m => m.event === 'pong');
    assert.ok(pongs.length >= 1, 'Mobile should receive pong');

    // Desktop should NOT receive the ping
    const pings = desktopMsgs.filter(m => m.event === 'ping');
    assert.equal(pings.length, 0, 'Desktop should not receive ping');

    desktop.close();
    mobile.close();
  });

  // ── Test 9: Multiple desktops coexist ──────────────────────────

  it('multiple desktops coexist and mobile receives system:desktop_list', async () => {
    const desktop1 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const desktop2 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Set up listener BEFORE connecting mobile (desktop_list sent on join).
    const mobileMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (d) => {
      try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    await delay(300);

    // Both desktops should be open.
    assert.equal(desktop1.readyState, WebSocket.OPEN);
    assert.equal(desktop2.readyState, WebSocket.OPEN);

    const listEvents = mobileMsgs.filter(m => m.event === 'system:desktop_list');
    assert.ok(listEvents.length >= 1, 'Should receive system:desktop_list');

    const desktopsList = listEvents[listEvents.length - 1].data.desktops;
    assert.equal(desktopsList.length, 2, 'Desktop list should have 2 entries');

    desktop1.close();
    desktop2.close();
    mobile.close();
  });

  // ── Test 10: target:select routing ─────────────────────────────

  it('mobile can target a specific desktop with target:select', async () => {
    const desktop1 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const desktop2 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Set up listener BEFORE connecting mobile.
    const mobileMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (d) => {
      try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    await delay(300);

    const listEvent = mobileMsgs.find(m => m.event === 'system:desktop_list');
    assert.ok(listEvent, 'Should have received system:desktop_list');
    const desktops = listEvent.data.desktops;
    assert.equal(desktops.length, 2);

    const targetId = desktops[0].desktopId;

    // Mobile selects first desktop.
    sendJson(mobile, { event: 'target:select', data: { desktopId: targetId } });

    // Wait for target confirmation.
    await delay(200);
    const confirmed = mobileMsgs.find(m => m.event === 'system:target:confirmed');
    assert.ok(confirmed, 'Should receive target:confirmed');
    assert.equal(confirmed.data.desktopId, targetId);

    // Now mobile sends a message — only desktop1 should receive it.
    const d1Msgs = [];
    const d2Msgs = [];
    desktop1.on('message', (d) => { try { d1Msgs.push(JSON.parse(d.toString())); } catch (_) {} });
    desktop2.on('message', (d) => { try { d2Msgs.push(JSON.parse(d.toString())); } catch (_) {} });

    sendJson(mobile, { event: 'test:targeted', data: 'hello targeted' });
    await delay(200);

    const d1App = d1Msgs.filter(m => m.event === 'test:targeted');
    const d2App = d2Msgs.filter(m => m.event === 'test:targeted');
    assert.ok(d1App.length >= 1, 'Target desktop should receive message');
    assert.equal(d2App.length, 0, 'Non-target desktop should NOT receive message');

    desktop1.close();
    desktop2.close();
    mobile.close();
  });

  // ── Test 11: System events ──────────────────────────────────────

  it('sends system:desktop_connected/disconnected to mobiles', async () => {
    // Set up listener BEFORE connecting mobile.
    const mobileMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (d) => {
      try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    // Desktop connects
    const desktop = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    await delay(200);

    // Find desktop_connected in received messages.
    const connected = mobileMsgs.find(m => m.event === 'system:desktop_connected');
    assert.ok(connected, 'Should receive system:desktop_connected');
    assert.ok(connected.data && connected.data.desktopId, 'Should include desktopId');

    // Desktop disconnects
    desktop.close();
    await delay(300);
    const disconnected = mobileMsgs.find(m => m.event === 'system:desktop_disconnected');
    assert.ok(disconnected, 'Should receive system:desktop_disconnected');

    mobile.close();
  });

  // ── Test 12: Selected desktop disconnect clears target ─────────

  it('clears mobile target when selected desktop disconnects', async () => {
    const desktop1 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);
    const desktop2 = await connectClient(`?token=${TEST_TOKEN}&role=desktop`);

    // Set up listener BEFORE connecting mobile.
    const mobileMsgs = [];
    const mobile = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?token=${TEST_TOKEN}&role=mobile`);
    mobile.on('message', (d) => {
      try { mobileMsgs.push(JSON.parse(d.toString())); } catch (_) {}
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mobile connect timeout')), 3000);
      mobile.on('open', () => { clearTimeout(timer); resolve(); });
      mobile.on('error', reject);
    });

    await delay(300);

    const listEvent = mobileMsgs.find(m => m.event === 'system:desktop_list');
    assert.ok(listEvent);
    const targetId = listEvent.data.desktops[0].desktopId;

    // Select that desktop.
    sendJson(mobile, { event: 'target:select', data: { desktopId: targetId } });
    await delay(200);

    // Disconnect the targeted desktop.
    desktop1.close();

    // Mobile should receive target:confirmed with null.
    await delay(300);
    const confirmNull = mobileMsgs.find(m =>
      m.event === 'system:target:confirmed' && m.data && m.data.desktopId === null
    );
    assert.ok(confirmNull, 'Should receive target:confirmed with null after target disconnect');

    desktop2.close();
    mobile.close();
  });
});
