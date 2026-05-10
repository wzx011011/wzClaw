// ============================================================
// Agent IPC Handlers — Agent 相关 IPC 通道注册
// 从 index.ts 拆分，包含：ask-user、plan-mode、session:rewind
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AskUserQuestionTool, AskUserAnswer } from '../tools/ask-user'
import type { PlanModeController } from '../tools/plan-mode'
import type { PermissionManager } from '../permission/permission-manager'
import type { RelayClient } from '../mobile/relay-client'
import type { FileHistoryManager } from '../file-history/file-history-manager'
import type { SessionRuntimeManager } from './session-runtime-manager'
import type { SessionStore } from '../persistence/session-store'

export interface AgentIpcDeps {
  askUserTool: AskUserQuestionTool
  planModeController: PlanModeController
  permissionManager: PermissionManager
  relayClient: RelayClient
  historyManager: FileHistoryManager
  runtimes: SessionRuntimeManager
  getActiveSessionStore: () => SessionStore
  getMainWindow: () => BrowserWindow | null
}

export function registerAgentIpcHandlers(deps: AgentIpcDeps): void {
  const {
    askUserTool,
    planModeController,
    permissionManager,
    relayClient,
    historyManager,
    runtimes,
    getActiveSessionStore,
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
      relayClient.broadcast('stream:agent:plan_mode_entered', {})
    } else {
      mainWindow?.webContents.send(IPC_CHANNELS['agent:plan-mode-exited'], { plan: '' })
      relayClient.broadcast('stream:agent:plan_mode_exited', { plan: '' })
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

  // 会话回退：截断消息 + 回退文件变更
  ipcMain.handle(
    IPC_CHANNELS['session:rewind'],
    async (_event, request: { sessionId: string; targetMessageId: string }) => {
      try {
        // 1. 截断消息（使用 messageId 精确匹配）并获取目标消息的 timestamp
        const store = getActiveSessionStore()
        const result = await store.truncateAfterMessage(request.sessionId, request.targetMessageId)

        if (!result) {
          return {
            success: false,
            removedCount: 0,
            revertedFiles: [],
            error: 'Target message not found in session'
          }
        }

        // 2. 回退文件变更（使用返回的 targetTimestamp）
        const revertedFiles = result.targetTimestamp
          ? await historyManager.revertAfterTimestamp(result.targetTimestamp)
          : []

        // 3. 重置该会话的 AgentLoop 状态
        const runtime = runtimes.get(request.sessionId)
        if (runtime) {
          const messages = await store.loadSession(request.sessionId)
          runtime.reset()
          const validMessages = messages.filter((m: { type: string }) => m.type !== 'meta')
          if (validMessages.length > 0) {
            runtime.replaceMessages(validMessages as any)
          }
        }

        console.log(
          `[Rewind] Session ${request.sessionId}: removed ${result.removedCount} messages, reverted ${revertedFiles.length} files`
        )
        return { success: true, removedCount: result.removedCount, revertedFiles }
      } catch (err: unknown) {
        return {
          success: false,
          removedCount: 0,
          revertedFiles: [],
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
