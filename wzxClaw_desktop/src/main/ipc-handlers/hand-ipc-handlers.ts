// ============================================================
// Hand IPC Handlers — hand:get_status/reconnect/disconnect
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { HandBridge } from '../hand-bridge'

export interface HandIpcDeps {
  handBridge: HandBridge
}

export function registerHandIpcHandlers(deps: HandIpcDeps): void {
  const { handBridge } = deps

  ipcMain.handle(IPC_CHANNELS['hand:get_status'], () => {
    return {
      status: String(handBridge.getStatus()),
      handId: handBridge.getHandId(),
    }
  })

  ipcMain.handle(IPC_CHANNELS['hand:reconnect'], () => {
    handBridge.reconnect()
  })

  ipcMain.handle(IPC_CHANNELS['hand:disconnect'], () => {
    handBridge.disconnect()
  })
}
