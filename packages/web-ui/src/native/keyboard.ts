// ============================================================
// native/keyboard.ts — 键盘适配封装
//
// 原生端调用 @capacitor/keyboard，浏览器端 no-op
// ============================================================

import { isNativePlatform } from './index'

let keyboardModule: any = null
let loaded = false

async function getKeyboard(): Promise<any> {
  if (loaded) return keyboardModule
  loaded = true
  if (!isNativePlatform()) return null
  try {
    // @ts-ignore — Capacitor 插件运行时可用
    const mod = await import('@capacitor/keyboard')
    keyboardModule = mod.Keyboard
  } catch {
    keyboardModule = null
  }
  return keyboardModule
}

/** 设置键盘调整模式 */
export async function setKeyboardResize(mode: 'none' | 'native' | 'body'): Promise<void> {
  const keyboard = await getKeyboard()
  if (!keyboard) return
  try {
    // @ts-ignore
    const { KeyboardResize } = await import('@capacitor/keyboard')
    const modeMap: Record<string, any> = { none: KeyboardResize.None, native: KeyboardResize.Native, body: KeyboardResize.Body }
    keyboard.setResizeMode({ mode: modeMap[mode] })
  } catch { /* no-op */ }
}

/** 设置键盘附属栏可见性 */
export async function setKeyboardAccessoryBarVisible(show: boolean): Promise<void> {
  const keyboard = await getKeyboard()
  if (!keyboard) return
  try {
    keyboard.setAccessoryBarVisible({ visible: show })
  } catch { /* no-op */ }
}

/** 监听键盘弹出 */
export function onKeyboardShow(callback: (info: { keyboardHeight: number }) => void): () => void {
  if (!isNativePlatform()) return () => {}
  let cleanup: (() => void) | null = null
  ;(async () => {
    const keyboard = await getKeyboard()
    if (!keyboard) return
    try {
      const handler = keyboard.addListener('keyboardWillShow', (info: any) => {
        callback({ keyboardHeight: info.keyboardHeight })
      })
      cleanup = () => { handler.then((h: any) => h.remove()) }
    } catch { /* no-op */ }
  })()
  return () => cleanup?.()
}

/** 监听键盘收起 */
export function onKeyboardHide(callback: () => void): () => void {
  if (!isNativePlatform()) return () => {}
  let cleanup: (() => void) | null = null
  ;(async () => {
    const keyboard = await getKeyboard()
    if (!keyboard) return
    try {
      const handler = keyboard.addListener('keyboardWillHide', () => {
        callback()
      })
      cleanup = () => { handler.then((h: any) => h.remove()) }
    } catch { /* no-op */ }
  })()
  return () => cleanup?.()
}
