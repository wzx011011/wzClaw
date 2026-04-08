import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MobileServer } from '../mobile-server'
import WebSocket from 'ws'

// Mock electron app.isPackaged
vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

describe('MobileServer', () => {
  let server: MobileServer

  beforeEach(() => {
    server = new MobileServer()
  })

  afterEach(async () => {
    if (server.isRunning) {
      await server.stop()
    }
  })

  describe('initial state', () => {
    it('isRunning is false', () => {
      expect(server.isRunning).toBe(false)
    })

    it('serverPort is 0', () => {
      expect(server.serverPort).toBe(0)
    })

    it('connectedClients is empty', () => {
      expect(server.connectedClients).toEqual([])
    })
  })

  describe('start', () => {
    it('starts on random port and returns token', async () => {
      const result = await server.start(0)

      expect(result.port).toBeGreaterThan(0)
      expect(result.token).toHaveLength(64) // 32 bytes hex
      expect(server.isRunning).toBe(true)
      expect(server.serverPort).toBe(result.port)
    })

    it('returns same info if already running', async () => {
      const first = await server.start(0)
      const second = await server.start(0)

      expect(first.port).toBe(second.port)
      expect(first.token).toBe(second.token)
    })

    it('emits status on start', async () => {
      const statusSpy = vi.fn()
      server.on('status', statusSpy)
      await server.start(0)

      expect(statusSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          running: true,
          port: expect.any(Number)
        })
      )
    })
  })

  describe('stop', () => {
    it('stops server and resets state', async () => {
      await server.start(0)
      await server.stop()

      expect(server.isRunning).toBe(false)
      expect(server.serverPort).toBe(0)
    })

    it('emits status on stop', async () => {
      await server.start(0)
      const statusSpy = vi.fn()
      server.on('status', statusSpy)
      await server.stop()

      expect(statusSpy).toHaveBeenCalledWith(
        expect.objectContaining({ running: false, port: null })
      )
    })
  })

  describe('getStatus', () => {
    it('returns correct status when stopped', () => {
      const status = server.getStatus()
      expect(status.running).toBe(false)
      expect(status.port).toBeNull()
      expect(status.localUrl).toBeNull()
      expect(status.clients).toEqual([])
    })

    it('returns correct status when running', async () => {
      const { port } = await server.start(0)
      const status = server.getStatus()

      expect(status.running).toBe(true)
      expect(status.port).toBe(port)
      expect(status.localUrl).toBe(`http://localhost:${port}`)
    })
  })

  describe('WebSocket connection', () => {
    it('accepts connection with valid token', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)

      // Set up message listener BEFORE open fires to catch welcome message
      const msgPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      })

      const connected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true))
        ws.on('error', () => resolve(false))
      })

      expect(connected).toBe(true)

      const msg = await msgPromise
      expect(msg.event).toBe('connected')
      expect(msg.data.clientId).toBeDefined()

      ws.close()
      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 100))
    })

    it('rejects connection with invalid token', async () => {
      const { port } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=invalid`)
      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })

      expect(closeCode).toBe(4001)
    })

    it('rejects connection with no token', async () => {
      const { port } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}`)
      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })

      expect(closeCode).toBe(4001)
    })

    it('tracks connected clients', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((resolve) => ws.on('open', resolve))
      // Wait for server to register client
      await new Promise((r) => setTimeout(r, 50))

      expect(server.connectedClients).toHaveLength(1)
      expect(server.connectedClients[0].id).toBeDefined()

      ws.close()
      await new Promise((r) => setTimeout(r, 100))
      expect(server.connectedClients).toHaveLength(0)
    })

    it('emits client-message on incoming message', async () => {
      const { port, token } = await server.start(0)

      const clientMsgSpy = vi.fn()
      server.on('client-message', clientMsgSpy)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((resolve) => ws.on('open', resolve))
      // Wait for welcome
      await new Promise((r) => setTimeout(r, 50))

      ws.send(JSON.stringify({ event: 'command:send', data: { message: 'hello' } }))
      await new Promise((r) => setTimeout(r, 100))

      expect(clientMsgSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'command:send',
          data: { message: 'hello' }
        })
      )

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('broadcast', () => {
    it('sends message to all connected clients', async () => {
      const { port, token } = await server.start(0)

      const ws1 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      const ws2 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])
      // Drain welcome messages
      await new Promise((r) => setTimeout(r, 100))

      const messages1: any[] = []
      const messages2: any[] = []
      ws1.on('message', (d) => messages1.push(JSON.parse(d.toString())))
      ws2.on('message', (d) => messages2.push(JSON.parse(d.toString())))

      server.broadcast('test:event', { value: 42 })
      await new Promise((r) => setTimeout(r, 100))

      expect(messages1).toContainEqual({ event: 'test:event', data: { value: 42 } })
      expect(messages2).toContainEqual({ event: 'test:event', data: { value: 42 } })

      ws1.close()
      ws2.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })
})
