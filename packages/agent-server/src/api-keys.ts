// ============================================================
// API Keys 配置加载器
//
// 从 {configDir}/api-keys.json 读取 API 密钥配置，
// 环境变量优先级高于文件（向后兼容）。
// ============================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

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
 * 环境变量覆盖文件中的值
 */
export function mergeWithEnv(fileKeys: ApiKeysConfig): ApiKeysConfig {
  const result: ApiKeysConfig = {}

  // OpenAI: env 覆盖文件
  const openaiKey = process.env.OPENAI_API_KEY || fileKeys.openai?.apiKey
  if (openaiKey) {
    result.openai = {
      apiKey: openaiKey,
      baseURL: process.env.OPENAI_BASE_URL || fileKeys.openai?.baseURL,
    }
  }

  // Anthropic: env 覆盖文件
  const anthropicKey =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    fileKeys.anthropic?.apiKey
  if (anthropicKey) {
    result.anthropic = {
      apiKey: anthropicKey,
      baseURL: process.env.ANTHROPIC_BASE_URL || fileKeys.anthropic?.baseURL,
    }
  }

  return result
}
