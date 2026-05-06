import { create } from 'zustand'
import zhCN from './zh-CN.json'
import en from './en.json'

export type Locale = 'zh-CN' | 'en'

type LocaleDict = Record<string, string>

const LOCALES: Record<Locale, LocaleDict> = { 'zh-CN': zhCN, en }

interface I18nState {
  locale: Locale
  t: (key: string, params?: Record<string, string | number>) => string
  setLocale: (locale: Locale) => void
  initLocale: (savedLocale?: string) => void
}

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
    window.wzxclaw.updateSettings({ language: locale })
  },

  initLocale: (savedLocale?) => {
    if (savedLocale === 'en' || savedLocale === 'zh-CN') {
      set({ locale: savedLocale })
    }
  }
}))
