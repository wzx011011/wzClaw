// ============================================================
// Mobile IPC Handlers — 移动端中继 IPC 通道注册
// 从 index.ts 拆分，包含：relay:connect、disconnect、get_status、qrcode
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SettingsManager } from '../settings-manager'

export interface MobileIpcDeps {
  settingsManager: SettingsManager
}

const disabledRelayStatus = {
  connected: false,
  connecting: false,
  reconnectAttempt: 0,
  mobileConnected: false,
  mobileIdentity: null,
  mobiles: [],
}

export function registerMobileIpcHandlers(deps: MobileIpcDeps): void {
  const { settingsManager } = deps

  // Relay IPC handlers
  ipcMain.handle(IPC_CHANNELS['relay:connect'], async (_e, request: { token: string }) => {
    if (request.token) {
      settingsManager.setRelayToken(request.token)
    }
    const token = request.token || settingsManager.getRelayToken()
    return disabledRelayStatus
  })

  ipcMain.handle(IPC_CHANNELS['relay:disconnect'], async () => {
    return disabledRelayStatus
  })

  ipcMain.handle(IPC_CHANNELS['relay:get_status'], async () => {
    return disabledRelayStatus
  })

  ipcMain.handle(IPC_CHANNELS['relay:qrcode'], async (_e, request?: { token: string }) => {
    const token = request?.token || settingsManager.getRelayToken()
    return { qrCode: '', token: token ?? '' }
  })
}
