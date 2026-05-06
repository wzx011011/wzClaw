import { useI18nStore } from './i18n-store'

export function useT() {
  return useI18nStore((s) => s.t)
}

export function useLocale() {
  return useI18nStore((s) => s.locale)
}

export function useSetLocale() {
  return useI18nStore((s) => s.setLocale)
}
