'use strict';

const { WebSocketServer } = require('ws');
const http = require('http');
const { URL } = require('url');
const auth = require('./lib/auth');
const { RoomManager } = require('./lib/room');
const { log, warn, error } = require('./lib/logger');

// -- Configuration --
const PORT = parseInt(process.env.PORT, 10) || 8080;

// -- Initialize auth module --
auth.init();

// -- Room manager --
const roomManager = new RoomManager();

// -- Create HTTP server (needed for ws to attach) --
const server = http.createServer((req, res) => {
  // Health check endpoint.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: roomManager.getRoomCount() }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

// -- WebSocket server --
const wss = new WebSocketServer({
  server,
  maxPayload: 1024 * 1024, // 1 MB limit
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3 },
    threshold: 1024, // only compress messages > 1 KB
    clientNoContextTakeover: false,
    serverNoContextTakeover: false,
  },
});

wss.on('connection', (ws, req) => {
  // Extract token from Sec-WebSocket-Protocol header, fall back to query string.
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let token = '';
  const protoHeader = req.headers['sec-websocket-protocol'] ?? '';
  if (protoHeader) {
    const parts = protoHeader.split(',').map(s => s.trim());
    for (const part of parts) {
      if (part.startsWith('wzxclaw-')) {
        token = part.slice('wzxclaw-'.length);
        break;
      }
    }
  }
  if (!token) {
    token = reqUrl.searchParams.get('token') || '';
  }
  const role = reqUrl.searchParams.get('role') || 'mobile';

  // Validate role parameter.
  if (role !== 'desktop' && role !== 'mobile') {
    ws.close(4003, 'invalid role');
    return;
  }

  // Authenticate.
  const result = auth.authenticate(token);
  if (!result.ok) {
    log(`Connection rejected: ${result.reason} (url=${req.url})`);
    ws.close(4001, result.reason);
    return;
  }

  log(`Client connected: role=${role}, token=${token.substring(0, 4)}***`);

  // Join the room.
  roomManager.join(token, role, ws);
});

// -- Periodic status logging --
const statusInterval = setInterval(() => {
  log(`Status: ${roomManager.getRoomCount()} active room(s)`);
}, 60_000);

// -- Graceful shutdown --
function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`);
  clearInterval(statusInterval);
  roomManager.closeAll();
  wss.close(() => {
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown stalls.
  setTimeout(() => {
    error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// -- Start server --
server.listen(PORT, () => {
  log(`Relay server listening on port ${PORT}`);
});

// Export for testing.
module.exports = { server, wss, roomManager, statusInterval };
