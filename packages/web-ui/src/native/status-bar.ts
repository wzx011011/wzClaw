// ============================================================
// native/status-bar.ts — 状态栏主题封装
//
// 原生端调用 @capacitor/status-bar，浏览器端 no-op
// ============================================================

import { isNativePlatform } from './index'

let statusBarModule: any = null
let loaded = false

async function getStatusBar(): Promise<any> {
  if (loaded) return statusBarModule
  loaded = true
  if (!isNativePlatform()) return null
  try {
    // @ts-ignore — Capacitor 插件运行时可用
    const mod = await import('@capacitor/status-bar')
    statusBarModule = mod.StatusBar
  } catch {
    statusBarModule = null
  }
  return statusBarModule
}

/** 设置状态栏样式 */
export async function setStatusBarStyle(theme: 'light' | 'dark'): Promise<void> {
  const statusBar = await getStatusBar()
  if (!statusBar) return
  try {
    // @ts-ignore
    const { Style } = await import('@capacitor/status-bar')
    statusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light })
  } catch { /* no-op */ }
}

/** 设置状态栏可见性 */
export async function setStatusBarVisible(show: boolean): Promise<void> {
  const statusBar = await getStatusBar()
  if (!statusBar) return
  try {
    if (show) {
      statusBar.show()
    } else {
      statusBar.hide()
    }
  } catch { /* no-op */ }
}
