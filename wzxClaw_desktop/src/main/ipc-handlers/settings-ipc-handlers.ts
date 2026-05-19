// ============================================================
// Settings IPC Handlers — settings:* + session:save-last/get-last
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SettingsManager } from '../settings-manager'

export interface SettingsIpcDeps {
  settingsManager: SettingsManager
  onDataChanged?: (event: string, data: unknown) => void
}

export function registerSettingsIpcHandlers(deps: SettingsIpcDeps): void {
  const { settingsManager, onDataChanged } = deps

  ipcMain.handle(IPC_CHANNELS['settings:get'], () => {
    return settingsManager.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS['settings:update'], (_event, request) => {
    settingsManager.updateSettings(request)
  })

  ipcMain.handle(IPC_CHANNELS['session:save-last'], (_event, request: { sessionId: string }) => {
    const previousId = settingsManager.getLastSessionId()
    settingsManager.setLastSessionId(request.sessionId)
    if (previousId !== request.sessionId) {
      onDataChanged?.('session:changed', { action: 'created', sessionId: request.sessionId })
    }
  })

  ipcMain.handle(IPC_CHANNELS['session:get-last'], () => {
    return { sessionId: settingsManager.getLastSessionId() ?? null }
  })
}
