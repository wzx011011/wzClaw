// ============================================================
// Permission IPC Handlers — permission:get_mode/set_mode
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { PermissionManager } from '@wzxclaw/brain'

export interface PermissionIpcDeps {
  permissionManager: PermissionManager
}

export function registerPermissionIpcHandlers(deps: PermissionIpcDeps): void {
  const { permissionManager } = deps

  ipcMain.handle(IPC_CHANNELS['permission:get_mode'], () => {
    return { mode: permissionManager.getMode() }
  })

  ipcMain.handle(IPC_CHANNELS['permission:set_mode'], (_event, request) => {
    permissionManager.setMode(request.mode)
  })
}
