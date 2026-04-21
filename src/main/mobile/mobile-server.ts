import http from 'http'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { WebSocketServer, WebSocket } from 'ws'

export interface MobileClient {
  id: string
  ws: WebSocket
  userAgent: string
  connectedAt: number
}

export interface MobileServerStatus {
  running: boolean
  port: number | null
  localUrl: string | null
  tunnelUrl: string | null
  clients: Array<{ id: string; userAgent: string; connectedAt: number }>
}

/**
 * MobileServer — HTTP + WebSocket server for mobile remote control.
 *
 * - Serves static mobile client files
 * - WebSocket bidirectional communication with auth token
 * - Proxies agent messages and commands between desktop and mobile
 */
export class MobileServer extends EventEmitter {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private clients: Map<string, MobileClient> = new Map()
  private authToken: string = ''
  private port: number = 0

  get isRunning(): boolean {
    return this.httpServer !== null
  }

  get serverPort(): number {
    return this.port
  }

  get connectedClients(): MobileClient[] {
    return Array.from(this.clients.values())
  }

  /**
   * Start the HTTP + WebSocket server.
   * Returns the local URL and auth token for QR code generation.
   */
  async start(preferredPort = 0): Promise<{ port: number; token: string }> {
    if (this.httpServer) {
      return { port: this.port, token: this.authToken }
    }

    this.authToken = crypto.randomBytes(32).toString('hex')

    const server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res)
    })

    return new Promise((resolve, reject) => {
      server.listen(preferredPort, '0.0.0.0', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'))
          return
        }
        this.port = addr.port
        this.httpServer = server

        // Create WebSocket server on the same HTTP server
        this.wss = new WebSocketServer({ server })
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req))

        this.emitStatus()
        resolve({ port: this.port, token: this.authToken })
      })
      server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const client of this.clients.values()) {
      client.ws.close(1000, 'Server shutting down')
    }
    this.clients.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.port = 0
    this.authToken = ''
    this.emitStatus()
  }

  /**
   * Broadcast a message to all connected mobile clients.
   */
  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data })
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message)
      }
    }
  }

  getStatus(): MobileServerStatus {
    return {
      running: this.isRunning,
      port: this.port || null,
      localUrl: this.port ? `http://localhost:${this.port}` : null,
      tunnelUrl: null, // Set by tunnel-manager
      clients: Array.from(this.clients.values()).map((c) => ({
        id: c.id,
        userAgent: c.userAgent,
        connectedAt: c.connectedAt
      }))
    }
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Extract token from Sec-WebSocket-Protocol header first, fall back to URL query
    const protoHeader = req.headers['sec-websocket-protocol'] ?? ''
    let token: string | null = null
    if (protoHeader) {
      // Protocol format: "wzxclaw-{token}" or just the token itself
      const parts = protoHeader.split(',').map(s => s.trim())
      for (const part of parts) {
        if (part.startsWith('wzxclaw-')) {
          token = part.slice('wzxclaw-'.length)
          break
        }
      }
    }
    if (!token) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      token = url.searchParams.get('token')
    }

    // Validate auth token
    if (token !== this.authToken) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const clientId = crypto.randomUUID()
    const client: MobileClient = {
      id: clientId,
      ws,
      userAgent: req.headers['user-agent'] ?? 'unknown',
      connectedAt: Date.now()
    }
    this.clients.set(clientId, client)
    this.emitStatus()

    // Send welcome with current state
    ws.send(JSON.stringify({ event: 'connected', data: { clientId } }))

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString())
        // Emit upstream events (mobile → desktop)
        this.emit('client-message', { clientId, ...msg })
      } catch {
        // Ignore malformed messages
      }
    })

    ws.on('close', () => {
      this.clients.delete(clientId)
      this.emitStatus()
    })

    ws.on('error', () => {
      this.clients.delete(clientId)
      this.emitStatus()
    })
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname

    // Serve static files from mobile-client directory
    // In dev: src/mobile-client, in prod: resources/mobile-client
    const isDev = !require('electron').app.isPackaged
    const staticDir = isDev
      ? path.join(__dirname, '../../../src/mobile-client')
      : path.join(process.resourcesPath, 'mobile-client')
    const fullPath = path.resolve(path.join(staticDir, filePath))

    // Security: prevent path traversal
    if (!fullPath.startsWith(path.resolve(staticDir))) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const ext = path.extname(fullPath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.json': 'application/json'
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not Found')
        return
      }
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      })
      res.end(data)
    })
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}
