// ============================================================
// Headless Agent Runner — 在 Electron 外运行 AgentLoop
// 复用 wzxClaw 核心逻辑，去掉 UI 依赖，用于自动化评测
// ============================================================

import { AgentLoop } from '../main/agent/agent-loop'
import { LLMGateway } from '../main/llm/gateway'
import { createDefaultTools } from '../main/tools/tool-registry'
import { PermissionManager } from '../main/permission/permission-manager'
import { ContextManager } from '../main/context/context-manager'
import { shutdownLangfuse, flushLangfuse } from '../main/observability/langfuse-observer'
import { prepareWorkspace, extractPatch } from './workspace-isolation'
import { DEFAULT_SYSTEM_PROMPT } from '../shared/constants'
import type { AgentEvent, AgentConfig } from '../main/agent/types'
import type { BenchmarkTask, HeadlessConfig, HeadlessRunResult, TaskTraceData } from './types'

/**
 * 运行单个评测工作区
 *
 * 流程：构建 AgentLoop → 收集事件 → 提取 patch
 * 工作空间由调用方（batch-runner）管理，避免重复创建
 *
 * 复用路径：
 * - AgentLoop (agent-loop.ts:28-40) — 直接实例化
 * - createDefaultTools(workspaceDir) (tool-registry.ts:65) — 不传可选参数
 * - PermissionManager.setMode('bypass') (permission-manager.ts:62-65)
 * - ContextManager — 直接 new
 * - LLMGateway.addProvider() (gateway.ts:10)
 */
export async function runBenchmarkTask(
  task: BenchmarkTask,
  config: HeadlessConfig,
  workspaceDir?: string,
): Promise<HeadlessRunResult> {
  const startTime = Date.now()

  // 1. 使用传入的工作空间，或自行创建（兼容独立调用）
  let ownWorkspace = false
  let workspace: { workspaceDir: string; cleanup: () => Promise<void> }
  if (workspaceDir) {
    workspace = { workspaceDir, cleanup: async () => {} }
  } else {
    workspace = await prepareWorkspace(task)
    ownWorkspace = true
  }

  // 保存旧 BENCHMARK_TASK_ID，避免并行工作区互相覆盖
  const prevTaskId = process.env.BENCHMARK_TASK_ID
  try {
    // 2. 设置 BENCHMARK_TASK_ID — Langfuse trace 自动打 tag
    process.env.BENCHMARK_TASK_ID = task.id
    process.env.BENCHMARK_TASK_ID = task.id

    // 3. 构建真实 LLM Gateway
    const gateway = new LLMGateway()
    gateway.addProvider({
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })

    // 4. 创建工具注册表（不需要 Electron 依赖的工具自动跳过）
    const toolRegistry = createDefaultTools(workspace.workspaceDir)

    // 5. 权限管理器设为 bypass — 自动批准所有操作
    const permMgr = new PermissionManager()
    permMgr.setMode('bypass')

    // 6. 上下文管理器
    const contextMgr = new ContextManager()

    // 7. 构建 AgentLoop
    const loop = new AgentLoop(gateway, toolRegistry, permMgr, contextMgr)

    // 8. Agent 配置
    const conversationId = `bench-${task.id}-${Date.now()}`
    const agentConfig: AgentConfig = {
      model: config.model,
      provider: config.provider,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory: workspace.workspaceDir,
      conversationId,
      maxTurns: config.maxTurns ?? 15,
    }

    // 9. 运行并收集所有事件
    const events: HeadlessRunResult['events'] = []
    let doneUsage = { inputTokens: 0, outputTokens: 0 }
    let turnCount = 0

    for await (const event of loop.run(task.description, agentConfig) as AsyncGenerator<AgentEvent>) {
      events.push({
        type: event.type,
        timestamp: Date.now(),
        ...(event.type === 'agent:done' ? {
          turnCount: (event as any).turnCount,
          usage: (event as any).usage,
        } : {}),
        ...(event.type === 'agent:tool_call' ? {
          toolCallId: (event as any).toolCallId,
          toolName: (event as any).toolName,
        } : {}),
        ...(event.type === 'agent:tool_result' ? {
          toolCallId: (event as any).toolCallId,
          toolName: (event as any).toolName,
          isError: (event as any).isError,
        } : {}),
        ...(event.type === 'agent:text' ? {
          content: (event as any).content,
        } : {}),
      })

      if (event.type === 'agent:done') {
        doneUsage = (event as any).usage ?? doneUsage
        turnCount = (event as any).turnCount ?? 0
      }
    }

    // 10. 确保 Langfuse 评分写入（单工作区 flush，不等全部跑完）
    await flushLangfuse()

    // 11. 提取工作空间的 git diff（agent 的修改）
    const patch = await extractPatch(workspace.workspaceDir)

    // 11. 提取消息记录
    const messages: HeadlessRunResult['messages'] = (loop as any).getMessages()?.map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
    })) ?? []

    return {
      taskId: task.id,
      events,
      messages,
      usage: doneUsage,
      turnCount,
      traceId: conversationId,
      duration: Date.now() - startTime,
      patch: patch || undefined,
    }
  } finally {
    // 恢复之前的 BENCHMARK_TASK_ID，避免影响并行工作区
    if (prevTaskId !== undefined) {
      process.env.BENCHMARK_TASK_ID = prevTaskId
    } else {
      delete process.env.BENCHMARK_TASK_ID
    }
    // 只清理自行创建的工作空间（batch-runner 管理的由 batch-runner 清理）
    if (ownWorkspace) {
      await workspace.cleanup().catch(() => {})
    }
  }
}

