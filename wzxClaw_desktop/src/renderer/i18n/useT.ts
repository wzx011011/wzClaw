import { useI18nStore } from './i18n-store'

export function useT() {
  // 必须订阅 locale 以确保语言切换时触发重渲染
  // t 函数是稳定的引用，仅订阅 s.t 无法检测 locale 变化
  const locale = useI18nStore((s) => s.locale)
  const t = useI18nStore((s) => s.t)
  return t
}

export function useLocale() {
  return useI18nStore((s) => s.locale)
}

export function useSetLocale() {
  return useI18nStore((s) => s.setLocale)
}
