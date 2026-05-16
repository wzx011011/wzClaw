// ============================================================
// MCP Manager — 管理 MCP server 生命周期和工具注册
// 从桌面端 mcp-manager.ts 提取，改用 LocalToolExecutor
// ============================================================

import fs from 'fs'
import { MCPClient, type MCPServerConfig } from './mcp-client.js'
import { MCPHandToolWrapper } from './mcp-tool-wrapper.js'
import type { LocalToolExecutor } from '../tool-executor.js'
import { getMcpConfigPath } from '../config/hand-config-loader.js'

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

  /**
   * 从 mcp.json 加载配置并连接所有 MCP servers，注册工具到 executor
   */
  async loadAndConnect(mcpConfigPath: string, executor: LocalToolExecutor): Promise<{ connected: number; errors: string[] }> {
    const configs = this.loadConfig(mcpConfigPath)
    let connected = 0
    const errors: string[] = []

    for (const config of configs) {
      try {
        await this.connectServer(config, executor)
        connected++
      } catch (err) {
        const msg = `MCP server "${config.name}": ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[MCP] ${msg}`)
        errors.push(msg)
      }
    }

    return { connected, errors }
  }

  /**
   * 连接单个 MCP server 并注册工具到 executor
   */
  async connectServer(config: MCPServerConfig, executor: LocalToolExecutor): Promise<number> {
    const existing = this.clients.get(config.name)
    if (existing) {
      existing.disconnect()
    }

    const client = new MCPClient(config)
    await client.connect()
    this.clients.set(config.name, client)

    const tools = await client.listTools()
    for (const mcpTool of tools) {
      const wrapper = new MCPHandToolWrapper(client, mcpTool, config.name)
      executor.register(wrapper)
    }

    console.log(`[MCP] Connected to "${config.name}", registered ${tools.length} tools`)
    return tools.length
  }

  /**
   * 断开指定 server 并从 executor 注销其工具
   */
  disconnectServer(name: string, executor: LocalToolExecutor): void {
    const client = this.clients.get(name)
    if (client) {
      client.disconnect()
      this.clients.delete(name)
    }
    // 从 executor 中移除该 server 的所有工具
    const prefix = `mcp_${name}_`
    const toRemove = executor.getDefinitions()
      .filter(d => d.name.startsWith(prefix))
      .map(d => d.name)
    for (const toolName of toRemove) {
      executor.unregister(toolName)
    }
  }

  /**
   * 断开所有 MCP servers 并清理工具
   */
  disconnectAll(executor: LocalToolExecutor): void {
    for (const name of Array.from(this.clients.keys())) {
      this.disconnectServer(name, executor)
    }
  }

  /**
   * 重新加载所有 MCP servers（断开 → 重连）
   */
  async reload(mcpConfigPath: string, executor: LocalToolExecutor): Promise<{ connected: number; errors: string[] }> {
    this.disconnectAll(executor)
    return this.loadAndConnect(mcpConfigPath, executor)
  }

  /**
   * 获取所有已连接的 MCP server 名称
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, client]) => client.isConnected())
      .map(([name]) => name)
  }

  private loadConfig(configPath: string): MCPServerConfig[] {
    const resolvedPath = configPath || getMcpConfigPath()
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8')
      const fileConfig = JSON.parse(raw) as MCPConfigFile
      if (!fileConfig.mcpServers) return []

      return Object.entries(fileConfig.mcpServers).map(([name, cfg]) => ({
        name,
        transport: cfg.transport ?? 'stdio',
        command: cfg.command,
        args: cfg.args,
        url: cfg.url,
        env: cfg.env,
      }))
    } catch {
      return []
    }
  }
}
