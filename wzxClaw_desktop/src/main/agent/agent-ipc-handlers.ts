// ============================================================
// Agent IPC Handlers — Agent 相关 IPC 通道注册
// 从 index.ts 拆分，包含：ask-user、plan-mode、file-history
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AskUserQuestionTool, AskUserAnswer } from '../tools/ask-user'
import type { PlanModeController } from '../tools/plan-mode'
import type { PermissionManager } from '@wzxclaw/brain'
import type { FileHistoryManager } from '../file-history/file-history-manager'

export interface AgentIpcDeps {
  askUserTool: AskUserQuestionTool
  planModeController: PlanModeController
  permissionManager: PermissionManager
  historyManager: FileHistoryManager
  getMainWindow: () => BrowserWindow | null
}

export function registerAgentIpcHandlers(deps: AgentIpcDeps): void {
  const {
    askUserTool,
    planModeController,
    permissionManager,
    historyManager,
    getMainWindow,
  } = deps

  // IPC handler: renderer sends back the user's answer
  ipcMain.handle(IPC_CHANNELS['ask-user:answer'], (_event, answer: AskUserAnswer) => {
    askUserTool.resolveQuestion(answer)
  })

  // IPC handler: renderer sends plan approve/reject decision
  ipcMain.handle(IPC_CHANNELS['agent:plan-decision'], (_event, request: { approved: boolean }) => {
    planModeController.resolveDecision(request.approved)
  })

  // IPC handler: user toggles plan mode from UI (/plan command or Shift+Tab)
  ipcMain.handle(IPC_CHANNELS['agent:toggle_plan_mode'], () => {
    const wasActive = permissionManager.isPlanMode()
    const newActive = !wasActive
    permissionManager.setPlanMode(newActive)
    const mainWindow = getMainWindow()
    if (newActive) {
      mainWindow?.webContents.send(IPC_CHANNELS['agent:plan-mode-entered'])
    } else {
      mainWindow?.webContents.send(IPC_CHANNELS['agent:plan-mode-exited'], { plan: '' })
    }
    return { active: newActive }
  })

  // IPC handlers: file history and revert (Phase 3.3)
  ipcMain.handle(IPC_CHANNELS['file:get-history'], (_event, request: { filePath: string }) => {
    return historyManager.getEntriesForFile(request.filePath).map((e) => ({
      toolCallId: e.toolCallId,
      timestamp: e.timestamp,
      filePath: e.filePath
    }))
  })

  ipcMain.handle(IPC_CHANNELS['file:revert'], async (_event, request: { toolCallId: string }) => {
    const entry = historyManager.getByToolCallId(request.toolCallId)
    if (!entry) return { success: false, error: 'No snapshot found for this tool call' }
    try {
      const fsp = await import('fs/promises')
      await fsp.writeFile(entry.filePath, entry.content, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
