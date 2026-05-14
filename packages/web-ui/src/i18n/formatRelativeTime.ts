// ============================================================
// formatRelativeTime — 时间相对格式化
//
// 从桌面端提取并简化：
// - 使用 i18n key 支持多语言
// - 输入 timestamp（毫秒），输出相对时间字符串
// ============================================================

import { useI18nStore } from './i18n-store'

/**
 * 格式化相对时间
 *
 * 规则：
 * - < 1 分钟 → "刚刚"
 * - < 60 分钟 → "X 分钟前"
 * - < 24 小时 → "X 小时前"
 * - < 30 天 → "X 天前"
 * - < 12 月 → "X 个月前"
 * - >= 12 月 → "X 年前"
 */
export function formatRelativeTime(timestamp: number): string {
  const t = useI18nStore.getState().t
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)

  if (minutes < 1) return t('common.justNow')
  if (minutes < 60) return t('common.minutesAgo', { count: minutes })

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('common.hoursAgo', { count: hours })

  const days = Math.floor(hours / 24)
  if (days < 30) return t('common.daysAgo', { count: days })

  const months = Math.floor(days / 30)
  if (months < 12) return t('common.monthsAgo', { count: months })

  return t('common.yearsAgo', { count: Math.floor(months / 12) })
}
