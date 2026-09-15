'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log, warn } = require('./logger');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
/**
 * Manages rooms keyed by token. Each room holds multiple desktops and
 * multiple mobiles. Mobiles can target a specific desktop or broadcast
 * to all. When all mobiles are offline, desktop messages are queued
 * per-desktop and flushed on reconnect.
 */
class RoomManager {
  constructor(options = {}) {
    // Map<string, {
    //   desktops: Map<desktopId, { ws, identity: {name?, platform?}, connectedAt, offlineQueue: Array }>,
    //   mobiles: Map<deviceId, { ws, identity: {name?, platform?}, connectedAt, targetDesktopId: string|null }>,
    // }>
    this._rooms = new Map();
    this._disablePersistence = options.disablePersistence ?? false;
    this._dataDir = options.dataDir || process.env.RELAY_DATA_DIR || DEFAULT_DATA_DIR;
    this._queueFile = options.queueFile || path.join(this._dataDir, 'offline-queues.json');
    this._maxRooms = options.maxRooms || parseInt(process.env.RELAY_MAX_ROOMS, 10) || 1000;
    this._maxDesktopsPerRoom = options.maxDesktopsPerRoom || parseInt(process.env.RELAY_MAX_DESKTOPS_PER_ROOM, 10) || 20;
    this._maxMobilesPerRoom = options.maxMobilesPerRoom || parseInt(process.env.RELAY_MAX_MOBILES_PER_ROOM, 10) || 50;
    this._maxQueueMessageBytes = options.maxQueueMessageBytes || parseInt(process.env.RELAY_MAX_QUEUE_MESSAGE_BYTES, 10) || 256 * 1024;
    this._maxRoomQueueBytes = options.maxRoomQueueBytes || parseInt(process.env.RELAY_MAX_ROOM_QUEUE_BYTES, 10) || 10 * 1024 * 1024;
    this._maxGlobalQueueBytes = options.maxGlobalQueueBytes || parseInt(process.env.RELAY_MAX_GLOBAL_QUEUE_BYTES, 10) || 50 * 1024 * 1024;

    // Periodic cleanup of expired queue entries (24-hour TTL).
    this._cleanupInterval = setInterval(() => this._cleanupExpiredQueues(), 3600_000);

    // Server-side WebSocket ping to detect dead TCP connections.
    this._healthCheckInterval = setInterval(() => this._healthCheck(), 30_000);

    // Restore persisted offline queues from disk.
    this._loadQueues();
  }

  // ── Queue Persistence ────────────────────────────────────────────

  _loadQueues() {
    try {
      if (this._disablePersistence) return;
      if (!fs.existsSync(this._queueFile)) return;
      const data = this._readQueueFile();
      if (typeof data !== 'object' || data === null) return;
      for (const [roomId, value] of Object.entries(data)) {
        if (!this._rooms.has(roomId)) {
          const desktops = new Map();
          const mobiles = new Map();
          if (Array.isArray(value)) {
            // Legacy format v1: { token: [queue] }
            desktops.set('legacy', { ws: null, identity: {}, connectedAt: 0, offlineQueue: value });
          } else if (value && (value._format === 2 || value._format === 3) && value.desktopQueues) {
            // Format v2/v3: { token: { _format, desktopQueues: { dId: [queue] } } }
            for (const [dId, dq] of Object.entries(value.desktopQueues)) {
              if (Array.isArray(dq) && dq.length > 0) {
                desktops.set(dId, { ws: null, identity: {}, connectedAt: 0, offlineQueue: dq });
              }
            }
          }
          if (desktops.size > 0) {
            this._rooms.set(roomId, { desktops, mobiles });
          }
        }
      }
      log(`Loaded persisted queues for ${this._rooms.size} room(s)`);
    } catch (err) {
      warn(`Failed to load persisted queues: ${err.message}`);
    }
  }

  _readQueueFile() {
    try {
      return JSON.parse(fs.readFileSync(this._queueFile, 'utf8'));
    } catch (err) {
      const backup = `${this._queueFile}.bak`;
      if (fs.existsSync(backup)) {
        warn(`Queue file corrupt, attempting backup: ${err.message}`);
        return JSON.parse(fs.readFileSync(backup, 'utf8'));
      }
      const corrupt = `${this._queueFile}.corrupt-${Date.now()}`;
      try { fs.renameSync(this._queueFile, corrupt); } catch (_) {}
      throw err;
    }
  }

