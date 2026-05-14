// ============================================================
// Settings Store — web-ui 版本的设置管理
//
// 不依赖 IPC，直接读写 localStorage。
// 状态：agentUrl, token, language, themeMode
// 与 useConnectionConfig hook 协同工作
// ============================================================

import { create } from 'zustand'

/** 设置状态 */
interface SettingsState {
  /** Agent Server WebSocket URL */
  agentUrl: string
  /** 认证 Token */
  token: string
  /** 语言 */
  language: string
  /** 主题模式 */
  themeMode: 'dark' | 'light'
}

/** 设置操作 */
interface SettingsActions {
  /** 从 localStorage 加载设置 */
  loadSettings: () => void
  /** 更新设置（同步到 localStorage） */
  updateSettings: (updates: Partial<SettingsState>) => void
}

/** localStorage 键名 */
const STORAGE_KEY = 'wzxclaw-settings'

/** 默认设置 */
const DEFAULT_SETTINGS: SettingsState = {
  agentUrl: '',
  token: '',
  language: 'zh-CN',
  themeMode: 'dark',
}

/**
 * 从 localStorage 读取设置
 */
function loadFromStorage(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }

    const parsed = JSON.parse(raw) as Partial<SettingsState>
    return {
      agentUrl: typeof parsed.agentUrl === 'string' ? parsed.agentUrl : DEFAULT_SETTINGS.agentUrl,
      token: typeof parsed.token === 'string' ? parsed.token : DEFAULT_SETTINGS.token,
      language: typeof parsed.language === 'string' ? parsed.language : DEFAULT_SETTINGS.language,
      themeMode: parsed.themeMode === 'light' || parsed.themeMode === 'dark'
        ? parsed.themeMode
        : DEFAULT_SETTINGS.themeMode,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 保存设置到 localStorage
 */
function saveToStorage(settings: SettingsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

/**
 * Settings Store
 */
export const useSettingsStore = create<SettingsState & SettingsActions>((set, get) => ({
  // ---- 初始状态 ----
  ...DEFAULT_SETTINGS,

  // ---- 操作 ----

  loadSettings: () => {
    const settings = loadFromStorage()
    set(settings)
  },

  updateSettings: (updates) => {
    const current = get()
    const next = { ...current, ...updates }
    saveToStorage(next)
    set(next)
  },
}))
