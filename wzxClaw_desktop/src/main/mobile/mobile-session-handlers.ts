// ============================================================
// Mobile Session Handlers — 移动端会话相关消息处理器
// 处理 session:list/load/create/delete/rename/clear 事件
// ============================================================

import path from 'path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { MobileRelayContext, MobileRelayMessage } from './mobile-relay-context'

/**
 * 处理会话相关的移动端消息。
 * 返回 true 表示已处理，false 表示不匹配。
 */
export async function handleSessionMessage(
  msg: MobileRelayMessage,
  ctx: MobileRelayContext
): Promise<boolean> {
  const { broadcastToMobile } = ctx

  // -- Session sync: list sessions --
  if (msg.event === 'session:list:request') {
    const requestId = msg.data?.requestId ?? ''
    const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
    const store = await ctx.getStoreForMobile(activeWorkspaceId as string | null)
    const workspaceRoot = ctx.workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot || !store) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
      return true
    }
    try {
      const sessions = await store.listSessions()
      // Enrich sessions with todo summary
      const runningIds = ctx.runtimes.listRunning()
      const taskStatuses = ctx.sessionTaskStates.snapshot()
      const { TodoWriteTool } = await import('../tools/todo-write')
      for (const session of sessions) {
        session.isRunning = runningIds.includes(session.id)
        session.taskStatus = ctx.sessionTaskStates.get(session.id) ?? undefined
        try {
          const todos = await TodoWriteTool.loadForSession(session.id)
          if (todos.length > 0) {
            const completed = todos.filter(t => t.status === 'completed').length
            const inProgress = todos.find(t => t.status === 'in_progress')
            let summary = `${completed}/${todos.length} 完成`
            if (inProgress) {
              summary += ` · 当前: ${inProgress.activeForm || inProgress.content}`
            }
            session.todoSummary = summary
          }
        } catch { /* ignore */ }
      }
      broadcastToMobile('session:list:response', {
        requestId,
        workspaceName: path.basename(workspaceRoot),
        workspacePath: workspaceRoot,
        sessions,
        runningSessionIds: runningIds,
        taskStatuses,
        activeSessionId: ctx.settingsManager.getLastSessionId() ?? null
      })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  // -- Session sync: load session messages (with pagination) --
  if (msg.event === 'session:load:request') {
    const data = (msg.data ?? {}) as Record<string, unknown>
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    const offset = typeof data.offset === 'number' && Number.isFinite(data.offset) ? data.offset : 0
    const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : 50
    const activeWorkspaceId = typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : null
    const store = await ctx.getStoreForMobile(activeWorkspaceId)
    if (!store) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
      return true
    }
    try {
      const rawMessages = await store.loadSession(sessionId)
      const showToolSteps = ctx.settingsManager.getShowToolSteps()
      const allMessages = showToolSteps
        ? rawMessages
        : rawMessages
            .filter(message => message.role !== 'tool_result')
            .map(message => {
              if (message.role !== 'assistant' || !message.toolCalls) return message
              const { toolCalls: _toolCalls, ...rest } = message
              return rest
            })
      const total = allMessages.length
      const sliced = allMessages.slice(offset, offset + limit)
      broadcastToMobile('session:load:response', {
        requestId,
        sessionId,
        messages: sliced,
        total,
        offset,
        hasMore: (offset + limit) < total
      })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'SESSION_NOT_FOUND' })
    }
    return true
  }

  // -- Session sync: create session --
  if (msg.event === 'session:create:request') {
    const requestId = msg.data?.requestId ?? ''
    const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
    const store = await ctx.getStoreForMobile(activeWorkspaceId as string | null)
    if (!store) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
      return true
    }
    try {
      const title = msg.data?.title || 'New Session'
      const sessionId = crypto.randomUUID()
      // Create the session file with a meta line
      const metaLine = JSON.stringify({ type: 'meta', title }) + '\n'
      // fsp imported at top
      const sessionPath = path.join(
        store.sessionDir,
        `${sessionId}.jsonl`
      )
      const fsp = await import('fs/promises')
      await fsp.writeFile(sessionPath, metaLine, 'utf-8')
      broadcastToMobile('session:create:response', {
        requestId,
        session: { id: sessionId, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
      })
      // 通知桌面渲染器：手机端创建了新会话
      const wcCreate = BrowserWindow.getAllWindows()[0]?.webContents
      if (wcCreate && !wcCreate.isDestroyed()) wcCreate.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'created', data: { sessionId } })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  // -- Session sync: delete session --
  if (msg.event === 'session:delete:request') {
    const requestId = msg.data?.requestId ?? ''
    const sessionId = msg.data?.sessionId
    const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
    const store = await ctx.getStoreForMobile(activeWorkspaceId as string | null)
    if (!store || !sessionId) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace or session ID', code: 'NO_WORKSPACE' })
      return true
    }
    try {
      const success = await store.deleteSession(sessionId as string)
      if (success) {
        ctx.mobilePersistedMessageCounts.delete(sessionId as string)
        ctx.stepManager.clearSession(sessionId as string)
      }
      broadcastToMobile('session:delete:response', { requestId, success })
      // Notify desktop renderer
      const wcDel = BrowserWindow.getAllWindows()[0]?.webContents
      if (wcDel && !wcDel.isDestroyed()) wcDel.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'deleted', data: { sessionId } })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  // -- Session sync: rename session --
  if (msg.event === 'session:rename:request') {
    const requestId = msg.data?.requestId ?? ''
    const sessionId = msg.data?.sessionId
    const title = msg.data?.title
    const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
    const store = await ctx.getStoreForMobile(activeWorkspaceId as string | null)
    if (!store || !sessionId || !title) {
      broadcastToMobile('session:error', { requestId, error: 'Missing parameters', code: 'BAD_REQUEST' })
      return true
    }
    try {
      const success = await store.renameSession(sessionId as string, title as string)
      broadcastToMobile('session:rename:response', { requestId, success })
      // Notify desktop renderer
      const wcRen = BrowserWindow.getAllWindows()[0]?.webContents
      if (wcRen && !wcRen.isDestroyed()) wcRen.send(IPC_CHANNELS['data:changed'], { source: 'mobile', entity: 'session', action: 'renamed', data: { sessionId, title } })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  // -- Session sync: clear session messages --
  if (msg.event === 'session:clear:request') {
    const sessionId = msg.data?.sessionId
    const activeWorkspaceId = msg.data?.activeWorkspaceId ?? null
    const store = await ctx.getStoreForMobile(activeWorkspaceId as string | null)
    if (!store || !sessionId) {
      broadcastToMobile('session:clear:response', { success: false })
      return true
    }
    try {
      await store.clearSession(sessionId as string)
      ctx.mobilePersistedMessageCounts.delete(sessionId as string)
      ctx.stepManager.clearSession(sessionId as string)
      broadcastToMobile('session:clear:response', { success: true })
    } catch {
      broadcastToMobile('session:clear:response', { success: false })
    }
    return true
  }

  return false
}
