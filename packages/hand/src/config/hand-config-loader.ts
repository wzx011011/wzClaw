// ============================================================
// Hand 配置加载器 — 读取 hand.config.json 并提供工具过滤
// Docker Hand 和 CLI Hand 共用
// ============================================================

import fs from 'fs'
import path from 'path'
import os from 'os'

// ---- 接口定义 ----

/** 单个内置工具的配置 */
export interface BuiltinToolConfig {
  /** 是否启用（默认 true） */
  enabled: boolean
  /** 允许的路径（FileRead/FileWrite 限定，可选） */
  allowedPaths?: string[]
  /** 超时秒数（ShellExecute，可选） */
  timeout?: number
  /** 禁止的命令前缀（ShellExecute，可选） */
  denyPrefixes?: string[]
}

/** hand.config.json 完整结构 */
export interface HandConfigFile {
  /** 内置工具配置映射 */
  builtinTools: Record<string, BuiltinToolConfig>
}

// ---- 默认配置 ----

/** ShellExecute 默认禁止的命令前缀 */
const DEFAULT_DENY_PREFIXES = [
  'rm -rf /',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',  // fork bomb
  'format',
  'del /s',
]

/** 默认 Hand 配置（所有工具 enabled，ShellExecute 额外保守） */
export const DEFAULT_HAND_CONFIG: HandConfigFile = {
  builtinTools: {
    FileRead: { enabled: true },
    FileWrite: { enabled: true, allowedPaths: ['/data'] },
    FileList: { enabled: true },
    ShellExecute: {
      enabled: false,  // 高危工具默认关闭
      timeout: 30,
      denyPrefixes: DEFAULT_DENY_PREFIXES,
    },
    Echo: { enabled: true },
  },
}

// ---- 配置目录 ----

/**
 * 获取配置目录路径
 * 优先使用 WZXCLAW_CONFIG_DIR 环境变量，否则使用 ~/.wzxclaw
 */
export function getConfigDir(): string {
  return process.env.WZXCLAW_CONFIG_DIR || path.join(os.homedir(), '.wzxclaw')
}

/**
 * 获取 hand.config.json 的完整路径
 */
export function getHandConfigPath(configDir?: string): string {
  return path.join(configDir ?? getConfigDir(), 'hand.config.json')
}

/**
 * 获取 mcp.json 的完整路径
 */
export function getMcpConfigPath(configDir?: string): string {
  return path.join(configDir ?? getConfigDir(), 'mcp.json')
}

// ---- 配置加载 ----

/**
 * 加载 hand.config.json 并合并默认值
 * 文件不存在或解析失败时返回默认配置
 */
export function loadHandConfig(configPath?: string): HandConfigFile {
  const filePath = configPath ?? getHandConfigPath()

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<HandConfigFile>

    if (!parsed.builtinTools || typeof parsed.builtinTools !== 'object') {
      return { ...DEFAULT_HAND_CONFIG }
    }

    // 合并：用户配置覆盖默认值，缺失字段使用默认值
    const merged: HandConfigFile = {
      builtinTools: { ...DEFAULT_HAND_CONFIG.builtinTools },
    }

    for (const [name, userConfig] of Object.entries(parsed.builtinTools)) {
      if (!userConfig || typeof userConfig !== 'object') continue
      const defaults = DEFAULT_HAND_CONFIG.builtinTools[name]
      merged.builtinTools[name] = {
        enabled: userConfig.enabled ?? defaults?.enabled ?? true,
        ...(defaults?.allowedPaths && { allowedPaths: defaults.allowedPaths }),
        ...(defaults?.timeout !== undefined && { timeout: defaults.timeout }),
        ...(defaults?.denyPrefixes && { denyPrefixes: defaults.denyPrefixes }),
        ...(userConfig.allowedPaths !== undefined && { allowedPaths: userConfig.allowedPaths }),
        ...(userConfig.timeout !== undefined && { timeout: userConfig.timeout }),
        ...(userConfig.denyPrefixes !== undefined && { denyPrefixes: userConfig.denyPrefixes }),
      }
    }

    return merged
  } catch {
    // 文件不存在或 JSON 解析失败，使用默认配置
    return { ...DEFAULT_HAND_CONFIG }
  }
}

/**
 * 返回所有 enabled 的工具名列表
 */
export function getEnabledTools(config: HandConfigFile): string[] {
  return Object.entries(config.builtinTools)
    .filter(([, cfg]) => cfg.enabled)
    .map(([name]) => name)
}

/**
 * 检查指定工具是否启用
 */
export function isToolEnabled(config: HandConfigFile, toolName: string): boolean {
  return config.builtinTools[toolName]?.enabled ?? false
}

/**
 * 获取工具的完整配置（含默认值）
 */
export function getToolConfig(config: HandConfigFile, toolName: string): BuiltinToolConfig | undefined {
  return config.builtinTools[toolName]
}
