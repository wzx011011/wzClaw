import { useI18nStore } from './i18n-store'

/**
 * 相对时间格式化 — 用于 SessionList 和 WorkspaceCard。
 * 使用 i18n store 的 t() 函数获取本地化字符串。
 */
export function formatRelativeTime(timestamp: number): string {
  const t = useI18nStore.getState().t
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return t('relativeTime.justNow')
  if (minutes < 60) return t('relativeTime.minutesAgo', { count: minutes })
  if (hours < 24) return t('relativeTime.hoursAgo', { count: hours })
  if (days < 2) return t('relativeTime.yesterday')
  if (days < 30) return t('relativeTime.daysAgo', { count: days })

  // 超过 30 天显示日期
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
