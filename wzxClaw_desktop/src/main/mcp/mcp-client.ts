// ============================================================
// MCP Client — Connects to MCP servers via Stdio or SSE
// ============================================================

import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import https from 'https'
import http from 'http'

export interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string  // base64
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type PendingRequest = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private connected = false
  private serverName: string

  // SSE transport state
  private sseResponse: http.IncomingMessage | null = null
  private ssePostEndpoint: string = ''
  private sseBuffer = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private static readonly MAX_RECONNECT_ATTEMPTS = 10

  constructor(private config: MCPServerConfig) {
    super()
    this.serverName = config.name
  }

  async connect(): Promise<void> {
    if (this.config.transport === 'sse') {
      await this.connectSSE()
    } else {
      await this.connectStdio()
    }
  }

  // ---- Stdio Transport ----

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`No command specified for MCP server "${this.serverName}"`)
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      shell: true
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      this.processBuffer()
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      console.warn(`[MCP:${this.serverName}] stderr:`, data.toString().trim())
    })

    this.process.on('exit', (code) => {
      this.connected = false
      console.log(`[MCP:${this.serverName}] Process exited with code ${code}`)
      this.emit('disconnected')
    })

    this.process.on('error', (err) => {
      console.error(`[MCP:${this.serverName}] Process error:`, err)
      this.emit('error', err)
    })

    // Initialize the connection
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wzxClaw', version: '1.0.0' }
    })

    // Send initialized notification
    this.sendNotification('notifications/initialized', {})
    this.connected = true
  }

  // ---- SSE Transport ----

  /**
   * 连接到 SSE 类型的 MCP 服务器。
   * 流程：
   *   1. GET {url}/sse 建立 SSE 流，接收 endpoint 事件获取 POST 地址
   *   2. POST JSON-RPC 请求到该地址
   *   3. 响应通过 SSE 流返回
   */
  private async connectSSE(): Promise<void> {
    if (!this.config.url) {
      throw new Error(`No URL specified for SSE MCP server "${this.serverName}"`)
    }

    const baseUrl = this.config.url.replace(/\/$/, '')
    const sseUrl = `${baseUrl}/sse`

    // 步骤 1：建立 SSE 连接，等待 endpoint 事件
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSE connection to "${sseUrl}" timed out (15s)`))
      }, 15000)

      const doConnect = () => {
        const mod = sseUrl.startsWith('https') ? https : http
        mod.get(sseUrl, (res) => {
          if (res.statusCode !== 200) {
            clearTimeout(timer)
            reject(new Error(`SSE connection returned status ${res.statusCode}`))
            res.resume()
            return
          }

          this.sseResponse = res

          res.on('data', (chunk: Buffer) => {
            this.sseBuffer += chunk.toString()
            this.processSSEBuffer((msg) => {
              clearTimeout(timer)
              resolve(msg)
            })
          })

          res.on('end', () => {
            this.connected = false
            console.log(`[MCP:${this.serverName}] SSE stream ended`)
            this.scheduleReconnect()
          })

          res.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
          })
        }).on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      }

      doConnect()
    })

    // 解析 POST endpoint（可能是相对路径或完整 URL）
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      this.ssePostEndpoint = endpoint
    } else {
      this.ssePostEndpoint = `${baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    }

    console.log(`[MCP:${this.serverName}] SSE connected, POST endpoint: ${this.ssePostEndpoint}`)

    // 步骤 2：初始化连接
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wzxClaw', version: '1.0.0' }
    })

    this.sendNotification('notifications/initialized', {})
    this.connected = true
  }

  /**
   * 解析 SSE buffer，提取完整事件并处理。
   * SSE 格式：`event: xxx\ndata: yyy\n\n`
   */
  private processSSEBuffer(onEndpoint: (endpoint: string) => void): void {
    const parts = this.sseBuffer.split('\n\n')
    // 最后一段可能不完整，保留
    this.sseBuffer = parts.pop() ?? ''

    for (const part of parts) {
      let eventType = 'message'
      let data = ''
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.substring(6).trim()
        } else if (line.startsWith('data:')) {
          data += line.substring(5).trim()
        }
      }

      if (!data) continue

      if (eventType === 'endpoint') {
        // endpoint 事件携带 POST 路径
        onEndpoint(data)
      } else {
        // 其他事件是 JSON-RPC 消息
        try {
          const msg: JsonRpcMessage = JSON.parse(data)
          this.handleMessage(msg)
        } catch {
          // 忽略非 JSON 数据
        }
      }
    }
  }

  /**
   * SSE 断开后自动重连（延迟 5 秒重试，最多 10 次）。
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= MCPClient.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[MCP:${this.serverName}] Max reconnect attempts (${MCPClient.MAX_RECONNECT_ATTEMPTS}) reached, giving up`)
      this.emit('reconnect-failed')
      return
    }
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        console.log(`[MCP:${this.serverName}] SSE reconnecting (attempt ${this.reconnectAttempts}/${MCPClient.MAX_RECONNECT_ATTEMPTS})...`)
        await this.connectSSE()
        this.reconnectAttempts = 0  // 重置计数器
        console.log(`[MCP:${this.serverName}] SSE reconnected`)
        this.emit('reconnected')
      } catch (err) {
        console.warn(`[MCP:${this.serverName}] SSE reconnect failed:`, err)
        this.scheduleReconnect()
      }
    }, 5000)
  }

  // ---- 消息处理（stdio 和 SSE 共用） ----

  private processBuffer(): void {
    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? '' // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg: JsonRpcMessage = JSON.parse(trimmed)
        this.handleMessage(msg)
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      // Response to a request
      const pending = this.pendingRequests.get(msg.id as number)
      if (pending) {
        this.pendingRequests.delete(msg.id as number)
        if (pending.timer) clearTimeout(pending.timer)
        if (msg.error) {
          pending.reject(new Error(`MCP error: ${msg.error.message}`))
        } else {
          pending.resolve(msg.result)
        }
      }
    } else if (msg.method) {
      // Notification or server request
      this.emit('notification', msg.method, msg.params)
    }
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const msg: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params
      }

      this.pendingRequests.set(id, { resolve, reject })

      // SSE transport: HTTP POST
      if (this.config.transport === 'sse' && this.ssePostEndpoint) {
        this.postJsonRpc(msg, id, reject)
        return
      }

      // Timeout after 30 seconds
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`MCP request "${method}" timed out`))
        }
      }, 30000)

      // Store timer on pending entry so handleMessage can clear it
      const entry = this.pendingRequests.get(id)
      if (entry) entry.timer = timer

      // Stdio transport: stdin
      const data = JSON.stringify(msg) + '\n'
      this.process?.stdin?.write(data, (err) => {
        if (err) {
          this.pendingRequests.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  /**
   * 通过 HTTP POST 发送 JSON-RPC 请求（SSE transport）。
   */
  private postJsonRpc(msg: JsonRpcMessage, id: number, reject: (e: Error) => void): void {
    const body = JSON.stringify(msg)
    const url = new URL(this.ssePostEndpoint)
    const mod = url.protocol === 'https:' ? https : http

    const timer = setTimeout(() => {
      if (this.pendingRequests.has(id)) {
        this.pendingRequests.delete(id)
        reject(new Error(`MCP request "${msg.method}" timed out`))
      }
    }, 30000)

    const entry = this.pendingRequests.get(id)
    if (entry) entry.timer = timer

    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      // 读取响应但不通过 HTTP 响应获取结果——结果通过 SSE 流返回
      res.resume()
      if (res.statusCode && res.statusCode >= 400) {
        let errData = ''
        res.on('data', (c: Buffer) => { errData += c.toString() })
        res.on('end', () => {
          const pending = this.pendingRequests.get(id)
          if (pending) {
            this.pendingRequests.delete(id)
            if (pending.timer) clearTimeout(pending.timer)
            pending.reject(new Error(`MCP POST failed (${res.statusCode}): ${errData}`))
          }
        })
      }
    })

    req.on('error', (err) => {
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(err)
      }
    })

    req.write(body)
    req.end()
  }

  private sendNotification(method: string, params?: unknown): void {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params }

    // SSE transport: HTTP POST（无 id，不期待响应）
    if (this.config.transport === 'sse' && this.ssePostEndpoint) {
      const body = JSON.stringify(msg)
      const url = new URL(this.ssePostEndpoint)
      const mod = url.protocol === 'https:' ? https : http
      const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume() })
      req.on('error', () => {})  // 通知发送失败不阻塞
      req.write(body)
      req.end()
      return
    }

    // Stdio transport
    this.process?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  // ---- 公共 API ----

  async listResources(): Promise<MCPResource[]> {
    const result = await this.sendRequest('resources/list', {}) as { resources?: MCPResource[] }
    return result?.resources ?? []
  }

  async readResource(uri: string): Promise<MCPResourceContent[]> {
    const result = await this.sendRequest('resources/read', { uri }) as { contents?: MCPResourceContent[] }
    return result?.contents ?? []
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {}) as { tools?: MCPToolDefinition[] }
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const result = await this.sendRequest('tools/call', { name, arguments: args })
    return result as { content: Array<{ type: string; text?: string }> }
  }

  isConnected(): boolean {
    return this.connected
  }

  getServerName(): string {
    return this.serverName
  }

  disconnect(): void {
    this.connected = false

    // 清理 SSE 资源
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sseResponse) {
      this.sseResponse.destroy()
      this.sseResponse = null
    }

    // 清理 stdio 进程
    if (this.process) {
      this.process.kill()
      this.process = null
    }

    this.pendingRequests.clear()
  }
}
