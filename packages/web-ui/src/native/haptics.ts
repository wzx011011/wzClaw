// ============================================================
// native/haptics.ts — 触觉反馈封装
//
// 原生端调用 @capacitor/haptics，浏览器端 no-op
// ============================================================

import { isNativePlatform } from './index'

let hapticsModule: any = null
let loaded = false

async function getHaptics(): Promise<any> {
  if (loaded) return hapticsModule
  loaded = true
  if (!isNativePlatform()) return null
  try {
    // @ts-ignore — Capacitor 插件运行时可用
    const mod = await import('@capacitor/haptics')
    hapticsModule = mod.Haptics
  } catch {
    hapticsModule = null
  }
  return hapticsModule
}

/** 触觉冲击反馈 */
export async function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> {
  const haptics = await getHaptics()
  if (!haptics) return
  try {
    // @ts-ignore
    const { ImpactStyle } = await import('@capacitor/haptics')
    const styleMap: Record<string, any> = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy }
    haptics.impact({ style: styleMap[style] })
  } catch { /* no-op */ }
}

/** 触觉通知反馈 */
export async function hapticNotification(type: 'success' | 'warning' | 'error' = 'success'): Promise<void> {
  const haptics = await getHaptics()
  if (!haptics) return
  try {
    // @ts-ignore
    const { NotificationType } = await import('@capacitor/haptics')
    const typeMap: Record<string, any> = { success: NotificationType.Success, warning: NotificationType.Warning, error: NotificationType.Error }
    haptics.notification({ type: typeMap[type] })
  } catch { /* no-op */ }
}
