// ============================================================
// Mobile Workspace Handlers — 移动端工作区相关消息处理器
// 处理 workspace:switch/list/create/update/delete/get/add-project/remove-project 事件
// ============================================================

import path from 'path'
import fs from 'fs'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SessionMeta } from '../persistence/session-store'
import type { MobileRelayContext, MobileRelayMessage } from './mobile-relay-context'

/**
 * 处理工作区相关的移动端消息。
 * 返回 true 表示已处理，false 表示不匹配。
 */
export async function handleWorkspaceMessage(
  msg: MobileRelayMessage,
  ctx: MobileRelayContext
): Promise<boolean> {
  const { broadcastToMobile } = ctx

  // -- Workspace: switch to a different workspace --
  if (msg.event === 'workspace:switch:request') {
    const requestId = msg.data?.requestId ?? ''
    const workspacePath = msg.data?.workspacePath
    if (!workspacePath) {
      broadcastToMobile('session:error', { requestId, error: 'Missing workspacePath', code: 'BAD_REQUEST' })
      return true
    }
    try {
      if (!fs.existsSync(workspacePath as string)) {
        broadcastToMobile('workspace:switch:response', { requestId, success: false, error: 'Path does not exist' })
        return true
      }
      // Trigger workspace open — reuses the existing onWorkspaceOpened flow
      ctx.workspaceManager.setWorkspaceRoot(workspacePath as string)
      ctx.handleWorkspaceOpened(workspacePath as string, ctx.toolRegistry)
      // 切换工作区：取消所有运行中的会话（workspace 跨会话资源已变）
      ctx.runtimes.clear()
      ctx.sessionStore.value = ctx.storeManager.getForRoot(workspacePath as string)
      ctx.stepManager.setWorkspaceRoot(workspacePath as string)
      ctx.stepManager.clearAllSteps()
      ctx.mobileSessionId.value = null
      ctx.mobilePersistedMessageCounts.clear()
      ctx.settingsManager.setLastWorkspacePath(workspacePath as string)
      ctx.sendWorkspaceInfoToMobile()
      broadcastToMobile('workspace:switch:response', {
        requestId,
        success: true,
        workspaceName: path.basename(workspacePath as string),
      })
    } catch (err: unknown) {
      broadcastToMobile('workspace:switch:response', { requestId, success: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: list workspaces (with sessions) --
  if (msg.event === 'workspace:list:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const tasks = await ctx.workspaceStore.listWorkspaces(msg.data?.includeArchived as boolean | undefined)
      // 为每个 workspace 附加最近 10 个会话
      const enriched = await Promise.all(tasks.map(async (t) => {
        const root = t.projects?.[0]?.path as string | undefined
        let sessions: SessionMeta[] = []
        if (root) {
          try {
            const ss = ctx.storeManager.getForRoot(root)
            const all = await ss.listSessions()
            sessions = all
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 10)
          } catch { /* workspace 可能还没有 sessions 目录 */ }
        }
        const workspaceSessionIds = new Set(sessions.map(session => session.id))
        const runningSessionIds = ctx.runtimes.listRunning().filter(sessionId => workspaceSessionIds.has(sessionId))
        const taskStatuses = Object.fromEntries(
          Object.entries(ctx.sessionTaskStates.snapshot()).filter(([sessionId]) => workspaceSessionIds.has(sessionId))
        )
        return { ...t, sessions, runningSessionIds, taskStatuses }
      }))
      broadcastToMobile('workspace:list:response', { requestId, tasks: enriched })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: create workspace --
  if (msg.event === 'workspace:create:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const workspace = await ctx.workspaceStore.createWorkspace((msg.data?.title as string) ?? 'New Workspace', msg.data?.description as string | undefined)
      broadcastToMobile('workspace:create:response', { requestId, workspace })
      // Notify desktop renderer
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'created', data: workspace })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: update workspace --
  if (msg.event === 'workspace:update:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const workspace = await ctx.workspaceStore.updateWorkspace(msg.data?.workspaceId as string, msg.data?.updates ?? {})
      broadcastToMobile('workspace:update:response', { requestId, workspace })
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: delete workspace --
  if (msg.event === 'workspace:delete:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      await ctx.workspaceStore.deleteWorkspace(msg.data?.workspaceId as string)
      broadcastToMobile('workspace:delete:response', { requestId, success: true })
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'deleted', data: { workspaceId: msg.data?.workspaceId } })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: get single workspace --
  if (msg.event === 'workspace:get:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const workspace = await ctx.workspaceStore.getWorkspace(msg.data?.workspaceId as string)
      broadcastToMobile('workspace:get:response', { requestId, workspace })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: add project to workspace --
  if (msg.event === 'workspace:add-project:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const workspace = await ctx.workspaceStore.addProject(msg.data?.workspaceId as string, msg.data?.folderPath as string)
      broadcastToMobile('workspace:add-project:response', { requestId, workspace })
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // -- Workspace management: remove project from workspace --
  if (msg.event === 'workspace:remove-project:request') {
    const requestId = msg.data?.requestId ?? ''
    try {
      const workspace = await ctx.workspaceStore.removeProject(msg.data?.workspaceId as string, msg.data?.projectId as string)
      broadcastToMobile('workspace:remove-project:response', { requestId, workspace })
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) wc.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'workspace', action: 'updated', data: workspace })
    } catch (err: unknown) {
      broadcastToMobile('workspace:error', { requestId, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  return false
}