/**
 * 运行结束后关闭 Langfuse 客户端（确保所有 trace 写入）
 */
export async function shutdown(): Promise<void> {
  await shutdownLangfuse()
}

const EDIT_TOOLS = new Set(['FileEdit', 'FileWrite'])
const READ_TOOLS = new Set(['FileRead', 'Grep', 'Glob'])

/**
 * 从事件流和消息记录中提取结构化 trace 摘要
 * 用于逐工作区失败分析，替代存储完整原始事件
 */
export function extractTraceData(
  events: HeadlessRunResult['events'],
  messages: HeadlessRunResult['messages'],
  testCommand?: string,
  testOutput?: string,
): TaskTraceData {
  let currentTurn = 0
  let firstEditAttempt: TaskTraceData['firstEditAttempt'] = undefined
  let readsBeforeFirstEdit = 0
  let ranTestBeforeDone = false
  let errorCount = 0
  let hitMaxTurns = false
  let hasSeenEdit = false
  const toolCallSequence: TaskTraceData['toolCallSequence'] = []

  for (const ev of events) {
    if (ev.type === 'agent:done') {
      currentTurn = (ev as any).turnCount ?? currentTurn
      if ((ev as any).reason === 'max_turns') hitMaxTurns = true
    }

    if (ev.type === 'agent:tool_call') {
      const tool = String((ev as any).toolName ?? '')
      toolCallSequence.push({ tool, turn: currentTurn, isError: false })

      if (EDIT_TOOLS.has(tool) && !hasSeenEdit) {
        hasSeenEdit = true
        firstEditAttempt = { tool, turn: currentTurn, isError: false }
      }
      if (READ_TOOLS.has(tool) && !hasSeenEdit) {
        readsBeforeFirstEdit++
      }
      // 检测是否跑了测试命令
      if (tool === 'Bash' && testCommand) {
        // 从后续 tool_result 事件的 messages 中检测
      }
    }

    if (ev.type === 'agent:tool_result') {
      const tool = String((ev as any).toolName ?? '')
      const isError = Boolean((ev as any).isError)
      if (isError) errorCount++

      // 更新 toolCallSequence 中对应项的 isError
      const entry = toolCallSequence.findLast(tc => tc.tool === tool && !tc.isError)
      if (entry && isError) entry.isError = true

      // 更新 firstEditAttempt
      if (firstEditAttempt && EDIT_TOOLS.has(tool) && isError) {
        firstEditAttempt.isError = true
      }

      // 检测 Bash 命令是否包含测试命令关键字
      if (tool === 'Bash' && testCommand && !ranTestBeforeDone) {
        ranTestBeforeDone = true
      }
    }
  }

  // 从 messages 中更精确地检测测试执行
  if (!ranTestBeforeDone && testCommand) {
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'Bash' && tc.input?.command) {
            const cmd = String(tc.input.command)
            // 提取 testCommand 中的核心关键词（如 pytest, go test 等）
            const testKeywords = testCommand.split(/\s+/).filter(w => w.length > 2).slice(0, 3)
            if (testKeywords.some(kw => cmd.includes(kw))) {
              ranTestBeforeDone = true
              break
            }
          }
        }
      }
      if (ranTestBeforeDone) break
    }
  }

  // 提取最后一条 assistant 文本
  let finalAssistantText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content && m.content.length > 0) {
      finalAssistantText = m.content.slice(0, 2000)
      break
    }
  }

  return {
    toolCallSequence: toolCallSequence.slice(0, 100), // limit size
    firstEditAttempt,
    ranTestBeforeDone,
    readsBeforeFirstEdit,
    errorCount,
    finalAssistantText,
    hitMaxTurns,
    testOutput: testOutput?.slice(0, 2000),
  }
}
