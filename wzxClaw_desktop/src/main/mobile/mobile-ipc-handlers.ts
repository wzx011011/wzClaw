// ============================================================
// Mobile IPC Handlers — 移动端中继 IPC 通道注册
// 从 index.ts 拆分，包含：relay:connect、disconnect、get_status、qrcode
// ============================================================

import { ipcMain } from 'electron'
import crypto from 'crypto'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { RelayClient } from './relay-client'
import type { SettingsManager } from '../settings-manager'

export interface MobileIpcDeps {
  relayClient: RelayClient
  settingsManager: SettingsManager
}

export function registerMobileIpcHandlers(deps: MobileIpcDeps): void {
  const { relayClient, settingsManager } = deps

  // Relay IPC handlers
  ipcMain.handle(IPC_CHANNELS['relay:connect'], async (_e, request: { token: string }) => {
    if (request.token) {
      settingsManager.setRelayToken(request.token)
    }
    const token = request.token || settingsManager.getRelayToken()
    if (token) {
      relayClient.connect(token)
    }
    return relayClient.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS['relay:disconnect'], async () => {
    relayClient.disconnect()
  })

  ipcMain.handle(IPC_CHANNELS['relay:get_status'], async () => {
    return relayClient.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS['relay:qrcode'], async (_e, request?: { token: string }) => {
    let token = request?.token || settingsManager.getRelayToken()
    // Auto-generate a random token if none configured — user just needs to scan
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      settingsManager.setRelayToken(token)
    }
    // Ensure desktop is connected to relay with this token
    if (!relayClient.connected) {
      relayClient.connect(token)
    }
    const { generateQRCode } = await import('./qr-generator')
    const relayUrl = `https://relay.5945.top/?token=${encodeURIComponent(token)}`
    const qrCode = await generateQRCode(relayUrl)
    return { qrCode, token }
  })
}
