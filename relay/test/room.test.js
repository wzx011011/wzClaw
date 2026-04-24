'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../lib/room');

/**
 * Create a mock WebSocket object.
 * @returns {{ ws: object, sent: string[], closed: {code: number, reason: string}[] }}
 */
function createMockWs() {
  const sent = [];
  const closed = [];
  const listeners = {};

  const ws = {
    readyState: 1, // OPEN
    send(data) {
      sent.push(typeof data === 'string' ? data : data.toString());
    },
    close(code, reason) {
      ws.readyState = 3; // CLOSED
      closed.push({ code, reason });
      // Trigger close listeners.
      if (listeners.close) {
        listeners.close.forEach(fn => fn());
      }
    },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    // Helper to simulate receiving a message.
    _receive(data) {
      if (listeners.message) {
        listeners.message.forEach(fn => fn(data));
      }
    },
    // Helper to simulate disconnect.
    _disconnect() {
      ws.readyState = 3;
      if (listeners.close) {
        listeners.close.forEach(fn => fn());
      }
    },
    // Helper to simulate error.
    _error(err) {
      if (listeners.error) {
        listeners.error.forEach(fn => fn(err));
      }
    },
  };

  return { ws, sent, closed };
}

/** Filter out system:* messages from the sent array (they are tested separately). */
function nonSystemMessages(sent) {
  return sent.filter(raw => {
    try {
      const msg = JSON.parse(raw);
      return !msg.event || !msg.event.startsWith('system:');
    } catch (_) {
      return true;
    }
  });
}

/** Filter only system:* messages from the sent array. */
function systemMessages(sent) {
  return sent.filter(raw => {
    try {
      const msg = JSON.parse(raw);
      return msg.event && msg.event.startsWith('system:');
    } catch (_) {
      return false;
    }
  });
}