  _saveQueues() {
    try {
      if (this._disablePersistence) return;
      const data = {};
      for (const [roomId, room] of this._rooms) {
        const desktopQueues = {};
        for (const [desktopId, desktop] of room.desktops) {
          if (desktop.offlineQueue && desktop.offlineQueue.length > 0) {
            desktopQueues[desktopId] = desktop.offlineQueue;
          }
        }
        if (Object.keys(desktopQueues).length > 0) {
          data[roomId] = { _format: 3, desktopQueues };
        }
      }
      if (Object.keys(data).length === 0) {
        // Clean up file if no queues remain.
        if (fs.existsSync(this._queueFile)) fs.unlinkSync(this._queueFile);
        return;
      }
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      const tmp = `${this._queueFile}.tmp-${process.pid}-${Date.now()}`;
      const backup = `${this._queueFile}.bak`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      if (fs.existsSync(this._queueFile)) {
        try { fs.copyFileSync(this._queueFile, backup); } catch (_) {}
      }
      fs.renameSync(tmp, this._queueFile);
    } catch (err) {
      warn(`Failed to persist queues: ${err.message}`);
    }
  }

  roomIdForToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
  }

  // ── Join / Leave ─────────────────────────────────────────────────

  join(token, role, ws) {
    const roomId = this.roomIdForToken(token);
    if (!this._rooms.has(roomId)) {
      if (this._rooms.size >= this._maxRooms) {
        try { ws.close(1013, 'room limit exceeded'); } catch (_) {}
        return;
      }
      this._rooms.set(roomId, {
        desktops: new Map(),
        mobiles: new Map(),
      });
    }

    const room = this._rooms.get(roomId);

    if (role === 'desktop') {
      if (room.desktops.size >= this._maxDesktopsPerRoom) {
        try { ws.close(1013, 'desktop limit exceeded'); } catch (_) {}
        return;
      }
      const desktopId = crypto.randomUUID();
      const entry = {
        ws,
        identity: {},
        connectedAt: Date.now(),
        offlineQueue: [],
      };
      room.desktops.set(desktopId, entry);
      ws._wzxDesktopId = desktopId;
      ws._wzxRole = 'desktop';
      ws._wzxRoomId = roomId;

      log(`Room [${roomId}]: desktop joined (desktopId=${desktopId}, rooms active: ${this._rooms.size})`);

      // Notify all mobiles about new desktop.
      for (const [, mobile] of room.mobiles) {
        this._sendSystem(mobile.ws, 'system:desktop_connected', {
          desktopId,
          name: entry.identity.name,
          platform: entry.identity.platform,
        });
      }
      // Send full desktop list to all mobiles.
      this._sendDesktopList(room);
      // Notify this desktop of existing mobiles.
      this._sendMobileList(room, ws);
    } else {
      // mobile
      if (room.mobiles.size >= this._maxMobilesPerRoom) {
        try { ws.close(1013, 'mobile limit exceeded'); } catch (_) {}
        return;
      }
      const deviceId = crypto.randomUUID();
      const entry = {
        ws,
        identity: {},
        connectedAt: Date.now(),
        targetDesktopId: null,
      };
      room.mobiles.set(deviceId, entry);
      ws._wzxDeviceId = deviceId;
      ws._wzxRole = 'mobile';
      ws._wzxRoomId = roomId;

      log(`Room [${roomId}]: mobile joined (deviceId=${deviceId}, rooms active: ${this._rooms.size})`);

      // Flush offline queues from all desktops (mobile has no target yet).
      this._flushOfflineQueues(room, entry);

      // Notify all desktops about new mobile.
      for (const [, desktop] of room.desktops) {
        this._sendSystem(desktop.ws, 'system:mobile_connected', {
          deviceId,
        });
      }
      // Send full mobile list to all desktops.
      this._sendMobileList(room);
      // Send full desktop list to this mobile.
      this._sendDesktopList(room, ws);
    }

    // Wire up event handlers.
    ws.on('message', (data) => {
      this._onMessage(roomId, role, ws, data);
    });

    ws.on('close', () => {
      this._onDisconnect(roomId, role, ws);
    });

    ws.on('error', (err) => {
      warn(`Room [${roomId}]: ${role} error: ${err.message}`);
      this._onDisconnect(roomId, role, ws);
    });
  }

  // ── Message Routing ───────────────────────────────────────────────

  _forward(from, to, data) {
    if (to && to.readyState === 1) {
      try {
        to.send(data);
      } catch (err) {
        warn(`Forward error: ${err.message}`);
      }
    }
  }

  /** Broadcast data to all connected mobiles in a room. */
  _broadcastToMobiles(room, data) {
    for (const [, mobile] of room.mobiles) {
      this._forward(null, mobile.ws, data);
    }
  }

  /** Broadcast data to all connected desktops in a room. */
  _broadcastToDesktops(room, data) {
    for (const [, desktop] of room.desktops) {
      if (desktop.ws) {
        this._forward(null, desktop.ws, data);
      }
    }
  }

  _onMessage(roomId, role, ws, data) {
    const raw = typeof data === 'string' ? data : data.toString('utf8');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      warn(`Room [${roomId}]: ${role} sent non-JSON message, ignoring`);
      return;
    }

    const event = parsed.event;

    // Respond to ping with pong (do not forward).
    if (event === 'ping') {
      try { ws.send(JSON.stringify({ event: 'pong' })); } catch (_) {}
      return;
    }
    // Consume pong.
    if (event === 'pong') {
      return;
    }

    const room = this._rooms.get(roomId);
    if (!room) return;

    // ── Intercept identity:announce from desktop ──
    if (event === 'identity:announce' && role === 'desktop') {
      const desktopId = ws._wzxDesktopId;
      if (desktopId) {
        const entry = room.desktops.get(desktopId);
        if (entry && parsed.data && typeof parsed.data === 'object') {
          entry.identity = {
            name: parsed.data.name || null,
            platform: parsed.data.platform || null,
          };
          log(`Room [${roomId}]: desktop identity updated (desktopId=${desktopId}, name=${entry.identity.name})`);
          this._sendDesktopList(room);
        }
      }
      // Forward to all mobiles as before.
      this._broadcastToMobiles(room, raw);
      return;
    }

    // ── Intercept identity:mobile_announce from mobile ──
    if (event === 'identity:mobile_announce' && role === 'mobile') {
      const deviceId = ws._wzxDeviceId;
      if (deviceId) {
        const entry = room.mobiles.get(deviceId);
        if (entry && parsed.data && typeof parsed.data === 'object') {
          entry.identity = {
            name: parsed.data.name || null,
            platform: parsed.data.platform || null,
            osVersion: parsed.data.osVersion || null,
            appVersion: parsed.data.appVersion || null,
          };
          log(`Room [${roomId}]: mobile identity updated (deviceId=${deviceId}, name=${entry.identity.name})`);
          this._sendMobileList(room);
        }
      }
      // Forward to all desktops as before.
      this._broadcastToDesktops(room, raw);
      return;
    }

    // ── Intercept target:select from mobile ──
    if (event === 'target:select' && role === 'mobile') {
      const deviceId = ws._wzxDeviceId;
      if (deviceId) {
        const entry = room.mobiles.get(deviceId);
        if (entry) {
          const requestedId = parsed.data && parsed.data.desktopId;
          if (requestedId && room.desktops.has(requestedId)) {
            entry.targetDesktopId = requestedId;
            log(`Room [${roomId}]: mobile ${deviceId} selected desktop ${requestedId}`);
          } else {
            entry.targetDesktopId = null;
          }
          this._sendSystem(ws, 'system:target:confirmed', {
            desktopId: entry.targetDesktopId,
          });
        }
      }
      return; // Do NOT forward to desktop.
    }

    // ── Intercept target:clear from mobile ──
    if (event === 'target:clear' && role === 'mobile') {
      const deviceId = ws._wzxDeviceId;
      if (deviceId) {
        const entry = room.mobiles.get(deviceId);
        if (entry) {
          entry.targetDesktopId = null;
          log(`Room [${roomId}]: mobile ${deviceId} cleared target`);
          this._sendSystem(ws, 'system:target:confirmed', { desktopId: null });
        }
      }
      return;
    }

    // ── Normal routing ──

    if (role === 'desktop') {
      const hasMobiles = room.mobiles.size > 0;

      if (hasMobiles) {
        this._broadcastToMobiles(room, raw);
      } else {
        // Queue per-desktop.
        const desktopId = ws._wzxDesktopId;
        if (desktopId) {
          const entry = room.desktops.get(desktopId);
          if (entry) {
            if (this._canQueue(room, raw)) {
              entry.offlineQueue.push({ raw, timestamp: Date.now() });
              if (entry.offlineQueue.length > 500) {
                entry.offlineQueue.shift();
              }
              log(`Room [${roomId}]: message queued (desktop=${desktopId}, queue size: ${entry.offlineQueue.length})`);
            } else {
              warn(`Room [${roomId}]: dropped oversized/off-limits queued event=${event}`);
            }
          }
        }
      }

      log(`Room [${roomId}]: desktop -> ${hasMobiles ? 'mobiles' : 'queued'} event=${event}`);
      this._saveQueues();
    } else {
      // Mobile -> desktop routing.
      const deviceId = ws._wzxDeviceId;
      const mobileEntry = deviceId ? room.mobiles.get(deviceId) : null;

      if (mobileEntry && mobileEntry.targetDesktopId) {
        // Route to specific desktop.
        const target = room.desktops.get(mobileEntry.targetDesktopId);
        if (target) {
          this._forward(ws, target.ws, raw);
          log(`Room [${roomId}]: mobile -> desktop ${mobileEntry.targetDesktopId} event=${event}`);
        } else {
          // Target desktop gone -- clear selection, broadcast.
          mobileEntry.targetDesktopId = null;
          this._sendSystem(ws, 'system:target:confirmed', { desktopId: null });
          this._broadcastToDesktops(room, raw);
          log(`Room [${roomId}]: mobile -> broadcast (target gone) event=${event}`);
        }
      } else {
        // No target -- broadcast to all desktops.
        // Check if any desktop is actually reachable before routing.
        const activeDesktops = [...room.desktops.values()].filter(d => d.ws && d.ws.readyState === 1);
        if (activeDesktops.length === 0) {
          // No desktop online: notify mobile so it can show an error instead of hanging.
          try {
            ws.send(JSON.stringify({
              event: 'system:no_desktop',
              data: { error: 'Desktop is offline. Please open wzxClaw on your computer.' }
            }));
          } catch (_) {}
          log(`Room [${roomId}]: mobile -> no desktop online, dropped event=${event}`);
        } else {
          this._broadcastToDesktops(room, raw);
          log(`Room [${roomId}]: mobile -> desktops (broadcast) event=${event}`);
        }
      }
    }
  }

  _queueBytes(room) {
    let bytes = 0;
    for (const [, desktop] of room.desktops) {
      for (const msg of desktop.offlineQueue || []) {
        bytes += Buffer.byteLength(msg.raw || '', 'utf8');
      }
    }
    return bytes;
  }

  _globalQueueBytes() {
    let bytes = 0;
    for (const [, room] of this._rooms) bytes += this._queueBytes(room);
    return bytes;
  }

  _canQueue(room, raw) {
    const messageBytes = Buffer.byteLength(raw, 'utf8');
    if (messageBytes > this._maxQueueMessageBytes) return false;
    if (this._queueBytes(room) + messageBytes > this._maxRoomQueueBytes) return false;
    if (this._globalQueueBytes() + messageBytes > this._maxGlobalQueueBytes) return false;
    return true;
  }

  // ── Disconnect ────────────────────────────────────────────────────

  _onDisconnect(roomId, role, ws) {
    const room = this._rooms.get(roomId);
    if (!room) return;

    if (role === 'desktop') {
      const desktopId = ws._wzxDesktopId;
      if (desktopId && room.desktops.has(desktopId)) {
        const entry = room.desktops.get(desktopId);

        // Clear stale session/identity messages from this desktop's queue.
        if (entry.offlineQueue) {
          entry.offlineQueue = entry.offlineQueue.filter(msg => {
            try {
              const p = JSON.parse(msg.raw);
              const evt = p.event || '';
              return !evt.startsWith('session:') && !evt.startsWith('identity:');
            } catch (_) { return true; }
          });
        }

        // Remove desktop entry, but keep it (with ws=null) if queue has messages.
        entry.ws = null;
        if (!entry.offlineQueue || entry.offlineQueue.length === 0) {
          room.desktops.delete(desktopId);
        }
        this._saveQueues();

        // Notify all mobiles.
        for (const [, mobile] of room.mobiles) {
          // Clear target if pointing to this desktop.
          if (mobile.targetDesktopId === desktopId) {
            mobile.targetDesktopId = null;
            this._sendSystem(mobile.ws, 'system:target:confirmed', { desktopId: null });
          }
          this._sendSystem(mobile.ws, 'system:desktop_disconnected', {
            desktopId,
            name: entry.identity ? entry.identity.name : null,
            platform: entry.identity ? entry.identity.platform : null,
          });
        }
        // Send updated desktop list.
        this._sendDesktopList(room);
        log(`Room [${roomId}]: desktop disconnected (desktopId=${desktopId}, desktops remaining: ${room.desktops.size})`);
      }
    } else if (role === 'mobile') {
      const deviceId = ws._wzxDeviceId;
      if (deviceId && room.mobiles.has(deviceId)) {
        room.mobiles.delete(deviceId);
        log(`Room [${roomId}]: mobile disconnected (deviceId=${deviceId}, mobiles remaining: ${room.mobiles.size})`);

        // Send updated mobile list to desktops.
        this._sendMobileList(room);

        // Notify desktops when last mobile leaves.
        if (room.mobiles.size === 0) {
          for (const [, desktop] of room.desktops) {
            this._sendSystem(desktop.ws, 'system:mobile_disconnected', { deviceId });
          }
        }
      }
    }

    // Clean up empty rooms.
    let hasQueue = false;
    for (const [, desktop] of room.desktops) {
      if (desktop.offlineQueue && desktop.offlineQueue.length > 0) { hasQueue = true; break; }
    }
    if (room.desktops.size === 0 && room.mobiles.size === 0 && !hasQueue) {
      if ((room.pushTokens?.size ?? 0) > 0) {
        room.lastWakePushAt = 0;
      } else {
        this._rooms.delete(roomId);
        log(`Room [${roomId}]: room deleted (empty)`);
      }
    }
  }

  // ── Offline Queue ─────────────────────────────────────────────────

  _flushOfflineQueues(room, mobileEntry) {
    let totalFlushed = 0;

    if (mobileEntry.targetDesktopId) {
      // Flush only from selected desktop.
      const desktop = room.desktops.get(mobileEntry.targetDesktopId);
      if (desktop && desktop.offlineQueue && desktop.offlineQueue.length > 0) {
        const queue = desktop.offlineQueue;
        desktop.offlineQueue = [];
        for (const msg of queue) {
          this._forward(null, mobileEntry.ws, msg.raw);
        }
        totalFlushed += queue.length;
      }
    } else {
      // Flush from ALL desktops.
      for (const [, desktop] of room.desktops) {
        if (desktop.offlineQueue && desktop.offlineQueue.length > 0) {
          const queue = desktop.offlineQueue;
          desktop.offlineQueue = [];
          for (const msg of queue) {
            this._forward(null, mobileEntry.ws, msg.raw);
          }
          totalFlushed += queue.length;
        }
      }
    }

    if (totalFlushed > 0) {
      log(`Flushing ${totalFlushed} offline messages (target=${mobileEntry.targetDesktopId || 'all'})`);
      this._saveQueues();
    }
  }

  _cleanupExpiredQueues() {
    const ttl = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let changed = false;
    for (const [roomId, room] of this._rooms) {
      let cleaned = 0;
      for (const [, desktop] of room.desktops) {
        if (!desktop.offlineQueue || desktop.offlineQueue.length === 0) continue;
        const before = desktop.offlineQueue.length;
        desktop.offlineQueue = desktop.offlineQueue.filter(msg => (now - msg.timestamp) < ttl);
        cleaned += before - desktop.offlineQueue.length;
      }
      if (cleaned > 0) {
        changed = true;
        log(`Room [${roomId}]: expired ${cleaned} queued messages (24h TTL)`);
      }
    }
    if (changed) this._saveQueues();
  }

  // ── List broadcast helpers ────────────────────────────────────────

  /** Send the full desktop list to mobiles (or a specific mobile). */
  _sendDesktopList(room, targetWs) {
    const desktops = [];
    for (const [desktopId, entry] of room.desktops) {
      // Skip disconnected entries (kept for queue persistence only).
      if (!entry.ws) continue;
      desktops.push({
        desktopId,
        name: entry.identity ? entry.identity.name : null,
        platform: entry.identity ? entry.identity.platform : null,
        connectedAt: entry.connectedAt,
      });
    }
    const payload = JSON.stringify({ event: 'system:desktop_list', data: { desktops } });

    if (targetWs) {
      if (targetWs.readyState === 1) {
        try { targetWs.send(payload); } catch (_) {}
      }
    } else {
      for (const [, mobile] of room.mobiles) {
        this._forward(null, mobile.ws, payload);
      }
    }
  }

  /** Send the full mobile list to desktops (or a specific desktop). */
  _sendMobileList(room, targetWs) {
    const mobiles = [];
    for (const [deviceId, entry] of room.mobiles) {
      mobiles.push({
        deviceId,
        name: entry.identity ? entry.identity.name : null,
        platform: entry.identity ? entry.identity.platform : null,
        osVersion: entry.identity ? entry.identity.osVersion : null,
        appVersion: entry.identity ? entry.identity.appVersion : null,
        connectedAt: entry.connectedAt,
      });
    }
    const payload = JSON.stringify({ event: 'system:mobile_list', data: { mobiles } });

    if (targetWs) {
      if (targetWs.readyState === 1) {
        try { targetWs.send(payload); } catch (_) {}
      }
    } else {
      for (const [, desktop] of room.desktops) {
        this._forward(null, desktop.ws, payload);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _sendSystem(ws, event, data) {
    if (ws && ws.readyState === 1) {
      const msg = data !== undefined
        ? JSON.stringify({ event, data })
        : JSON.stringify({ event });
      try {
        ws.send(msg);
      } catch (err) {
        log(`[_sendSystem] failed to send ${event}: ${err.message}`);
      }
    }
  }

  getRoomCount() {
    return this._rooms.size;
  }

  _healthCheck() {
    const failures = [];
    for (const [roomId, room] of this._rooms) {
      for (const [desktopId, desktop] of room.desktops) {
        if (desktop.ws && desktop.ws.readyState === 1) {
          try { desktop.ws.ping(); } catch (_) { failures.push({ roomId, role: 'desktop', ws: desktop.ws }); }
        }
      }
      for (const [deviceId, mobile] of room.mobiles) {
        if (mobile.ws && mobile.ws.readyState === 1) {
          try { mobile.ws.ping(); } catch (_) { failures.push({ roomId, role: 'mobile', ws: mobile.ws }); }
        }
      }
    }
    for (const { roomId, role, ws } of failures) {
      warn(`Room [${roomId}]: ${role} ping failed, triggering disconnect`);
      this._onDisconnect(roomId, role, ws);
    }
  }

  closeAll() {
    clearInterval(this._cleanupInterval);
    clearInterval(this._healthCheckInterval);
    this._saveQueues();
    for (const [token, room] of this._rooms) {
      for (const [, desktop] of room.desktops) {
        if (desktop.ws) {
          try { desktop.ws.close(1001, 'server shutdown'); } catch (_) {}
        }
      }
      for (const [, mobile] of room.mobiles) {
        if (mobile.ws) {
          try { mobile.ws.close(1001, 'server shutdown'); } catch (_) {}
        }
      }
    }
    this._rooms.clear();
  }
}

module.exports = { RoomManager };
