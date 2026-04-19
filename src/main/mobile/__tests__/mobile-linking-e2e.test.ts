import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MobileServer } from '../mobile-server'
import { generateQRCode } from '../qr-generator'
import WebSocket from 'ws'

/**
 * End-to-end tests for mobile ↔ desktop QR linking flow.
 *
 * Tests the complete lifecycle:
 *   1. Desktop starts MobileServer → gets port + token
 *   2. QR code generated containing connection URL
 *   3. Mobile scans QR → connects via WebSocket with token
 *   4. Bidirectional messaging works
 *   5. Session management protocol is correct
 *   6. Multiple client scenarios
 *   7. Reconnection behavior
 *   8. Graceful shutdown
 */

// Mock electron
vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

describe('Mobile QR Linking E2E', () => {
  let server: MobileServer

  beforeEach(() => {
    server = new MobileServer()
  })

  afterEach(async () => {
    if (server.isRunning) {
      await server.stop()
    }
    await new Promise((r) => setTimeout(r, 50))
  })

  describe('QR code generation flow', () => {
    it('generates valid QR code containing connection URL', async () => {
      const { port, token } = await server.start(0)
      const localUrl = `http://localhost:${port}?token=${token}`
      const qrCode = await generateQRCode(localUrl)

      expect(qrCode).toMatch(/^data:image\/png;base64,/)
      // QR code should be non-trivially sized (>500 bytes base64)
      expect(qrCode.length).toBeGreaterThan(500)
    })

    it('token is 64 hex characters', async () => {
      const { token } = await server.start(0)
      expect(token).toHaveLength(64)
      expect(token).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('full connection lifecycle', () => {
    it('mobile connects with QR token → receives welcome → sends command → gets broadcast', async () => {
      const { port, token } = await server.start(0)

      // Step 1: Mobile scans QR code → connects with token from URL
      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)

      // Step 2: Receive welcome message with clientId
      const welcome = await new Promise<any>((resolve) => {
        ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      })
      expect(welcome.event).toBe('connected')
      expect(welcome.data.clientId).toBeDefined()
      const clientId = welcome.data.clientId

      // Step 3: Mobile sends a command
      const clientMsgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })
      ws.send(JSON.stringify({
        event: 'command:send',
        data: { content: 'Write a hello world function' }
      }))
      const received = await clientMsgPromise
      expect(received.clientId).toBe(clientId)
      expect(received.event).toBe('command:send')
      expect(received.data.content).toBe('Write a hello world function')

      // Step 4: Desktop broadcasts agent response to mobile
      const broadcastPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => resolve(JSON.parse(data.toString())))
      })
      server.broadcast('stream:agent:text', { type: 'agent:text', content: 'Hello!' })
      const response = await broadcastPromise
      expect(response.event).toBe('stream:agent:text')
      expect(response.data.content).toBe('Hello!')

      ws.close()
      await new Promise((r) => setTimeout(r, 100))
    })

    it('mobile rejected with wrong token', async () => {
      const { port } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=wrong-token-from-old-qr`)
      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })

      expect(closeCode).toBe(4001) // Unauthorized
    })

    it('mobile rejected with no token', async () => {
      const { port } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}`)
      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })

      expect(closeCode).toBe(4001)
    })
  })

  describe('session management protocol', () => {
    it('mobile sends session:list:request → server emits client-message with correct shape', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((resolve) => ws.on('open', resolve))
      await new Promise((r) => setTimeout(r, 50)) // drain welcome

      const msgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })

      ws.send(JSON.stringify({
        event: 'session:list:request',
        data: { requestId: 'req-001' }
      }))

      const msg = await msgPromise
      expect(msg.event).toBe('session:list:request')
      expect(msg.data.requestId).toBe('req-001')
      expect(msg.clientId).toBeDefined()

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('desktop broadcasts session:list:response to mobile', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((resolve) => ws.on('open', resolve))
      await new Promise((r) => setTimeout(r, 100)) // wait for welcome

      // Collect non-welcome messages
      const msgPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.event !== 'connected') resolve(parsed)
        })
      })

      server.broadcast('session:list:response', {
        requestId: 'req-001',
        workspaceName: 'my-project',
        sessions: [{ id: 's1', title: 'Chat 1' }]
      })

      const msg = await msgPromise
      expect(msg.event).toBe('session:list:response')
      expect(msg.data.requestId).toBe('req-001')
      expect(msg.data.sessions).toHaveLength(1)

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('multi-client scenarios', () => {
    it('broadcast reaches all connected mobiles', async () => {
      const { port, token } = await server.start(0)

      const ws1 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      const ws2 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])
      // Drain welcome messages
      await new Promise((r) => setTimeout(r, 100))

      const msgs1: any[] = []
      const msgs2: any[] = []
      ws1.on('message', (d) => msgs1.push(JSON.parse(d.toString())))
      ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString())))

      server.broadcast('stream:agent:done', { usage: { inputTokens: 100, outputTokens: 50 } })
      await new Promise((r) => setTimeout(r, 100))

      expect(msgs1).toHaveLength(1)
      expect(msgs2).toHaveLength(1)
      expect(msgs1[0].event).toBe('stream:agent:done')
      expect(msgs2[0].data.usage.inputTokens).toBe(100)

      ws1.close()
      ws2.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('one client disconnect does not affect others', async () => {
      const { port, token } = await server.start(0)

      const ws1 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      const ws2 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])
      await new Promise((r) => setTimeout(r, 100))

      // Disconnect first client
      ws1.close()
      await new Promise((r) => setTimeout(r, 100))

      // Second client should still receive broadcasts
      const msgs2: any[] = []
      ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString())))

      server.broadcast('stream:agent:text', { content: 'still working' })
      await new Promise((r) => setTimeout(r, 100))

      expect(msgs2).toHaveLength(1)
      expect(msgs2[0].data.content).toBe('still working')

      ws2.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('tracks client count correctly', async () => {
      const { port, token } = await server.start(0)

      expect(server.connectedClients).toHaveLength(0)

      const ws1 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws1.on('open', r))
      await new Promise((r) => setTimeout(r, 50))
      expect(server.connectedClients).toHaveLength(1)

      const ws2 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws2.on('open', r))
      await new Promise((r) => setTimeout(r, 50))
      expect(server.connectedClients).toHaveLength(2)

      ws1.close()
      await new Promise((r) => setTimeout(r, 100))
      expect(server.connectedClients).toHaveLength(1)

      ws2.close()
      await new Promise((r) => setTimeout(r, 100))
      expect(server.connectedClients).toHaveLength(0)
    })
  })

  describe('agent stream event forwarding', () => {
    it('forwards all stream event types to mobile', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 100)) // wait for welcome

      const messages: any[] = []
      ws.on('message', (d) => {
        const parsed = JSON.parse(d.toString())
        if (parsed.event !== 'connected') messages.push(parsed)
      })

      // Simulate a full agent turn
      server.broadcast('stream:agent:thinking', { type: 'agent:thinking', content: 'thinking...' })
      server.broadcast('stream:agent:text', { type: 'agent:text', content: 'Here is my answer' })
      server.broadcast('stream:agent:tool_call', {
        type: 'agent:tool_call',
        toolCallId: 'tc-1',
        toolName: 'FileRead'
      })
      server.broadcast('stream:agent:tool_result', {
        type: 'agent:tool_result',
        toolCallId: 'tc-1',
        toolName: 'FileRead',
        output: 'file contents...',
        isError: false
      })
      server.broadcast('stream:agent:turn_end', { type: 'agent:turn_end' })
      server.broadcast('stream:agent:done', {
        type: 'agent:done',
        usage: { inputTokens: 500, outputTokens: 200 }
      })

      await new Promise((r) => setTimeout(r, 200))

      expect(messages.length).toBeGreaterThanOrEqual(6)
      const events = messages.map(m => m.event)
      expect(events).toContain('stream:agent:thinking')
      expect(events).toContain('stream:agent:text')
      expect(events).toContain('stream:agent:tool_call')
      expect(events).toContain('stream:agent:tool_result')
      expect(events).toContain('stream:agent:turn_end')
      expect(events).toContain('stream:agent:done')

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('forwards error events to mobile', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 100)) // wait for welcome

      const msgPromise = new Promise<any>((resolve) => {
        ws.on('message', (d) => {
          const parsed = JSON.parse(d.toString())
          if (parsed.event !== 'connected') resolve(parsed)
        })
      })

      server.broadcast('stream:error', { error: 'API rate limit exceeded' })
      const msg = await msgPromise
      expect(msg.event).toBe('stream:error')
      expect(msg.data.error).toBe('API rate limit exceeded')

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('command protocol', () => {
    it('mobile sends command:stop → server emits it', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 50))

      const msgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })

      ws.send(JSON.stringify({ event: 'command:stop', data: {} }))
      const msg = await msgPromise
      expect(msg.event).toBe('command:stop')

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('mobile sends slash command /compact', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 50))

      const msgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })

      ws.send(JSON.stringify({
        event: 'command:send',
        data: { content: '/compact' }
      }))
      const msg = await msgPromise
      expect(msg.event).toBe('command:send')
      expect(msg.data.content).toBe('/compact')

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    it('handles malformed JSON from mobile gracefully', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 50))

      // Send garbage — should not crash server
      ws.send('not valid json {{{')
      await new Promise((r) => setTimeout(r, 100))

      // Server should still be running
      expect(server.isRunning).toBe(true)

      // And should still accept new messages
      const msgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })
      ws.send(JSON.stringify({ event: 'test', data: {} }))
      const msg = await msgPromise
      expect(msg.event).toBe('test')

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('graceful shutdown', () => {
    it('server stop closes all mobile connections', async () => {
      const { port, token } = await server.start(0)

      const ws1 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      const ws2 = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])

      const close1 = new Promise<number>((resolve) => ws1.on('close', (code) => resolve(code)))
      const close2 = new Promise<number>((resolve) => ws2.on('close', (code) => resolve(code)))

      await server.stop()

      const [code1, code2] = await Promise.all([close1, close2])
      expect(code1).toBe(1000) // Normal close
      expect(code2).toBe(1000)
      expect(server.isRunning).toBe(false)
      expect(server.connectedClients).toHaveLength(0)
    })

    it('server restart generates new token (old QR invalid)', async () => {
      const first = await server.start(0)
      await server.stop()

      const second = await server.start(0)
      // Token should be different after restart
      expect(second.token).not.toBe(first.token)

      // Old token should be rejected
      const ws = new WebSocket(`ws://localhost:${second.port}?token=${first.token}`)
      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      expect(closeCode).toBe(4001)
    })
  })

  describe('plan mode protocol', () => {
    it('forwards plan:decision from mobile', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 50))

      const msgPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })

      ws.send(JSON.stringify({
        event: 'plan:decision',
        data: { approved: true }
      }))

      const msg = await msgPromise
      expect(msg.event).toBe('plan:decision')
      expect(msg.data.approved).toBe(true)

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  describe('ask-user protocol', () => {
    it('broadcasts question to mobile and receives answer', async () => {
      const { port, token } = await server.start(0)

      const ws = new WebSocket(`ws://localhost:${port}?token=${token}`)
      await new Promise<void>((r) => ws.on('open', r))
      await new Promise((r) => setTimeout(r, 100)) // wait for welcome

      // Desktop sends question to mobile
      const questionPromise = new Promise<any>((resolve) => {
        ws.on('message', (d) => {
          const parsed = JSON.parse(d.toString())
          if (parsed.event !== 'connected') resolve(parsed)
        })
      })
      server.broadcast('stream:agent:ask_user_question', {
        questionId: 'q-1',
        question: 'Which file should I modify?',
        options: ['src/main.ts', 'src/app.ts']
      })
      const question = await questionPromise
      expect(question.event).toBe('stream:agent:ask_user_question')
      expect(question.data.options).toHaveLength(2)

      // Mobile sends answer
      const answerPromise = new Promise<any>((resolve) => {
        server.on('client-message', resolve)
      })
      ws.send(JSON.stringify({
        event: 'ask-user:answer',
        data: { questionId: 'q-1', selectedLabels: ['src/main.ts'] }
      }))
      const answer = await answerPromise
      expect(answer.event).toBe('ask-user:answer')
      expect(answer.data.selectedLabels).toEqual(['src/main.ts'])

      ws.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })
})
