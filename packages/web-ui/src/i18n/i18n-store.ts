// ============================================================
// i18n Store — Zustand 管理的语言状态
//
// 从桌面端 i18n-store.ts 简化提取：
// - 不依赖 window.wzxclaw，直接读写 localStorage
// - t(key, params?) 翻译函数，支持 {{param}} 替换
// - 嵌套 key 用 '.' 分隔（'chat.send' -> obj.chat.send）
// ============================================================

import { create } from 'zustand'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/** 支持的语言 */
export type Locale = 'zh-CN' | 'en'

/** 翻译字典类型 */
type LocaleDict = Record<string, string>

/** 语言字典映射 */
const LOCALES: Record<Locale, LocaleDict> = { 'zh-CN': zhCN, en: enUS }

/** localStorage 键名 */
const STORAGE_KEY = 'wzxclaw-locale'

/** i18n Store 状态接口 */
interface I18nState {
  /** 当前语言 */
  locale: Locale
  /** 翻译函数 */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 切换语言 */
  setLocale: (locale: Locale) => void
  /** 初始化语言（从 localStorage 恢复） */
  initLocale: (savedLocale?: string) => void
}

/**
 * i18n Store
 *
 * t() 使用当前 locale 查找翻译字典。
 * 如果 key 在当前语言中不存在，回退到中文。
 * 如果中文也没有，返回 key 本身。
 */
export const useI18nStore = create<I18nState>((set, get) => ({
  locale: 'zh-CN',

  t: (key, params?) => {
    const dict = LOCALES[get().locale]
    let text = dict[key] ?? LOCALES['zh-CN'][key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
      }
    }
    return text
  },

  setLocale: (locale) => {
    set({ locale })
    try {
      localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // localStorage 不可用时静默忽略
    }
  },

  initLocale: (savedLocale?) => {
    let target: Locale | undefined

    // 1. 优先使用传入的保存值
    if (savedLocale === 'en' || savedLocale === 'zh-CN') {
      target = savedLocale
    }

    // 2. 从 localStorage 读取
    if (!target) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored === 'en' || stored === 'zh-CN') {
          target = stored
        }
      } catch {
        // localStorage 不可用
      }
    }

    // 3. 从浏览器语言推断
    if (!target && typeof navigator !== 'undefined') {
      const browserLang = navigator.language
      if (browserLang.startsWith('zh')) {
        target = 'zh-CN'
      } else {
        target = 'en'
      }
    }

    if (target) {
      set({ locale: target })
    }
  },
}))
