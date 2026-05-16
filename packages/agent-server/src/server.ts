// ============================================================
// AgentServer — HTTP + WebSocket 服务器入口
// 初始化所有子模块（auth、session、hands、client handler）
// 管理客户端和 Hand WebSocket 连接的路由分发
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URL } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { initAuth, authenticate } from './auth.js'
import { SessionStoreSqlite } from './session-sqlite.js'
import { HandsRouter } from './hands-router.js'
import { HandAwareToolExecutor } from './hand-aware-tool-executor.js'
import { ClientHandler } from './client-handler.js'
import { buildSystemPrompt } from './instructions/system-prompt-builder.js'
import { handleReload } from './admin/reload-handler.js'
import { handleConfig } from './admin/config-handler.js'
import type { ServerConfig } from './types.js'
import {
  ContextManager,
  DEFAULT_MODELS,
  LLMGateway,
  createAgentLoop,
  type AgentConfig,
  type LLMProvider,
} from '@wzxclaw/brain'

/** 服务器启动时间戳 */
let startTime = 0

/**
 * AgentServer — HTTP + WebSocket 服务器
 *
 * 职责:
 * - HTTP /health 端点返回服务状态
 * - WebSocket 连接根据 type 参数路由到 client 或 hand handler
 * - Token 认证保护所有连接
 * - 优雅关闭
 */
export class AgentServer {
  private readonly config: ServerConfig
  private readonly sessionStore: SessionStoreSqlite
  private readonly handsRouter: HandsRouter
  private readonly toolExecutor: HandAwareToolExecutor
  private readonly clientHandler: ClientHandler
  private httpServer: ReturnType<typeof createServer> | null = null
  private wss: WebSocketServer | null = null

  constructor(config: ServerConfig) {
    this.config = config

    // 初始化认证
    if (config.authToken) {
      process.env.AUTH_TOKEN = config.authToken
    }
    initAuth()

    // 初始化子模块
    this.sessionStore = new SessionStoreSqlite(config.dbPath)
    this.handsRouter = new HandsRouter()
    this.toolExecutor = new HandAwareToolExecutor(this.handsRouter)
    const { createLoop, agentConfig } = createProductionAgentRuntime(config)
    this.clientHandler = new ClientHandler(
      this.sessionStore,
      this.toolExecutor,
      createLoop,
      agentConfig,
    )
  }

  /**
   * 获取 ClientHandler 实例（用于外部配置 AgentLoop 工厂）
   */
  getClientHandler(): ClientHandler {
    return this.clientHandler
  }

  /**
   * 获取 HandsRouter 实例
   */
  getHandsRouter(): HandsRouter {
    return this.handsRouter
  }

