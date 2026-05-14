// ============================================================
// useT — React hook，返回 t() 翻译函数
//
// 订阅 locale 变化，确保语言切换时触发重渲染
// ============================================================

import { useI18nStore } from './i18n-store'

/** 返回翻译函数 t()，订阅 locale 变化 */
export function useT() {
  // 订阅 locale 以确保语言切换时触发重渲染
  useI18nStore((s) => s.locale)
  return useI18nStore((s) => s.t)
}

/** 返回当前 locale */
export function useLocale() {
  return useI18nStore((s) => s.locale)
}

/** 返回 setLocale 函数 */
export function useSetLocale() {
  return useI18nStore((s) => s.setLocale)
}
