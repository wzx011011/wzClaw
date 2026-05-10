// ============================================================
// Browser IPC Handlers — 浏览器自动化 IPC 通道注册
// 从 index.ts 拆分，包含：navigate、screenshot、close
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { BrowserManager } from './browser-manager'

export interface BrowserIpcDeps {
  browserManager: BrowserManager
}

export function registerBrowserIpcHandlers(deps: BrowserIpcDeps): void {
  const { browserManager } = deps

  // Browser control handlers (renderer -> main)
  ipcMain.handle(IPC_CHANNELS['browser:navigate'], async (_e: unknown, request: { url: string }) => {
    const title = await browserManager.navigate(request.url)
    return { title }
  })

  ipcMain.handle(IPC_CHANNELS['browser:take_screenshot'], async () => {
    const base64 = await browserManager.screenshot()
    return { base64 }
  })

  ipcMain.handle(IPC_CHANNELS['browser:close'], async () => {
    await browserManager.close()
  })
}
