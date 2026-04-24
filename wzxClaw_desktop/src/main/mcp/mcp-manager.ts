// ============================================================
// MCP Manager — Manages MCP server lifecycle and tool registration
// ============================================================

import fs from 'fs'
import path from 'path'
import { MCPClient, type MCPServerConfig } from './mcp-client'
import { MCPToolWrapper } from './mcp-tool-wrapper'
import type { ToolRegistry } from '../tools/tool-registry'
import { getMcpConfigPath } from '../paths'

interface MCPConfigFile {
  mcpServers?: Record<string, {
    command?: string
    args?: string[]
    url?: string
    transport?: 'stdio' | 'sse'
    env?: Record<string, string>
  }>
}

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map()
  private configPath: string

  constructor(private toolRegistry: ToolRegistry) {
    this.configPath = getMcpConfigPath()
  }

  /**
   * Load MCP server configurations from disk and connect to them.
   */
  async loadAndConnect(): Promise<void> {
    const configs = this.loadConfig()
    for (const config of configs) {
      try {
        await this.connectServer(config)
      } catch (err) {
        console.error(`[MCP] Failed to connect to "${config.name}":`, err)
      }
    }
  }

  /**
   * Connect to a single MCP server and register its tools.
   */
  async connectServer(config: MCPServerConfig): Promise<void> {
    // Disconnect existing connection if any
    const existing = this.clients.get(config.name)
    if (existing) {
      existing.disconnect()
    }

    const client = new MCPClient(config)
    await client.connect()
    this.clients.set(config.name, client)

    // Discover and register tools
    const tools = await client.listTools()
    for (const mcpTool of tools) {
      const wrapper = new MCPToolWrapper(client, mcpTool, config.name)
      this.toolRegistry.register(wrapper)
    }

    console.log(`[MCP] Connected to "${config.name}", registered ${tools.length} tools`)
  }

  /**
   * Disconnect from a server and unregister its tools.
   */
  disconnectServer(name: string): void {
    const client = this.clients.get(name)
    if (client) {
      client.disconnect()
      this.clients.delete(name)
    }
  }

  /**
   * Add a new server config, save to disk, and connect.
   */
  async addServer(config: MCPServerConfig): Promise<void> {
    // Save to config file
    const fileConfig = this.loadConfigFile()
    if (!fileConfig.mcpServers) fileConfig.mcpServers = {}
    fileConfig.mcpServers[config.name] = {
      command: config.command,
      args: config.args,
      url: config.url,
      transport: config.transport,
      env: config.env
    }
    this.saveConfigFile(fileConfig)

    // Connect
    await this.connectServer(config)
  }

  /**
   * Remove a server config from disk and disconnect.
   */
  removeServer(name: string): void {
    this.disconnectServer(name)

    // Remove from config file
    const fileConfig = this.loadConfigFile()
    if (fileConfig.mcpServers) {
      delete fileConfig.mcpServers[name]
      this.saveConfigFile(fileConfig)
    }
  }

  /**
   * List all configured servers and their status.
   */
  listServers(): Array<{ name: string; transport: string; connected: boolean }> {
    const configs = this.loadConfig()
    return configs.map((c) => ({
      name: c.name,
      transport: c.transport,
      connected: this.clients.get(c.name)?.isConnected() ?? false
    }))
  }

  /**
   * List all tools from all connected MCP servers.
   */
  async listAllTools(): Promise<Array<{ name: string; description: string; serverName: string }>> {
    const result: Array<{ name: string; description: string; serverName: string }> = []
    for (const [name, client] of this.clients) {
      if (!client.isConnected()) continue
      try {
        const tools = await client.listTools()
        for (const t of tools) {
          result.push({ name: t.name, description: t.description, serverName: name })
        }
      } catch {
        // Skip disconnected servers
      }
    }
    return result
  }

  /**
   * Disconnect all servers.
   */
  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect()
    }
    this.clients.clear()
  }

  private loadConfig(): MCPServerConfig[] {
    const fileConfig = this.loadConfigFile()
    if (!fileConfig.mcpServers) return []

    return Object.entries(fileConfig.mcpServers).map(([name, cfg]) => ({
      name,
      transport: cfg.transport ?? 'stdio',
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      env: cfg.env
    }))
  }

  private loadConfigFile(): MCPConfigFile {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
      }
    } catch (err) {
      console.error('[MCP] Failed to load config:', err)
    }
    return {}
  }

  private saveConfigFile(config: MCPConfigFile): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (err) {
      console.error('[MCP] Failed to save config:', err)
    }
  }
}
