// ============================================================
// MCP Client — Connects to MCP servers via Stdio or SSE
// ============================================================

import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'

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

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private connected = false
  private serverName: string

  constructor(private config: MCPServerConfig) {
    super()
    this.serverName = config.name
  }

  async connect(): Promise<void> {
    if (this.config.transport === 'stdio') {
      await this.connectStdio()
    } else {
      throw new Error(`SSE transport not yet implemented for MCP client "${this.serverName}"`)
    }
  }

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

      const data = JSON.stringify(msg) + '\n'
      this.process?.stdin?.write(data, (err) => {
        if (err) {
          this.pendingRequests.delete(id)
          reject(err)
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`MCP request "${method}" timed out`))
        }
      }, 30000)
    })
  }

  private sendNotification(method: string, params?: unknown): void {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params }
    this.process?.stdin?.write(JSON.stringify(msg) + '\n')
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
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.pendingRequests.clear()
  }
}
