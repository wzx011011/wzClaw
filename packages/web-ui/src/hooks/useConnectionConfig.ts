// ============================================================
// useConnectionConfig — 管理 agent-server 连接配置的自定义 hook
//
// 功能：
// - 从 localStorage 读取/保存配置
// - 默认值：agentUrl = 'ws://localhost:8082'
// - 配置项：agentUrl, token, language, themeMode
// - 当 agentUrl 或 token 变化时可选触发 DataSource 重连
// ============================================================

import { useState, useCallback, useEffect } from 'react'

/** 连接配置类型 */
export interface ConnectionConfig {
  /** Agent Server WebSocket URL */
  agentUrl: string
  /** 认证 token */
  token: string
  /** 语言 */
  language: string
  /** 主题模式 */
  themeMode: 'dark' | 'light'
}

/** localStorage 键名 */
const STORAGE_KEY = 'wzxclaw-connection-config'

/** 默认配置 */
const DEFAULT_CONFIG: ConnectionConfig = {
  agentUrl: 'ws://localhost:8082',
  token: '',
  language: 'zh-CN',
  themeMode: 'dark',
}

/** URL 协议验证 — 只允许 ws:// 和 wss:// */
function isValidAgentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * 从 localStorage 读取配置
 * 如果存储值无效或缺失，使用默认值
 */
function loadConfigFromStorage(): ConnectionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }

    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>
    return {
      agentUrl: typeof parsed.agentUrl === 'string' && isValidAgentUrl(parsed.agentUrl)
        ? parsed.agentUrl
        : DEFAULT_CONFIG.agentUrl,
      token: typeof parsed.token === 'string' ? parsed.token : DEFAULT_CONFIG.token,
      language: typeof parsed.language === 'string' ? parsed.language : DEFAULT_CONFIG.language,
      themeMode: parsed.themeMode === 'light' || parsed.themeMode === 'dark'
        ? parsed.themeMode
        : DEFAULT_CONFIG.themeMode,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 将配置保存到 localStorage
 */
function saveConfigToStorage(config: ConnectionConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch (err) {
    console.error('保存配置失败:', err)
  }
}

/**
 * useConnectionConfig — 连接配置管理 hook
 *
 * 用法：
 * ```tsx
 * const { config, saveConfig, isValid } = useConnectionConfig()
 * ```
 */
export function useConnectionConfig(): {
  /** 当前配置 */
  config: ConnectionConfig
  /** 保存新配置（写入 localStorage + 触发状态更新） */
  saveConfig: (newConfig: Partial<ConnectionConfig>) => void
  /** 验证 agentUrl 是否有效 */
  isValidUrl: boolean
  /** 验证错误信息 */
  urlError: string | null
} {
  const [config, setConfig] = useState<ConnectionConfig>(loadConfigFromStorage)

  // 保存配置
  const saveConfig = useCallback((updates: Partial<ConnectionConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...updates }

      // 验证 agentUrl
      if (updates.agentUrl !== undefined && !isValidAgentUrl(updates.agentUrl)) {
        console.warn('无效的 agent URL（必须以 ws:// 或 wss:// 开头）:', updates.agentUrl)
        // 不覆盖为无效值，保持原值
        next.agentUrl = prev.agentUrl
      }

      saveConfigToStorage(next)
      return next
    })
  }, [])

  // URL 验证
  const isValidUrl = isValidAgentUrl(config.agentUrl)
  const urlError = isValidUrl ? null : 'URL 必须以 ws:// 或 wss:// 开头'

  // 应用主题（暗色/亮色）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.themeMode)
  }, [config.themeMode])

  return {
    config,
    saveConfig,
    isValidUrl,
    urlError,
  }
}
