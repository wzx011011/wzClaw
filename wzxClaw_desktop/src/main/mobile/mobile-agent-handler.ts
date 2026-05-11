// ============================================================
// Mobile Agent Handler — 移动端 Agent 命令消息处理器
// 处理 command:send、command:stop 以及相关的 plan/ask-user/permission 事件
// ============================================================

import path from 'path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { DEFAULT_MODELS } from '../../shared/constants'
import { isActiveSessionTaskStatus } from '../agent/session-task-state-manager'
import type { AgentConfig } from '../agent/types'
import type { MobileRelayContext, MobileRelayMessage } from './mobile-relay-context'

// Dedup set max size for command:send
const PROCESSED_IDS_MAX = 1000

/**
 * 处理 Agent 命令和相关的移动端消息。
 * 返回 true 表示已处理，false 表示不匹配。
 */
export async function handleAgentMessage(
  msg: MobileRelayMessage,
  ctx: MobileRelayContext
): Promise<boolean> {
  const { broadcastToMobile } = ctx

  // -- Agent command: send --
  if (msg.event === 'command:send' && msg.data?.content) {
    // Dedup: skip if we've already processed this messageId (relay replay guard).
    const incomingId = msg.data.messageId as string | undefined
    if (incomingId) {
      const now = Date.now()
      // Bounded LRU cleanup: prune oldest entries when over limit
      if (ctx.processedMessageIds.size >= PROCESSED_IDS_MAX) {
        const toDelete = Math.ceil(PROCESSED_IDS_MAX * 0.25)
        let i = 0
        for (const key of ctx.processedMessageIds.keys()) {
          if (i++ >= toDelete) break
          ctx.processedMessageIds.delete(key)
        }
      }
      if (ctx.processedMessageIds.has(incomingId)) {
        broadcastToMobile('command:ack', { messageId: incomingId, status: 'duplicate' })
        return true
      }
      ctx.processedMessageIds.set(incomingId, now + 10 * 60 * 1000)
    }

    // Slash command preprocessing for mobile
    const trimmed = (msg.data.content as string).trim()
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ')
      const cmdName = spaceIdx > 0 ? trimmed.substring(1, spaceIdx) : trimmed.substring(1)
      const _cmdArgs = spaceIdx > 0 ? trimmed.substring(spaceIdx + 1).trim() : ''
      void _cmdArgs

      switch (cmdName) {
        case 'compact': {
          // Trigger manual context compaction — 仅针对当前手机会话生效
          const compactSid = ctx.mobileSessionId.value
          const compactRuntime = compactSid ? ctx.runtimes.getOrCreate(compactSid) : null
          const messages = compactRuntime ? compactRuntime.getMessages() : []
          const compactConfig = ctx.settingsManager.getCurrentConfig()
          if (messages.length > 0 && compactRuntime) {
            ctx.contextManager.compact(
              messages,
              ctx.gateway,
              compactConfig.model,
              compactConfig.provider,
              compactConfig.systemPrompt
            ).then((result) => {
              if (result.summary) {
                const recentMessages = messages.slice(-result.keptRecentCount)
                compactRuntime.replaceMessages([
                  { role: 'user' as const, content: result.summaryMessageContent, timestamp: Date.now() },
                  ...recentMessages
                ])
              }
              const sid = ctx.settingsManager.getLastSessionId() ?? ctx.mobileSessionId.value
              broadcastToMobile('stream:agent:done', { usage: null, compacted: true, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens, sessionId: sid })
            }).catch((err: unknown) => {
              broadcastToMobile('stream:error', { error: err instanceof Error ? err.message : String(err) })
            })
          } else {
            const sid = ctx.settingsManager.getLastSessionId() ?? ctx.mobileSessionId.value
            broadcastToMobile('stream:agent:done', { usage: null, sessionId: sid })
          }
          return true
        }
        case 'clear': {
          // Discard the mobile-current session runtime and start fresh on next send
          if (ctx.mobileSessionId.value) {
            ctx.stepManager.clearSession(ctx.mobileSessionId.value)
            ctx.runtimes.delete(ctx.mobileSessionId.value)
            // runtime 已销毁，必须同步清除持久化计数，避免下次 send 时 counter 与新 runtime 不一致
            ctx.mobilePersistedMessageCounts.delete(ctx.mobileSessionId.value)
          }
          ctx.mobileSessionId.value = null
          broadcastToMobile('session:create:response', { success: true })
          return true
        }
        case 'init': {
          // Replace content with the /init prompt, continue to agentLoop.run()
          msg.data.content = `Please analyze this codebase and create a WZXCLAW.md file in the project root.\n\nFirst, explore the project to understand:\n- Package manager and key scripts\n- README and existing documentation\n- Directory structure and main source directories\n- Test setup and how to run tests\n- Any existing instruction files\n\nThen create WZXCLAW.md with ONLY:\n1. Build & Dev Commands (non-obvious only)\n2. Architecture Overview (3-5 sentences)\n3. Key Conventions (differs from defaults)\n4. Development Notes (gotchas, setup)\n\nKeep it under 100 lines. If WZXCLAW.md exists, suggest improvements.`
          break
        }
        case 'commit': {
          msg.data.content = `Analyze the current git changes and create a commit. Look at \`git status\` and \`git diff\` to understand what changed, then stage and commit with an appropriate message. Do NOT push.`
          break
        }
        case 'review': {
          msg.data.content = `Review the current git diff for code quality issues, bugs, and improvements. Run \`git diff\` to see the changes, then provide a thorough code review.`
          break
        }
        case 'help': {
          const sid0 = ctx.settingsManager.getLastSessionId() ?? ctx.mobileSessionId.value
          broadcastToMobile('stream:agent:text', { content: `**可用命令：**\n\n- /help — 显示此帮助\n- /init — 分析代码库并创建 WZXCLAW.md\n- /compact — 压缩上下文\n- /context — 查看上下文使用情况\n- /clear — 新建会话\n- /commit — 分析 git 变更并提交\n- /review — 代码审查\n- /insights — 生成代码洞察`, sessionId: sid0 })
          broadcastToMobile('stream:agent:done', { usage: { inputTokens: 0, outputTokens: 0 }, turnCount: 0, sessionId: sid0 })
          return true
        }
        case 'context': {
          const sid1 = ctx.settingsManager.getLastSessionId() ?? ctx.mobileSessionId.value
          const totalUsage = ctx.contextManager.getTotalUsage()
          const history = ctx.contextManager.getCompactHistory()
          broadcastToMobile('stream:agent:text', { content: `**上下文使用情况：**\n\n- 输入 tokens: ${totalUsage.inputTokens}\n- 输出 tokens: ${totalUsage.outputTokens}\n- 历史压缩次数: ${history.count}${history.lastBefore != null ? `\n- 上次压缩: ${history.lastBefore} → ${history.lastAfter} tokens` : ''}`, sessionId: sid1 })
          broadcastToMobile('stream:agent:done', { usage: { inputTokens: 0, outputTokens: 0 }, turnCount: 0, sessionId: sid1 })
          return true
        }
        case 'insights': {
          msg.data.content = `Analyze the codebase and provide insights about code quality, potential issues, and improvement opportunities. Look at the project structure, key files, and recent changes.`
          break
        }
        // Unknown commands pass through as regular text
      }
    }

    // Use session ID from mobile, or generate one for this mobile conversation
    const requestedSessionId = typeof msg.data.sessionId === 'string' && msg.data.sessionId.length > 0
      ? msg.data.sessionId
      : null
    // Per-session runtime 下，不同 sessionId 自然隔离，不再需要 reset-context 语义。
    // 仅保留 sessionId 生成逻辑。
    const sessionTransition = ctx.getMobileSessionTransition({
      requestedSessionId,
      activeSessionId: ctx.mobileSessionId.value ?? ctx.settingsManager.getLastSessionId(),
      hasMessages: false,
      generatedSessionId: crypto.randomUUID(),
    })
    const sessionId = sessionTransition.sessionId
    const runId = crypto.randomUUID()
    ctx.mobileSessionId.value = sessionId
    ctx.stepManager.setActiveSession(sessionId)
    const toolCallInputs = new Map<string, Record<string, unknown>>()

    const config = ctx.settingsManager.getCurrentConfig()
    const workingDirectory = ctx.getWorkingDirectory()
    // Ensure LLM adapter is registered (matches ipc-handlers.ts logic)
    if (config.apiKey) {
      ctx.gateway.addProvider({
        provider: config.provider as 'openai' | 'anthropic',
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })
      // If model requires a different provider, add cross-adapter (e.g. glm-4-plus needs openai)
      const modelPreset = DEFAULT_MODELS.find((m) => m.id === config.model)
      if (modelPreset && modelPreset.provider !== config.provider) {
        const crossProvider = modelPreset.provider as 'openai' | 'anthropic'
        let crossBaseURL = config.baseURL
        if (config.baseURL?.includes('/api/anthropic')) {
          crossBaseURL = config.baseURL.replace('/api/anthropic', '/api/paas/v4')
        } else if (config.baseURL?.includes('/api/paas/v4')) {
          crossBaseURL = config.baseURL.replace('/api/paas/v4', '/api/anthropic')
        }
        ctx.gateway.addProvider({
          provider: crossProvider,
          apiKey: config.apiKey,
          baseURL: crossBaseURL,
        })
      }
    }

    // 注意：原代码中 runtime 在此处未声明但在下方使用。
    // 保留原有行为：先构建 agentConfig，之后才通过 runtimes.getOrCreate 获取 runtime。
    // agentConfig 中的 projectRoots 使用 workingDirectory 作为 fallback。
    const agentConfig: AgentConfig = {
      model: config.model,
      provider: config.provider as 'openai' | 'anthropic',
      systemPrompt: config.systemPrompt ?? '',
      workingDirectory,
      projectRoots: [workingDirectory],
      conversationId: sessionId,
      thinkingDepth: config.thinkingDepth as 'none' | 'low' | 'medium' | 'high' | undefined,
    }

    ctx.sessionTaskStates.start(sessionId, runId, '收到手机端任务')

    // Broadcast the assigned session ID back to mobile so it can track it
    broadcastToMobile('session:active', { sessionId })

    // If resuming an existing mobile session, restore chat history into the per-session runtime
    if (sessionTransition.shouldRestoreHistory) {
      try {
        const activeStore = ctx.getActiveSessionStore()
        const rawMessages = await activeStore.loadSession(sessionId)
        if (rawMessages.length > 0) {
          await ctx.runtimes.getOrCreate(sessionId).restoreContext(rawMessages, agentConfig)
        }
        // Restore steps from disk into memory for this session
        await ctx.stepManager.loadSessionSteps(sessionId)
        ctx.mobilePersistedMessageCounts.set(sessionId, rawMessages.length)
      } catch {
        ctx.mobilePersistedMessageCounts.set(sessionId, 0)
      }
    }

    // 只有移动端会话与桌面当前会话相同时，才将用户消息和流式事件转发到渲染器。
    // 若不同会话，渲染器展示的是桌面会话内容，移动端的回答不应干扰其显示。
    const desktopCurrentSessionId = ctx.settingsManager.getLastSessionId()
    const shouldForwardToRenderer = !desktopCurrentSessionId || desktopCurrentSessionId === sessionId

    // Send the mobile user's message to renderer so it appears in the chat (same-session only)
    if (shouldForwardToRenderer) {
      const wc0 = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc0) {
        wc0.send(IPC_CHANNELS['stream:mobile_user_message'], {
          content: msg.data.content,
          source: 'mobile',
          sessionId,
        })
      }
    }

    // Acknowledge receipt back to mobile.
    const messageId = msg.data.messageId || crypto.randomUUID()
    broadcastToMobile('command:ack', { messageId, status: 'received' })

    try {
      // Mobile sender: forwards stream:retrying to mobile alongside the renderer
      const wcForMobile = BrowserWindow.getAllWindows()[0]?.webContents
      const mobileSender = {
        isDestroyed: () => wcForMobile?.isDestroyed() ?? true,
        send: (channel: string, ...args: unknown[]) => {
          const showToolSteps = ctx.settingsManager.getShowToolSteps()
          // 仅在手机会话与桌面当前会话一致时，才将次要事件（retrying/sub-tool/ask-user）推给渲染器。
          if (shouldForwardToRenderer && wcForMobile && !wcForMobile.isDestroyed()) {
            // Skip tool step events to renderer when showToolSteps is off
            const isToolChannel = channel === IPC_CHANNELS['stream:tool_use_start'] || channel === IPC_CHANNELS['stream:tool_use_end'] || channel === IPC_CHANNELS['stream:thinking_delta'] || channel === IPC_CHANNELS['stream:sub_tool_use_start'] || channel === IPC_CHANNELS['stream:sub_tool_use_end'] || channel === IPC_CHANNELS['stream:sub_text']
            if (showToolSteps || !isToolChannel) {
              wcForMobile.send(channel, ...args)
            }
          }
          if (channel === IPC_CHANNELS['stream:retrying']) {
            if (showToolSteps) ctx.relayClient.broadcast('stream:retrying', args[0] ?? {})
          }
          if (channel === IPC_CHANNELS['agent:permission_request']) {
            ctx.sessionTaskStates.update(sessionId, { status: 'waiting_permission', phase: 'permission', message: '等待权限确认' })
          }
          if (channel === IPC_CHANNELS['ask-user:question']) {
            ctx.sessionTaskStates.update(sessionId, { status: 'waiting_user', phase: 'ask_user', message: '等待用户回答' })
            ctx.relayClient.broadcast('stream:agent:ask_user_question', { ...(args[0] as Record<string, unknown> | undefined), sessionId })
          }
          if (channel === IPC_CHANNELS['stream:sub_tool_use_start']) {
            if (showToolSteps) ctx.relayClient.broadcast('stream:sub:tool_call', args[0] ?? {})
          }
          if (channel === IPC_CHANNELS['stream:sub_tool_use_end']) {
            if (showToolSteps) ctx.relayClient.broadcast('stream:sub:tool_result', args[0] ?? {})
          }
          if (channel === IPC_CHANNELS['stream:sub_text']) {
            if (showToolSteps) ctx.relayClient.broadcast('stream:sub:text', args[0] ?? {})
          }
        }
      } as unknown as Electron.WebContents

      // Inject active workspace context from mobile message
      const runtime = ctx.runtimes.getOrCreate(sessionId)
      if (msg.data.activeWorkspaceId) {
        const workspace = await ctx.workspaceStore.getWorkspace(msg.data.activeWorkspaceId as string)
        runtime.activeWorkspace = workspace ?? null
      } else {
        runtime.activeWorkspace = null
      }

      // Update agentConfig with runtime workspace info (now that runtime exists)
      agentConfig.projectRoots = runtime.activeWorkspace
        ? runtime.activeWorkspace.projects.map(p => p.path)
        : [workingDirectory]

      // 并发保护：仅在同一 sessionId 上重发时取消上一次；
      // 不再跨会话 cancel 全局，让多会话可并发运行。
      if (runtime.isRunning) {
        runtime.cancel()
        // 等待上一次 run() generator 真正退出（最多 500ms），防止 abortController 被覆盖
        const deadline = Date.now() + 500
        while (runtime.isRunning && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 10))
        }
      }

      ctx.runtimes.notifyRunningChanged(sessionId, true)
      let sawFirstEvent = false
      let sawDone = false
      let lastAgentError: { error: string; recoverable: boolean } | null = null
      try {
      for await (const agentEvent of runtime.run(msg.data.content as string, agentConfig, mobileSender)) {
        if (!sawFirstEvent) {
          sawFirstEvent = true
          ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'streaming', message: 'AI 正在生成' })
          await ctx.persistRuntimeDelta(sessionId, runtime, '已保存用户消息')
        }
        // Forward stream events to renderer — only when mobile session matches desktop's current session
        const wc = shouldForwardToRenderer ? BrowserWindow.getAllWindows()[0]?.webContents : null
        if (!wc) {
          switch (agentEvent.type) {
            case 'agent:tool_call':
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_call', message: `正在执行 ${agentEvent.toolName}` })
              break
            case 'agent:tool_result':
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_result', message: `${agentEvent.toolName} 执行完成` })
              break
            case 'agent:error':
              lastAgentError = { error: agentEvent.error, recoverable: agentEvent.recoverable }
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: agentEvent.recoverable ? 'recoverable_error' : 'error', message: agentEvent.error, error: agentEvent.error, recoverable: agentEvent.recoverable })
              break
            case 'agent:turn_end':
              await ctx.persistRuntimeDelta(sessionId, runtime, '已保存完整轮次')
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'turn_end', message: '轮次已保存' })
              break
            case 'agent:done': {
              sawDone = true
              try {
                const persistedMessageCount = await ctx.persistRuntimeDelta(sessionId, runtime, '任务完成，历史已保存')
                ctx.sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成', persistedMessageCount })
              } catch (saveErr) {
                console.error('[mobile] Failed to persist session:', saveErr)
                ctx.sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成（保存历史时出错）' })
              }
              ctx.cleanupToolResults(sessionId).catch(() => {})
              // 注意：不要在此清除 mobilePersistedMessageCounts —— runtime 仍保留全部消息，
              // 同一 session 下次 send 若 counter 归零，会导致整段历史被再次追加（重复持久化 bug）。
              // 计数器仅在 runtime 被销毁/会话切换/clear/delete 时重置。
              break
            }
          }
        }
        if (wc) {
          switch (agentEvent.type) {
            case 'agent:text':
              wc.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content, sessionId })
              break
            case 'agent:thinking':
              wc.send(IPC_CHANNELS['stream:thinking_delta'], { content: agentEvent.content, sessionId })
              break
            case 'agent:tool_call':
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_call', message: `正在执行 ${agentEvent.toolName}` })
              toolCallInputs.set(agentEvent.toolCallId, agentEvent.input)
              wc.send(IPC_CHANNELS['stream:tool_use_start'], {
                id: agentEvent.toolCallId,
                name: agentEvent.toolName,
                input: agentEvent.input,
                sessionId,
              })
              break
            case 'agent:tool_result':
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'tool_result', message: `${agentEvent.toolName} 执行完成` })
              wc.send(IPC_CHANNELS['stream:tool_use_end'], { id: agentEvent.toolCallId, output: agentEvent.output, isError: agentEvent.isError, toolName: agentEvent.toolName, sessionId })
              // Forward file changes for write tools (same as ipc-handlers path)
              if (!agentEvent.isError && (agentEvent.toolName === 'FileWrite' || agentEvent.toolName === 'FileEdit')) {
                const tc = toolCallInputs.get(agentEvent.toolCallId)
                const filePath = tc?.path as string | undefined
                if (filePath) {
                  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(agentConfig.workingDirectory, filePath)
                  wc.send(IPC_CHANNELS['file:changed'], { filePath: absolutePath, changeType: 'modified' })
                }
              }
              toolCallInputs.delete(agentEvent.toolCallId)
              break
            case 'agent:error':
              lastAgentError = { error: agentEvent.error, recoverable: agentEvent.recoverable }
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: agentEvent.recoverable ? 'recoverable_error' : 'error', message: agentEvent.error, error: agentEvent.error, recoverable: agentEvent.recoverable })
              wc.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error, sessionId })
              break
            case 'agent:turn_end':
              wc.send(IPC_CHANNELS['stream:turn_end'], { sessionId })
              await ctx.persistRuntimeDelta(sessionId, runtime, '已保存完整轮次')
              ctx.sessionTaskStates.update(sessionId, { status: 'running', phase: 'turn_end', message: '轮次已保存' })
              break
            case 'agent:done':
              sawDone = true
              wc.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage, sessionId })
              // Agent 完成通知（声音 + 桌面通知）
              try {
                const isFocused = BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
                ctx.notificationService.notify(isFocused, 'wzxClaw', 'AI 任务已完成')
              } catch {}
              // Persist mobile messages before announcing terminal completion.
              try {
                const persistedMessageCount = await ctx.persistRuntimeDelta(sessionId, runtime, '任务完成，历史已保存')
                ctx.sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成', persistedMessageCount })
              } catch (saveErr) {
                console.error('[mobile] Failed to persist session:', saveErr)
                ctx.sessionTaskStates.finish(sessionId, 'completed', { message: '任务已完成（保存历史时出错）' })
              }
              // 清理该会话的工具结果磁盘文件
              ctx.cleanupToolResults(sessionId).catch(() => {})
              // 注意：不要在此清除 mobilePersistedMessageCounts —— runtime 仍保留全部消息，
              // 同一 session 下次 send 若 counter 归零，会导致整段历史被再次追加（重复持久化 bug）。
              // 计数器仅在 runtime 被销毁/会话切换/clear/delete 时重置。
              break
            case 'agent:compacted':
              wc.send(IPC_CHANNELS['session:compacted'], {
                beforeTokens: agentEvent.beforeTokens,
                afterTokens: agentEvent.afterTokens,
                auto: agentEvent.auto,
                sessionId,
              })
              break
          }
        }
        // 串台修复: 在所有流式事件中携带 sessionId，手机端可据此过滤非当前会话的事件
        // When showToolSteps is off, skip tool step events for mobile
        const isToolStepEvent = agentEvent.type === 'agent:tool_call' || agentEvent.type === 'agent:tool_result'  // thinking is NOT a tool step — always broadcast
        if (isToolStepEvent && !ctx.settingsManager.getShowToolSteps()) {
          // Skip broadcasting tool step events to mobile
        } else {
          ctx.relayClient.broadcast(`stream:${agentEvent.type}`, { ...agentEvent, sessionId })
        }
        // Forward TodoWrite structured todo list to mobile
        if (agentEvent.type === 'agent:tool_result' && agentEvent.toolName === 'TodoWrite' && !agentEvent.isError) {
          const todoTool = ctx.toolRegistry.get('TodoWrite') as { getCurrentTodos?: () => unknown[] } | undefined
          if (todoTool?.getCurrentTodos) {
            broadcastToMobile('todo:updated', { todos: todoTool.getCurrentTodos() })
          }
        }
      }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        try {
          const persistedMessageCount = await ctx.persistRuntimeDelta(sessionId, runtime, '异常结束，已保存可用历史')
          ctx.sessionTaskStates.finish(sessionId, 'failed', { message, error: message, recoverable: false, persistedMessageCount })
        } catch {}
        throw err
      } finally {
        if (!sawDone) {
          const currentStatus = ctx.sessionTaskStates.get(sessionId)?.status
          if (currentStatus === 'stopping') {
            try {
              const persistedMessageCount = await ctx.persistRuntimeDelta(sessionId, runtime, '任务已停止，历史已保存')
              ctx.sessionTaskStates.finish(sessionId, 'cancelled', { message: '任务已停止', persistedMessageCount })
            } catch {
              ctx.sessionTaskStates.finish(sessionId, 'cancelled', { message: '任务已停止（保存历史时出错）' })
            }
          } else if (lastAgentError && !lastAgentError.recoverable) {
            try {
              const persistedMessageCount = await ctx.persistRuntimeDelta(sessionId, runtime, '任务失败，历史已保存')
              ctx.sessionTaskStates.finish(sessionId, 'failed', { message: lastAgentError.error, error: lastAgentError.error, recoverable: false, persistedMessageCount })
            } catch {
              ctx.sessionTaskStates.finish(sessionId, 'failed', { message: lastAgentError.error, error: lastAgentError.error, recoverable: false })
            }
          } else if (currentStatus && isActiveSessionTaskStatus(currentStatus)) {
            ctx.sessionTaskStates.finish(sessionId, 'interrupted', { message: '任务异常中断' })
          }
        }
        // 手机端需要收到 stream:agent:done 才能关闭「思考中」状态。
        // 任务被取消/中断/fatal error 时 agent loop 不 yield agent:done，
        // 必须在此补发，否则手机 UI 永远卡在 streaming 状态。
        ctx.relayClient.broadcast('stream:agent:done', {
          usage: null,
          turnCount: 0,
          cancelled: true,
          sessionId,
        })
        ctx.runtimes.notifyRunningChanged(sessionId, false)
        ctx.mobilePersistLocks.delete(sessionId)
      }
    } catch (err: unknown) {
      ctx.relayClient.broadcast('stream:agent:done', {
        usage: null,
        turnCount: 0,
        cancelled: true,
        error: err instanceof Error ? err.message : String(err),
        sessionId: ctx.mobileSessionId.value,
      })
      ctx.relayClient.broadcast('stream:error', { error: err instanceof Error ? err.message : String(err), sessionId: ctx.mobileSessionId.value })
    }
    return true
  }

  if (msg.event === 'command:stop') {
    // 仅取消当前手机会话（不会跨会话误杀）
    const stopSessionId = typeof msg.data?.sessionId === 'string' ? msg.data.sessionId : ctx.mobileSessionId.value
    if (stopSessionId) {
      ctx.sessionTaskStates.update(stopSessionId, { status: 'stopping', phase: 'stopping', message: '正在停止' })
      ctx.runtimes.cancel(stopSessionId)
    }
    return true
  }

  // -- Plan Mode: mobile approval/rejection --
  if (msg.event === 'plan:decision') {
    ctx.planModeController.resolveDecision(msg.data?.approved === true)
    return true
  }

  // -- AskUserQuestion: mobile sends back the user's answer --
  if (msg.event === 'ask-user:answer') {
    const answer = msg.data as { questionId: string; selectedLabels: string[]; customText?: string }
    ctx.askUserTool.resolveQuestion(answer)
    return true
  }

  // -- Permission mode: mobile requests current mode --
  if (msg.event === 'permission:get_mode:request') {
    const requestId = msg.data?.requestId ?? ''
    broadcastToMobile('permission:mode:response', {
      requestId,
      mode: ctx.permissionManager.getMode()
    })
    return true
  }

  // -- Permission mode: mobile sets a new mode --
  if (msg.event === 'permission:set_mode:request') {
    const requestId = msg.data?.requestId ?? ''
    const mode = msg.data?.mode as string | undefined
    if (mode) {
      try {
        ctx.permissionManager.setMode(mode)
      } catch (err: unknown) {
        broadcastToMobile('permission:mode:response', { requestId, error: err instanceof Error ? err.message : String(err) })
        return true
      }
    }
    broadcastToMobile('permission:mode:response', {
      requestId,
      mode: ctx.permissionManager.getMode()
    })
    return true
  }

  return false
}
