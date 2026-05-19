// ============================================================
// ToolLoader — 组装器：内置工具过滤 + MCP 注册
// Docker Hand 和 CLI Hand 的统一工具加载入口
// ============================================================

import { LocalToolExecutor } from './tool-executor.js'
import { loadHandConfig, getEnabledTools, getHandConfigPath, getMcpConfigPath, type HandConfigFile } from './config/hand-config-loader.js'
import { MCPManager } from './mcp/mcp-manager.js'
import { createNasTools } from '../tools/index.js'
import type { TerminalManager } from './terminal-manager.js'

// ---- 接口 ----

/** ToolLoader 配置 */
export interface ToolLoaderConfig {
  /** 配置目录路径（默认 ~/.wzxclaw） */
  configDir?: string
  /** 工具执行器 */
  executor: LocalToolExecutor
  /** 可选 TerminalManager，提供时会注册 4 个 Terminal* 工具 */
  terminalManager?: TerminalManager
}

/** 工具加载结果 */
export interface LoadResult {
  /** 注册的内置工具数量 */
  builtinCount: number
  /** 注册的 MCP 工具数量 */
  mcpCount: number
  /** MCP 连接错误 */
  mcpErrors: string[]
  /** 加载的配置 */
  config: HandConfigFile
}

/**
 * ToolLoader — 统一的工具加载管理器
 *
 * 职责:
 * 1. 读取 hand.config.json，过滤启用的内置工具
 * 2. 注册启用的 NAS 工具到 executor
 * 3. 读取 mcp.json，连接 MCP servers，注册 MCP 工具
 * 4. 提供 reload 功能
 */
export class ToolLoader {
  private mcpManager: MCPManager
  private configDir: string
  private lastConfig: HandConfigFile | null = null

  constructor(private config: ToolLoaderConfig) {
    this.configDir = config.configDir || process.env.WZXCLAW_CONFIG_DIR || ''
    this.mcpManager = new MCPManager()
  }

  /**
   * 加载所有工具（内置 + MCP）
   */
  async loadTools(): Promise<LoadResult> {
    const handConfigPath = this.configDir
      ? `${this.configDir}/hand.config.json`
      : getHandConfigPath()

    // 1. 加载配置
    const handConfig = loadHandConfig(handConfigPath)
    this.lastConfig = handConfig

    // 2. 注册启用的内置 NAS 工具（含可选 Terminal* 工具）
    const enabledTools = getEnabledTools(handConfig)
    const allNasTools = createNasTools(this.config.terminalManager)
    let builtinCount = 0

    for (const tool of allNasTools) {
      if (enabledTools.includes(tool.name)) {
        this.config.executor.register(tool)
        builtinCount++
      }
    }

    // 3. 注册内置 Echo 工具
    if (enabledTools.includes('Echo')) {
      this.config.executor.addBuiltinTools()
      builtinCount++
    }

    // 4. 加载 MCP servers
    const mcpConfigPath = this.configDir
      ? `${this.configDir}/mcp.json`
      : getMcpConfigPath()

    const mcpResult = await this.mcpManager.loadAndConnect(mcpConfigPath, this.config.executor)

    console.log(`[tool-loader] 加载完成: ${builtinCount} 内置工具, ${mcpResult.connected} MCP servers`)

    return {
      builtinCount,
      mcpCount: mcpResult.connected,
      mcpErrors: mcpResult.errors,
      config: handConfig,
    }
  }

  /**
   * 重新加载所有工具（先清理再加载）
   */
  async reloadTools(): Promise<LoadResult> {
    // 清理 MCP 工具
    this.mcpManager.disconnectAll(this.config.executor)

    // 清理内置工具（重新注册即可覆盖，无需手动清理）
    return this.loadTools()
  }

  /**
   * 获取 MCP Manager（供外部使用，如 reload 控制帧处理）
   */
  getMcpManager(): MCPManager {
    return this.mcpManager
  }

  /**
   * 获取最后一次加载的配置
   */
  getLastConfig(): HandConfigFile | null {
    return this.lastConfig
  }
}
