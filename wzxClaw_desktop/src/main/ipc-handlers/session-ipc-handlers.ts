import { ipcMain } from 'electron'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { z } from 'zod'
import { IPC_CHANNELS, IpcSchemas } from '../../shared/ipc-channels'
import type { SessionRuntimeManager } from '../agent/session-runtime-manager'
import type { StepManager } from '../steps/step-manager'
import { SettingsManager } from '../settings-manager'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-persistence'
import { SessionStore } from '../persistence/session-store'
import { SessionStoreManager } from '../persistence/session-store-manager'

export interface SessionIpcDeps {
  runtimes: SessionRuntimeManager
  stepManager: StepManager
  settingsManager: SettingsManager
  workspaceManager: WorkspaceManager
  workspaceStore: WorkspaceStore
  getSessionStore: () => SessionStore
  storeManager: SessionStoreManager
  onDataChanged?: (event: string, data: unknown) => void
  /** Mutable ref shared from main handler for persisted message counts */
  persistedMessageCounts: Map<string, number>
}

export function registerSessionIpcHandlers(deps: SessionIpcDeps): void {
  const { runtimes, stepManager, settingsManager, workspaceManager, workspaceStore,
    storeManager, onDataChanged, persistedMessageCounts } = deps

  // Helper: resolve SessionStore for a given activeWorkspaceId
  const resolveStore = (activeWorkspaceId?: string) =>
    storeManager.getForWorkspace(activeWorkspaceId, workspaceManager, workspaceStore)

  const buildSessionDefaults = async (activeWorkspaceId?: string) => {
    const appConfig = settingsManager.getCurrentConfig()
    const workspace = activeWorkspaceId
      ? await workspaceStore.getWorkspace(activeWorkspaceId).catch(() => null)
      : null
    const workingDirectory = workspace?.projects[0]?.path ?? workspaceManager.getWorkspaceRoot() ?? process.cwd()
    return {
      owner: 'desktop-local' as const,
      workspaceId: activeWorkspaceId,
      model: appConfig.model,
      provider: appConfig.provider,
      workingDirectory,
      projectRoots: workspace ? workspace.projects.map(project => project.path) : [workingDirectory],
    }
  }

  // ============================================================
  // Session: list — returns all sessions for current project or task
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:list'], async (_event, payload?: { activeWorkspaceId?: string }) => {
    const store = await resolveStore(payload?.activeWorkspaceId)
    const sessions = await store.listSessions()

    // Enrich each session with todo summary and running status
    const runningIds = runtimes.listRunning()
    const { TodoWriteTool } = await import('../tools/todo-write')
    for (const session of sessions) {
      session.isRunning = runningIds.includes(session.id)
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
      } catch {
        // ignore — session may not have todos
      }
    }

    return { sessions, runningSessionIds: runningIds }
  })

  // ============================================================
  // Session: load — returns messages and restores agent context (Phase 3.4)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load'], async (event, request) => {
    const result = IpcSchemas['session:load'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const { sessionId, activeWorkspaceId } = result.data
    // 为该会话获取/创建 per-session runtime
    const loadRuntime = runtimes.getOrCreate(sessionId)
    // 优先使用请求中携带的 activeWorkspaceId（与 listSessions 保持一致），
    // 避免 runtime.activeWorkspace 尚未设置时读错 store。
    const store = await resolveStore(activeWorkspaceId)
    let resolvedWorkspace = loadRuntime.activeWorkspace ?? null
    if (activeWorkspaceId) {
      const workspace = await workspaceStore.getWorkspace(activeWorkspaceId).catch(() => null)
      if (workspace) {
        resolvedWorkspace = workspace
      }
    }
    const rawMessages = await store.loadSession(sessionId)

    // Reset persisted counter to match loaded message count (per-session)
    persistedMessageCounts.set(sessionId, rawMessages.length)

    const config = settingsManager.getCurrentConfig()
    const restoreCwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const restoreRoots = resolvedWorkspace
      ? resolvedWorkspace.projects.map(p => p.path)
      : [restoreCwd]

    // 会话上下文恢复不是首屏依赖。延迟到窗口可交互后再射入当前 runtime，
    // 避免启动后立即拖动窗口时，主进程被历史 token 统计抢占。
    const restoreSender = event.sender
    setTimeout(() => {
      loadRuntime.restoreContext(rawMessages, {
        model: config.model,
        provider: config.provider as 'openai' | 'anthropic',
        systemPrompt: config.systemPrompt ?? '',
        workingDirectory: restoreCwd,
        projectRoots: restoreRoots,
      }).then((info) => {
        if (!restoreSender.isDestroyed()) {
          restoreSender.send(IPC_CHANNELS['session:context-restored'], {
            sessionId,
            messageCount: info.messageCount,
            compacted: info.compacted,
            beforeTokens: info.beforeTokens,
            afterTokens: info.afterTokens
          })
        }
      }).catch((err) => {
        console.error('[session:load] restoreContext failed:', err)
      })
    }, 1000)

    return rawMessages
  })

  // ============================================================
  // Session: load-tail — 只返回最近 N 条消息，不触发 agentLoop 上下文恢复
  // 用于会话切换时的快速首帧渲染（先显示 tail，再后台 load 完整会话）
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:load-tail'], async (_event, request) => {
    const { sessionId, tailCount, activeWorkspaceId } = request as { sessionId: string; tailCount: number; activeWorkspaceId?: string }
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid session ID format')
    const store = await resolveStore(activeWorkspaceId)
    const rawCount = typeof tailCount === 'number' && Number.isFinite(tailCount) ? tailCount : 100
    const safeCount = Math.max(1, Math.min(rawCount, 500))
    return store.loadSessionTail(sessionId, safeCount)
  })

  // ============================================================
  // Session: delete — removes a session file
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:delete'], async (_event, request) => {
    const result = IpcSchemas['session:delete'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    const success = await store.deleteSession(result.data.sessionId)
    if (success) {
      // Clean up associated steps from memory and disk
      stepManager.clearSession(result.data.sessionId)
      onDataChanged?.('session:changed', { action: 'deleted', sessionId: result.data.sessionId })
    }
    return { success }
  })

  // ============================================================
  // Session: rename — updates session title via meta line
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:rename'], async (_event, request) => {
    const result = IpcSchemas['session:rename'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    const success = await store.renameSession(result.data.sessionId, result.data.title)
    if (success) onDataChanged?.('session:changed', { action: 'renamed', sessionId: result.data.sessionId, title: result.data.title })
    return { success }
  })

  // ============================================================
  // Session: duplicate — copies all messages to a new session
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:duplicate'], async (_event, request) => {
    const result = IpcSchemas['session:duplicate'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    // 加载源会话的所有消息行
    const messages = await store.loadSession(result.data.sessionId)
    if (messages.length === 0) {
      throw new Error('Source session is empty or not found')
    }
    // 创建新会话（直接复制 JSONL 内容）
    const newId = crypto.randomUUID()
    const jsonlContent = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    const newPath = path.join(store.sessionDir, `${newId}.jsonl`)
    const fsp = await import('fs/promises')
    await fsp.mkdir(store.sessionDir, { recursive: true })
    await fsp.writeFile(newPath, jsonlContent, 'utf-8')
    onDataChanged?.('session:changed', { action: 'created', sessionId: newId })
    return { newSessionId: newId }
  })

  // ============================================================
  // Session: ensure — creates an empty JSONL file for a new session
  // so it immediately appears in the sidebar before any messages
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:ensure'], async (_event, request: { sessionId: string; activeWorkspaceId?: string }) => {
    if (!/^[a-zA-Z0-9-]+$/.test(request.sessionId)) throw new Error('Invalid session ID format')
    const store = await resolveStore(request.activeWorkspaceId)
    await store.updateSessionConfig(request.sessionId, {
      title: 'Untitled',
      ...(await buildSessionDefaults(request.activeWorkspaceId)),
    })
    onDataChanged?.('session:changed', { action: 'created', sessionId: request.sessionId })
    return { success: true }
  })

  // ============================================================
  // Session: create — 创建新会话，生成 UUID 并写入空 JSONL 文件
  // IpcDataSource.createSession() 调用此方法
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:create'], async (_event, request?: { activeWorkspaceId?: string }) => {
    const sessionId = crypto.randomUUID()
    const store = await resolveStore(request?.activeWorkspaceId)
    // 写入空 meta 行，使 listSessions() 能立即看到新会话
    await store.updateSessionConfig(sessionId, {
      title: 'Untitled',
      ...(await buildSessionDefaults(request?.activeWorkspaceId)),
    })
    onDataChanged?.('session:changed', { action: 'created', sessionId })
    return { sessionId }
  })

  // ============================================================
  // Session: config:get — 读取桌面本地会话的持久化默认配置
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:config:get'], async (_event, request) => {
    const result = IpcSchemas['session:config:get'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    const config = await store.getSessionConfig(result.data.sessionId)
    if (!config) return { config: null }
    return {
      config: {
        ...(await buildSessionDefaults(result.data.activeWorkspaceId)),
        ...config,
        owner: config.owner ?? 'desktop-local',
      }
    }
  })

  // ============================================================
  // Session: config:update — 更新桌面本地会话的模型/Hand/工作区默认值
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['session:config:update'], async (_event, request) => {
    const result = IpcSchemas['session:config:update'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }
    const store = await resolveStore(result.data.activeWorkspaceId)
    const config = await store.updateSessionConfig(result.data.sessionId, {
      ...(await buildSessionDefaults(result.data.activeWorkspaceId)),
      ...result.data.patch,
      owner: result.data.patch.owner ?? 'desktop-local',
    })
    onDataChanged?.('session:changed', { action: 'config-updated', sessionId: result.data.sessionId })
    return { config }
  })

  // ============================================================
  // Session: export — export conversation to file
  // ============================================================
  const exportSchema = z.object({
    sessionId: z.string().regex(/^[a-zA-Z0-9-]+$/, 'Invalid session ID format'),
    format: z.enum(['markdown', 'json']),
    activeWorkspaceId: z.string().optional(),
  })

  ipcMain.handle(IPC_CHANNELS['session:export'], async (_event, request) => {
    const parsed = exportSchema.safeParse(request)
    if (!parsed.success) throw new Error(`Invalid request: ${parsed.error.message}`)
    const { sessionId, format, activeWorkspaceId } = parsed.data
    const { ConversationExporter } = await import('../export/conversation-exporter')
    const store = await resolveStore(activeWorkspaceId)
    const messages = await store.loadSession(sessionId)
    const exportDir = path.join(os.homedir(), '.wzxclaw', 'exports')
    const filePath = path.join(exportDir, `conversation-${sessionId.slice(0, 8)}`)
    const exportMessages = messages.map(message => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      isError: message.isError,
      usage: message.usage,
    }))
    const result = await ConversationExporter.exportToFile(exportMessages, filePath, format)
    return { filePath: result, messageCount: messages.length }
  })
}
