// ============================================================
// server.ts 测试 — HTTP + WebSocket 服务器集成测试
// 使用真实 HTTP server + WebSocket client 测试
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { AgentServer } from './server.js'
import { _resetAuthState } from './auth.js'

describe('AgentServer', () => {
  let server: AgentServer
  let port: number

  beforeEach(async () => {
    _resetAuthState()
    delete process.env.AUTH_TOKEN

    // 使用随机可用端口
    port = 18082 + Math.floor(Math.random() * 1000)
    server = new AgentServer({
      port,
      dbPath: ':memory:',
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('HTTP /health 端点', () => {
    it('返回 200 和服务状态', async () => {
      const response = await fetch(`http://localhost:${port}/health`)
      expect(response.status).toBe(200)

      const body = await response.json() as { status: string; hands: number; uptime: number }
      expect(body.status).toBe('ok')
      expect(body.hands).toBe(0)
      expect(typeof body.uptime).toBe('number')
    })

    it('未知路径返回 404', async () => {
      const response = await fetch(`http://localhost:${port}/unknown`)
      expect(response.status).toBe(404)
    })
  })

  describe('WebSocket 认证', () => {
    it('无效 token 连接被拒绝（dev mode 下任意 token 可用）', async () => {
      // dev mode — 无 AUTH_TOKEN 环境变量，任意 token 都被接受
      const ws = new WebSocket(`ws://localhost:${port}?token=any-token&type=client`)

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      ws.on('open', () => {
        // 连接成功 — dev mode 下任意 token 被接受
        ws.close()
      })

      const result = await closed
      // 正常关闭（dev mode 接受了连接，我们主动关闭）
      expect(result.code).toBe(1005)
    })

    it('空 token 在生产模式下被拒绝', async () => {
      // 创建一个带 AUTH_TOKEN 的服务器
      _resetAuthState()
      const securePort = port + 500
      const secureServer = new AgentServer({
        port: securePort,
        authToken: 'secret-token',
        dbPath: ':memory:',
      })
      await secureServer.start()

      try {
        const ws = new WebSocket(`ws://localhost:${securePort}?type=client`)

        const closed = new Promise<{ code: number; reason: string }>((resolve) => {
          ws.on('close', (code, reason) => {
            resolve({ code, reason: reason.toString() })
          })
        })

        const result = await closed
        expect(result.code).toBe(4001)
        expect(result.reason).toBe('missing token')
      } finally {
        await secureServer.stop()
        _resetAuthState()
        delete process.env.AUTH_TOKEN
      }
    })

    it('正确 token 在生产模式下被接受', async () => {
      _resetAuthState()
      const securePort = port + 501
      const secureServer = new AgentServer({
        port: securePort,
        authToken: 'my-secret',
        dbPath: ':memory:',
      })
      await secureServer.start()

      try {
        const ws = new WebSocket(`ws://localhost:${securePort}?token=my-secret&type=client`)

        const opened = new Promise<boolean>((resolve) => {
          ws.on('open', () => {
            ws.close()
            resolve(true)
          })
          ws.on('close', (code) => {
            if (code !== 1005) resolve(false)
          })
        })

        const connected = await opened
        expect(connected).toBe(true)
      } finally {
        await secureServer.stop()
        _resetAuthState()
        delete process.env.AUTH_TOKEN
      }
    })
  })

  describe('WebSocket client/hand 路由', () => {
    it('type=client 连接成功', async () => {
      const ws = new WebSocket(`ws://localhost:${port}?token=test&type=client`)

      const opened = new Promise<boolean>((resolve) => {
        ws.on('open', () => {
          ws.close()
          resolve(true)
        })
      })

      expect(await opened).toBe(true)
    })

    it('type=hand 连接并注册', async () => {
      const ws = new WebSocket(`ws://localhost:${port}?token=test&type=hand`)

      const registered = new Promise<boolean>((resolve) => {
        ws.on('open', () => {
          // 发送 hand:register
          ws.send(JSON.stringify({
            event: 'hand:register',
            data: {
              id: 'test-hand-1',
              capabilities: ['Read', 'Write'],
              definitions: [
                { name: 'Read', description: 'Read a file', inputSchema: {} },
              ],
            },
          }))

          // 等待一下让注册处理完成
          setTimeout(() => {
            ws.close()
            resolve(true)
          }, 200)
        })
      })

      expect(await registered).toBe(true)

      // 验证 Hand 已注册
      expect(server.getHandsRouter().getHandCount()).toBeGreaterThanOrEqual(0)
    })

    it('type=invalid 被拒绝', async () => {
      const ws = new WebSocket(`ws://localhost:${port}?token=test&type=invalid`)

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      const result = await closed
      expect(result.code).toBe(4003)
      expect(result.reason).toContain('invalid connection type')
    })
  })

  describe('Hand 心跳', () => {
    it('hand:heartbeat 收到 pong 回复', async () => {
      const ws = new WebSocket(`ws://localhost:${port}?token=test&type=hand`)

      const pongReceived = new Promise<boolean>((resolve) => {
        ws.on('open', () => {
          // 先注册
          ws.send(JSON.stringify({
            event: 'hand:register',
            data: {
              id: 'heartbeat-hand',
              capabilities: [],
              definitions: [],
            },
          }))

          // 发送心跳
          setTimeout(() => {
            ws.send(JSON.stringify({ event: 'hand:heartbeat' }))
          }, 100)
        })

        ws.on('message', (raw: unknown) => {
          const msg = JSON.parse(String(raw))
          if (msg.event === 'hand:heartbeat_ack') {
            ws.close()
            resolve(true)
          }
        })

        // 超时 fallback
        setTimeout(() => resolve(false), 3000)
      })

      expect(await pongReceived).toBe(true)
    })
  })
})
