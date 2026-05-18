// ============================================================
// API Keys 配置加载器
//
// 从 {configDir}/api-keys.json 读取 API 密钥配置，
// 配置文件优先，环境变量作为无文件配置时的兜底。
// ============================================================

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { platform } from 'node:process'

/** 单个 provider 的密钥配置 */
export interface ApiKeyEntry {
  apiKey: string
  baseURL?: string
}

/** api-keys.json 的完整结构 */
export interface ApiKeysConfig {
  openai?: ApiKeyEntry
  anthropic?: ApiKeyEntry
}

/**
 * 从配置目录读取 api-keys.json
 * 文件不存在或格式错误时返回空对象
 */
export function loadApiKeys(configDir: string): ApiKeysConfig {
  const filePath = join(configDir, 'api-keys.json')
  if (!existsSync(filePath)) return {}
  try {
    // 检查文件权限（仅非 Windows 系统有效）
    if (platform !== 'win32') {
      try {
        const stat = statSync(filePath)
        // mode & 0o077 获取 group/other 权限位
        if (stat.mode & 0o077) {
          console.warn(`WARNING: ${filePath} has overly permissive permissions (mode ${(stat.mode & 0o777).toString(8)}). API keys may be readable by other users. Recommended: chmod 600`)
        }
      } catch {
        // stat 失败不影响加载
      }
    }
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as ApiKeysConfig
  } catch {
    return {}
  }
}

/**
 * 合并文件配置和环境变量
 * 文件配置覆盖环境变量；环境变量用于无配置文件的首次部署。
 */
export function mergeWithEnv(fileKeys: ApiKeysConfig): ApiKeysConfig {
  const result: ApiKeysConfig = {}

  // OpenAI: 文件配置优先，env 兜底
  const openaiKey = fileKeys.openai?.apiKey || process.env.OPENAI_API_KEY
  if (openaiKey) {
    result.openai = {
      apiKey: openaiKey,
      baseURL: fileKeys.openai?.baseURL || process.env.OPENAI_BASE_URL,
    }
  }

  // Anthropic: 文件配置优先，env 兜底
  const anthropicKey =
    fileKeys.anthropic?.apiKey ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    result.anthropic = {
      apiKey: anthropicKey,
      baseURL: fileKeys.anthropic?.baseURL || process.env.ANTHROPIC_BASE_URL,
    }
  }

  return result
}