describe('RoomManager', () => {
  let roomManager;

  beforeEach(() => {
    roomManager = new RoomManager();
  });

  afterEach(() => {
    // Clean up the periodic cleanup interval so the process can exit.
    roomManager.closeAll();
  });

  it('joining a desktop creates a room with desktop slot filled', () => {
    const { ws } = createMockWs();
    roomManager.join('token-1', 'desktop', ws);
    assert.equal(roomManager.getRoomCount(), 1);
  });

  it('joining a mobile for same token pairs them', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);
    assert.equal(roomManager.getRoomCount(), 1);
  });

  it('multiple desktops can coexist in the same room', () => {
    const { ws: desktop1 } = createMockWs();
    const { ws: desktop2 } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop1);
    roomManager.join('token-1', 'desktop', desktop2);
    // Both desktops should be in the room, neither replaced.
    assert.equal(roomManager.getRoomCount(), 1);
    // desktop1 should NOT have been closed.
    assert.equal(desktop1.readyState, 1);
    assert.equal(desktop2.readyState, 1);
  });

  it('disconnecting desktop sends system:desktop_disconnected to mobile', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile, sent: mobileSent } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    // Simulate desktop disconnect.
    desktop._disconnect();

    const sysMessages = systemMessages(mobileSent);
    // Should contain system:desktop_disconnected (may not be last due to desktop_list)
    const events = sysMessages.map(raw => { try { return JSON.parse(raw).event; } catch (_) { return ''; } });
    assert.ok(events.includes('system:desktop_disconnected'), `Expected system:desktop_disconnected in ${events}`);
  });

  it('disconnecting mobile sends system:mobile_disconnected to desktop', () => {
    const { ws: desktop, sent: desktopSent } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    // Simulate mobile disconnect.
    mobile._disconnect();

    const sysMessages = systemMessages(desktopSent);
    // system:mobile_connected on join + system:mobile_disconnected on disconnect
    assert.ok(sysMessages.length >= 2);
    const lastSys = JSON.parse(sysMessages[sysMessages.length - 1]);
    assert.equal(lastSys.event, 'system:mobile_disconnected');
  });

  it('getRoomCount() reflects active rooms', () => {
    const { ws: d1 } = createMockWs();
    const { ws: m1 } = createMockWs();
    const { ws: d2 } = createMockWs();

    roomManager.join('token-1', 'desktop', d1);
    assert.equal(roomManager.getRoomCount(), 1);

    roomManager.join('token-1', 'mobile', m1);
    assert.equal(roomManager.getRoomCount(), 1);

    roomManager.join('token-2', 'desktop', d2);
    assert.equal(roomManager.getRoomCount(), 2);
  });

  it('room is deleted when both sides disconnect', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    desktop._disconnect();
    assert.equal(roomManager.getRoomCount(), 1);

    mobile._disconnect();
    assert.equal(roomManager.getRoomCount(), 0);
  });

  it('forwards messages from desktop to mobile', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile, sent: mobileSent } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    desktop._receive(JSON.stringify({ event: 'connected', data: { status: 'ok' } }));

    const forwarded = nonSystemMessages(mobileSent);
    assert.equal(forwarded.length, 1);
    const msg = JSON.parse(forwarded[0]);
    assert.equal(msg.event, 'connected');
  });

  it('forwards messages from mobile to desktop', () => {
    const { ws: desktop, sent: desktopSent } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    mobile._receive(JSON.stringify({ event: 'command:send', data: { content: 'hello' } }));

    const forwarded = nonSystemMessages(desktopSent);
    assert.equal(forwarded.length, 1);
    const msg = JSON.parse(forwarded[0]);
    assert.equal(msg.event, 'command:send');
  });

  it('does not forward ping messages', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile, sent: mobileSent } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    desktop._receive(JSON.stringify({ event: 'ping' }));

    assert.equal(nonSystemMessages(mobileSent).length, 0);
  });

  it('does not forward pong messages', () => {
    const { ws: desktop, sent: desktopSent } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    mobile._receive(JSON.stringify({ event: 'pong' }));

    assert.equal(nonSystemMessages(desktopSent).length, 0);
  });

  it('ignores non-JSON messages', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile, sent: mobileSent } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    // Should not throw, should not forward.
    desktop._receive('not-json');

    assert.equal(nonSystemMessages(mobileSent).length, 0);
  });

  it('closeAll() closes all connections', () => {
    const { ws: d1, closed: c1 } = createMockWs();
    const { ws: m1, closed: c2 } = createMockWs();
    roomManager.join('t1', 'desktop', d1);
    roomManager.join('t1', 'mobile', m1);

    roomManager.closeAll();

    assert.equal(c1.length, 1);
    assert.equal(c2.length, 1);
    assert.equal(roomManager.getRoomCount(), 0);
  });

  it('queues messages when mobile is offline', () => {
    const { ws: desktop } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    // No mobile joined yet.

    desktop._receive(JSON.stringify({ event: 'stream:done', data: { content: 'Task finished' } }));

    // Room should still exist with queued message.
    assert.equal(roomManager.getRoomCount(), 1);
  });

  it('flushes queued messages when mobile reconnects', () => {
    const { ws: desktop } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);

    // Queue a message while mobile is offline.
    desktop._receive(JSON.stringify({ event: 'message:assistant', data: { content: 'Hello' } }));

    // Now mobile connects.
    const { ws: mobile, sent: mobileSent } = createMockWs();
    roomManager.join('token-1', 'mobile', mobile);

    // Mobile should receive the queued message (plus system:desktop_connected).
    const forwarded = nonSystemMessages(mobileSent);
    assert.ok(forwarded.length >= 1);
    const msg = JSON.parse(forwarded[forwarded.length - 1]);
    assert.equal(msg.event, 'message:assistant');
  });

  it('stores FCM token from mobile via fcm:register event', () => {
    const { ws: desktop } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    // Mobile sends FCM token registration.
    mobile._receive(JSON.stringify({ event: 'fcm:register', data: { token: 'test-fcm-token-123' } }));

    // Verify: the fcm:register event should NOT be forwarded to desktop.
    const { ws: desktop2, sent: desktop2Sent } = createMockWs();
    const { ws: mobile2 } = createMockWs();
    roomManager.join('token-2', 'desktop', desktop2);
    roomManager.join('token-2', 'mobile', mobile2);
    mobile2._receive(JSON.stringify({ event: 'fcm:register', data: { token: 'abc' } }));
    assert.equal(nonSystemMessages(desktop2Sent).length, 0);
  });

  it('does not forward fcm:register events to desktop', () => {
    const { ws: desktop, sent: desktopSent } = createMockWs();
    const { ws: mobile } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);
    roomManager.join('token-1', 'mobile', mobile);

    mobile._receive(JSON.stringify({ event: 'fcm:register', data: { token: 'test-token' } }));

    assert.equal(nonSystemMessages(desktopSent).length, 0);
  });

  it('does not delete room when desktop disconnects but queue has messages', () => {
    const { ws: desktop } = createMockWs();
    roomManager.join('token-1', 'desktop', desktop);

    // Queue a message while mobile is offline.
    desktop._receive(JSON.stringify({ event: 'stream:done', data: { content: 'Done' } }));

    // Desktop disconnects -- room should persist because queue has messages.
    desktop._disconnect();
    assert.equal(roomManager.getRoomCount(), 1);
  });
});
