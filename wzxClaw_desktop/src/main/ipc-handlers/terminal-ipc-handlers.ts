// ============================================================
// Terminal IPC Handlers — terminal:create/kill/input/resize/output + symbol:result
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { handleSymbolResult } from '../tools/symbol-nav'
import type { TerminalManager } from '../terminal/terminal-manager'

export interface TerminalIpcDeps {
  terminalManager: TerminalManager
}

export function registerTerminalIpcHandlers(deps: TerminalIpcDeps): void {
  const { terminalManager } = deps

  ipcMain.handle(IPC_CHANNELS['terminal:create'], async (event, request) => {
    const terminalId = terminalManager.createTerminal(request.cwd)
    terminalManager.onTerminalData(terminalId, (data) => {
      event.sender.send(IPC_CHANNELS['terminal:data'], { terminalId, data })
    })
    return { terminalId }
  })

  ipcMain.handle(IPC_CHANNELS['terminal:kill'], async (_event, request) => {
    terminalManager.killTerminal(request.terminalId)
  })

  ipcMain.handle(IPC_CHANNELS['terminal:input'], async (_event, request) => {
    terminalManager.writeToTerminal(request.terminalId, request.data)
  })

  ipcMain.handle(IPC_CHANNELS['terminal:resize'], async (_event, request) => {
    terminalManager.resizeTerminal(request.terminalId, request.cols, request.rows)
  })

  ipcMain.handle(IPC_CHANNELS['terminal:output'], async (_event, request) => {
    return { buffer: terminalManager.getOutputBuffer(request.terminalId) }
  })

  ipcMain.on('symbol:result', (_event, payload) => {
    handleSymbolResult(payload)
  })
}
