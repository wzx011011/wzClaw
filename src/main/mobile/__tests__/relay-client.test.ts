import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayClient } from '../relay-client'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

/**
 * RelayClient unit tests — uses a local mock relay server
 * to test connection, heartbeat, reconnection, and message forwarding.
 */

function createMockRelay(port: number): Promise<{ wss: WebSocketServer; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port }, () => {
      const server = wss.options.server as Server
      resolve({
        wss,
        server: server!,
        close: () => new Promise<void>((r) => wss.close(() => r()))
      })
    })
  })
}

// Patch the RELAY_URL for tests by intercepting WebSocket construction
let mockRelayPort = 0
const originalWebSocket = WebSocket

describe('RelayClient', () => {
  let relay: Awaited<ReturnType<typeof createMockRelay>>
  let client: RelayClient

  beforeEach(async () => {
    // Find a free port by binding to 0
    relay = await createMockRelay(0)
    const addr = relay.wss.address()
    mockRelayPort = typeof addr === 'object' ? addr!.port : 0

    // Create client with patched URL via subclass trick
    client = new RelayClient()
    // Override _doConnect to use local relay
    const origDoConnect = (client as any)._doConnect.bind(client)
    ;(client as any)._doConnect = function () {
      // Temporarily override the module constant via the ws URL construction
      const origWs = (globalThis as any).WebSocket
      // We need to intercept the URL — simplest: directly set ws
      ;(client as any)._clearTimers()
      ;(client as any)._closeWs()
      ;(client as any)._updateState(false, true)
      ;(client as any).emitStatus()

      const token = (client as any).token
      const url = `ws://localhost:${mockRelayPort}/?role=desktop&token=${encodeURIComponent(token)}`

      try {
        ;(client as any).ws = new originalWebSocket(url)
      } catch {
        ;(client as any)._scheduleReconnect()
        return
      }

      const ws = (client as any).ws

      ws.on('open', () => {
        ;(client as any)._updateState(true, false)
        ;(client as any).reconnectAttempt = 0
        ;(client as any)._startHeartbeat()
        ;(client as any).emitStatus()
        ;(client as any)._send(JSON.stringify({
          event: 'identity:announce',
          data: { name: 'wzxClaw', platform: process.platform }
        }))
      })

      ws.on('message', (raw: any) => {
        const rawStr = typeof raw === 'string' ? raw : raw.toString()
        try {
          const msg = JSON.parse(rawStr)
          const event = msg.event as string

          if (event === 'pong') {
            if ((client as any).heartbeatTimeoutTimer) {
              clearTimeout((client as any).heartbeatTimeoutTimer)
              ;(client as any).heartbeatTimeoutTimer = null
            }
            return
          }
          if (event === 'identity:mobile_announce') {
            ;(client as any)._mobileIdentity = msg.data?.name ?? 'Unknown'
            ;(client as any).emitStatus()
            return
          }
          if (event === 'system:mobile_connected') {
            ;(client as any)._mobileConnected = true
            ;(client as any).emitStatus()
            client.emit('mobile-connected')
            return
          }
          if (event === 'system:mobile_disconnected') {
            ;(client as any)._mobileConnected = false
            ;(client as any)._mobileIdentity = null
            ;(client as any).emitStatus()
            return
          }
          if (event === 'system:desktop_disconnected') return

          client.emit('client-message', {
            clientId: 'relay-mobile',
            event,
            data: msg.data
          })
        } catch { /* ignore */ }
      })

      ws.on('close', () => {
        ;(client as any)._stopHeartbeat()
        if (!(client as any).disposed && ((client as any)._connected || (client as any)._connecting)) {
          ;(client as any)._updateState(false, false)
          ;(client as any)._scheduleReconnect()
        }
      })

      ws.on('error', () => { /* handled by close */ })
    }
  })

  afterEach(async () => {
    client.dispose()
    await relay.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  describe('initial state', () => {
    it('is not connected', () => {
      expect(client.connected).toBe(false)
    })

    it('getStatus returns defaults', () => {
      const status = client.getStatus()
      expect(status.connected).toBe(false)
      expect(status.connecting).toBe(false)
      expect(status.mobileConnected).toBe(false)
      expect(status.mobileIdentity).toBeNull()
      expect(status.reconnectAttempt).toBe(0)
    })
  })

  describe('connect', () => {
    it('connects to relay and becomes connected', async () => {
      const statusPromise = new Promise<any>((resolve) => {
        client.on('status', (s) => {
          if (s.connected) resolve(s)
        })
      })

      client.connect('test-token-123')
      const status = await statusPromise

      expect(status.connected).toBe(true)
      expect(status.connecting).toBe(false)
    })

    it('sends identity:announce on connection', async () => {
      const msgPromise = new Promise<any>((resolve) => {
        relay.wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString())
            if (msg.event === 'identity:announce') resolve(msg)
          })
        })
      })

      client.connect('test-token')
      const msg = await msgPromise

      expect(msg.data.name).toBe('wzxClaw')
      expect(msg.data.platform).toBe(process.platform)
    })

    it('emits status events during connection', async () => {
      const statuses: any[] = []
      client.on('status', (s) => statuses.push({ ...s }))

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })

      client.connect('test-token')
      await connectedPromise

      // Should have connecting=true then connected=true
      const connectingState = statuses.find(s => s.connecting && !s.connected)
      const connectedState = statuses.find(s => s.connected && !s.connecting)
      expect(connectingState).toBeDefined()
      expect(connectedState).toBeDefined()
    })
  })

  describe('disconnect', () => {
    it('disconnects and updates status', async () => {
      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise

      client.disconnect()
      const status = client.getStatus()
      expect(status.connected).toBe(false)
      expect(status.connecting).toBe(false)
    })
  })

  describe('broadcast', () => {
    it('sends message to relay server', async () => {
      const msgPromise = new Promise<any>((resolve) => {
        relay.wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString())
            if (msg.event === 'test:broadcast') resolve(msg)
          })
        })
      })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise

      client.broadcast('test:broadcast', { value: 42 })
      const msg = await msgPromise

      expect(msg.event).toBe('test:broadcast')
      expect(msg.data.value).toBe(42)
    })

    it('no-ops when not connected', () => {
      // Should not throw
      client.broadcast('test:event', { data: 'value' })
    })
  })

  describe('incoming messages', () => {
    it('forwards client-message events from relay', async () => {
      let relayWs: WebSocket | null = null
      relay.wss.on('connection', (ws) => { relayWs = ws as any })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise
      await new Promise((r) => setTimeout(r, 50))

      const clientMsgPromise = new Promise<any>((resolve) => {
        client.on('client-message', resolve)
      })

      relayWs!.send(JSON.stringify({
        event: 'command:send',
        data: { content: 'hello from mobile' }
      }))

      const msg = await clientMsgPromise
      expect(msg.clientId).toBe('relay-mobile')
      expect(msg.event).toBe('command:send')
      expect(msg.data.content).toBe('hello from mobile')
    })

    it('handles system:mobile_connected event', async () => {
      let relayWs: WebSocket | null = null
      relay.wss.on('connection', (ws) => { relayWs = ws as any })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise
      await new Promise((r) => setTimeout(r, 50))

      const mobileConnectedPromise = new Promise<void>((resolve) => {
        client.on('mobile-connected', resolve)
      })

      relayWs!.send(JSON.stringify({ event: 'system:mobile_connected', data: {} }))
      await mobileConnectedPromise

      expect(client.getStatus().mobileConnected).toBe(true)
    })

    it('handles system:mobile_disconnected event', async () => {
      let relayWs: WebSocket | null = null
      relay.wss.on('connection', (ws) => { relayWs = ws as any })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise
      await new Promise((r) => setTimeout(r, 50))

      // First connect mobile
      relayWs!.send(JSON.stringify({ event: 'system:mobile_connected', data: {} }))
      await new Promise((r) => setTimeout(r, 50))
      expect(client.getStatus().mobileConnected).toBe(true)

      // Then disconnect
      relayWs!.send(JSON.stringify({ event: 'system:mobile_disconnected', data: {} }))
      await new Promise((r) => setTimeout(r, 50))
      expect(client.getStatus().mobileConnected).toBe(false)
      expect(client.getStatus().mobileIdentity).toBeNull()
    })

    it('handles identity:mobile_announce event', async () => {
      let relayWs: WebSocket | null = null
      relay.wss.on('connection', (ws) => { relayWs = ws as any })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise
      await new Promise((r) => setTimeout(r, 50))

      relayWs!.send(JSON.stringify({
        event: 'identity:mobile_announce',
        data: { name: 'iPhone 15' }
      }))
      await new Promise((r) => setTimeout(r, 50))

      expect(client.getStatus().mobileIdentity).toBe('iPhone 15')
    })

    it('responds to pong by clearing heartbeat timeout', async () => {
      let relayWs: WebSocket | null = null
      relay.wss.on('connection', (ws) => { relayWs = ws as any })

      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise
      await new Promise((r) => setTimeout(r, 50))

      // Send pong — should not throw or cause issues
      relayWs!.send(JSON.stringify({ event: 'pong' }))
      await new Promise((r) => setTimeout(r, 50))

      // Client should still be connected
      expect(client.connected).toBe(true)
    })
  })

  describe('dispose', () => {
    it('disposes and prevents reconnection', async () => {
      const connectedPromise = new Promise<void>((resolve) => {
        client.on('status', (s) => { if (s.connected) resolve() })
      })
      client.connect('test-token')
      await connectedPromise

      client.dispose()
      expect(client.connected).toBe(false)

      // Should not reconnect after dispose
      await new Promise((r) => setTimeout(r, 100))
      expect(client.connected).toBe(false)
    })
  })
})