  /**
   * 创建 HTTP 服务器
   * /health 端点返回服务状态信息
   */
  createHttpServer(): ReturnType<typeof createServer> {
    return createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/'
      if (url === '/health') {
        res.writeHead(200, { 'Content': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          hands: this.handsRouter.getHandCount(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        }))
        return
      }

      // Admin API 路由
      if (url === '/admin/reload' && req.method === 'POST') {
        handleReload(req, res, this.handsRouter)
        return
      }
      if (url.startsWith('/admin/config/')) {
        handleConfig(req, res)
        return
      }
      // Serve test.html at /
      if (url === '/' || url === '/index.html') {
        try {
          const __dirname = dirname(fileURLToPath(import.meta.url))
          const html = readFileSync(resolve(__dirname, '..', 'test.html'), 'utf-8')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<h1>Agent Server</h1><p>Hand count: ' + this.handsRouter.getHandCount() + '</p>')
        }
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    })
  }

  /**
   * 创建 WebSocket 服务器并注册连接处理
   */
  createWss(httpServer: ReturnType<typeof createServer>): WebSocketServer {
    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: 10 * 1024 * 1024, // 10 MB 限制（Agent 工具调用可能较大）
    })

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req)
    })

    return wss
  }

  /**
   * 处理新的 WebSocket 连接
   *
   * 1. 从 Sec-WebSocket-Protocol 头或 query string 提取 token
   * 2. 验证 token
   * 3. 根据 type 参数路由到 client 或 hand handler
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // 提取 token — 复用 relay server.js 的提取逻辑
    let token = ''
    const protoHeader = req.headers['sec-websocket-protocol'] ?? ''
    if (protoHeader) {
      const parts = String(protoHeader).split(',').map(s => s.trim())
      for (const part of parts) {
        if (part.startsWith('wzxclaw-')) {
          token = part.slice('wzxclaw-'.length)
          break
        }
      }
    }
    if (!token) {
      token = reqUrl.searchParams.get('token') || ''
    }

    // 认证
    const authResult = authenticate(token)
    if (!authResult.ok) {
      ws.close(4001, authResult.reason)
      return
    }

    // 提取连接类型
    const connType = reqUrl.searchParams.get('type') || 'client'

    if (connType === 'client') {
      // 客户端连接 → ClientHandler 处理
      this.clientHandler.handleConnection(ws)
    } else if (connType === 'hand') {
      // Hand 连接 → 直接处理注册/结果/心跳
      this.handleHandConnection(ws)
    } else {
      ws.close(4003, `invalid connection type: ${connType}`)
    }
  }

  /**
   * 处理 Hand 类型 WebSocket 连接
   *
   * 监听消息:
   * - hand:register → 注册 Hand 到路由表
   * - hand:result → 工具执行结果回传
   * - hand:heartbeat → 心跳更新
   * 监听关闭 → 注销 Hand + 清理 pending 工具调用
   */
  private handleHandConnection(ws: WebSocket): void {
    let handId: string | null = null

    ws.on('message', (raw: unknown) => {
      let parsed: { event: string; data?: unknown }
      try {
        const str = typeof raw === 'string' ? raw : String(raw)
        parsed = JSON.parse(str)
      } catch {
        return
      }

      const { event, data } = parsed

      switch (event) {
        case 'hand:register': {
          const regData = data as { id: string; capabilities: string[]; definitions: unknown[] }
          handId = regData.id
          this.handsRouter.register({
            ws,
            id: regData.id,
            capabilities: regData.capabilities,
            definitions: regData.definitions as Parameters<typeof this.handsRouter.register>[0]['definitions'],
            lastHeartbeat: Date.now(),
          })
          break
        }
        case 'hand:result': {
          const resultData = data as { callId: string; output: string; isError: boolean }
          this.toolExecutor.handleResult(resultData.callId, resultData.output, resultData.isError)
          break
        }
        case 'hand:heartbeat': {
          if (handId) {
            this.handsRouter.updateHeartbeat(handId)
            // 回复 pong
            ws.send(JSON.stringify({ event: 'hand:heartbeat_ack' }))
          }
          break
        }
      }
    })

    ws.on('close', () => {
      if (handId) {
        this.handsRouter.unregister(handId)
        this.toolExecutor.handleHandDisconnect(handId)
      }
    })
  }

  /**
   * 启动服务器
   */
  start(): Promise<void> {
    startTime = Date.now()

    return new Promise((resolve) => {
      this.httpServer = this.createHttpServer()
      this.wss = this.createWss(this.httpServer)

      this.httpServer.listen(this.config.port, () => {
        console.log(`[agent-server] Listening on port ${this.config.port}`)
        resolve()
      })
    })
  }

  /**
   * 优雅关闭
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // 先关闭 WebSocket 服务器
      if (this.wss) {
        for (const ws of this.wss.clients) {
          ws.close(1001, 'server shutting down')
        }
        this.wss.close()
      }

      // 关闭 HTTP 服务器
      if (this.httpServer) {
        this.httpServer.close(() => {
          // 关闭数据库
          this.sessionStore.close()
          console.log('[agent-server] Server stopped')
          resolve()
        })
      } else {
        resolve()
      }

      // 强制关闭超时
      setTimeout(() => {
        console.error('[agent-server] Forced shutdown after timeout')
        process.exit(1)
      }, 5000)
    })
  }
}

function resolveProvider(model: string, explicitProvider?: string): LLMProvider {
  if (explicitProvider === 'anthropic' || explicitProvider === 'openai') return explicitProvider
  const preset = DEFAULT_MODELS.find((item) => item.id === model)
  return (preset?.provider as LLMProvider | undefined) ?? (model.startsWith('claude') || model.startsWith('glm-5') ? 'anthropic' : 'openai')
}

function createProductionAgentRuntime(config: ServerConfig): {
  createLoop: () => ReturnType<typeof createAgentLoop>
  agentConfig: Partial<Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory' | 'projectRoots'>>
} {
  const model = process.env.AGENT_MODEL || process.env.MODEL || 'deepseek-chat'
  const provider = resolveProvider(model, process.env.AGENT_PROVIDER || process.env.PROVIDER)
  const workingDirectory = process.env.AGENT_WORKDIR || '/tmp'
  const projectRoots = (process.env.AGENT_PROJECT_ROOTS || workingDirectory)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)

  const gateway = new LLMGateway()

  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    gateway.addProvider({
      provider: 'openai',
      apiKey: openaiKey,
      baseURL: process.env.OPENAI_BASE_URL,
    })
  }

  const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    gateway.addProvider({
      provider: 'anthropic',
      apiKey: anthropicKey,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    })
  }

  const contextManager = new ContextManager()

  // 构建含指令的 system prompt
  const basePrompt = config.systemPrompt || process.env.AGENT_SYSTEM_PROMPT || ''
  const systemPrompt = buildSystemPrompt({ basePrompt })

  return {
    createLoop: () => createAgentLoop({ gateway, contextManager }),
    agentConfig: {
      model,
      provider,
      systemPrompt,
      workingDirectory,
      projectRoots,
    },
  }
}

// ---- 模块级 main 函数 ----

/**
 * 从环境变量读取配置并启动服务器
 */
export function main(): void {
  const port = parseInt(process.env.PORT || '8082', 10)
  const authToken = process.env.AUTH_TOKEN
  const dbPath = process.env.DB_PATH || '/data/sessions.db'

  const server = new AgentServer({
    port,
    authToken,
    dbPath,
  })

  server.start().then(() => {
    console.log(`[agent-server] Started — port=${port}, db=${dbPath}`)
  }).catch((err) => {
    console.error('[agent-server] Failed to start:', err)
    process.exit(1)
  })

  // 优雅关闭信号处理
  const shutdown = (signal: string) => {
    console.log(`[agent-server] Received ${signal}, shutting down...`)
    server.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 直接运行时启动服务器
// import.meta.url check: 只在直接运行时执行 main
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main()
}
