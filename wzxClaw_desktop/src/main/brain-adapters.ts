// ============================================================
// Brain Adapters — Electron 特定接口适配器
// 桥接桌面端现有服务到 @wzxclaw/brain 的 DI 接口
//
// 每个适配器将 Electron/WebContents/IPC 相关的服务
// 包装为 brain 包定义的纯接口实例
// ============================================================

import type {
  IEventSender,
  IObservability,
  ILogger,
  IToolExecutor,
  IToolExecutionContext,
  IToolExecutionResult,
  IPermissionManager,
  IStreamProvider,
  IStreamOptions,
  IContextManager,
  IHookRegistry,
  IHookResult,
} from '@wzxclaw/brain'
import type { StreamEvent } from '@wzxclaw/brain'
import { startTrace, endTrace, getActiveTrace } from './observability/langfuse-observer'
import { DebugLogger } from './utils/debug-logger'
import type { ToolRegistry } from './tools/tool-registry'
import type { PermissionManager } from './permission/permission-manager'
import { truncateToolResult } from './context/tool-result-budget'
import { maybePersistLargeToolResult, ToolResultReplacementState } from './context/tool-result-storage'
import { ContextManager as ContextManagerClass } from './context/context-manager'
import { flattenToolOutput } from './tools/tool-interface'
import type { FileHistoryManager } from './file-history/file-history-manager'
import type { HookRegistry } from './hooks/hook-registry'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import path from 'path'

// ============================================================
// DesktopEventSender — 包装 Electron.WebContents 为 IEventSender
// ============================================================

export class DesktopEventSender implements IEventSender {
  constructor(private webContents: Electron.WebContents) {}

  send(channel: string, data: unknown): void {
    if (!this.webContents.isDestroyed()) {
      this.webContents.send(channel, data)
    }
  }

  isDestroyed(): boolean {
    return this.webContents.isDestroyed()
  }
}

// ============================================================
// DesktopObservability — 委托给 langfuse-observer 模块
// ============================================================

export class DesktopObservability implements IObservability {
  startTrace(
    conversationId: string,
    model: string,
    userInput: string,
    workingDirectory: string,
    parentSpan?: unknown,
  ): void {
    startTrace(conversationId, model, userInput, workingDirectory, parentSpan)
  }

  endTrace(
    conversationId: string,
    usage: { inputTokens: number; outputTokens: number },
    turnCount: number,
    error: boolean,
    messages?: unknown[],
  ): void {
    endTrace(conversationId, usage, turnCount, error, messages as import('../shared/types').Message[] | undefined)
  }

  getActiveTrace(conversationId: string) {
    return getActiveTrace(conversationId)
  }
}

// ============================================================
// DesktopLogger — 委托给 DebugLogger（使用 Electron 路径）
// ============================================================

export class DesktopLogger implements ILogger {
  private inner: DebugLogger

  constructor(sessionId: string) {
    this.inner = new DebugLogger(sessionId)
  }

  log(level: string, message: string, data?: Record<string, unknown>): void {
    this.inner.log(level, message, data)
  }

  close(): void {
    this.inner.close()
  }
}

// ============================================================
// DesktopToolExecutor — 桌面端工具执行适配器
// 封装 ToolRegistry + PermissionManager + HookRegistry + FileHistoryManager
// 为 brain 包的 IToolExecutor 接口
// ============================================================

export class DesktopToolExecutor implements IToolExecutor {
  constructor(
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private hookRegistry: HookRegistry | undefined,
    private historyManager: FileHistoryManager | undefined,
    private config: {
      conversationId: string
      workingDirectory: string
      workspaceId?: string
    },
    private abortSignal: AbortSignal,
    private sender?: IEventSender,
    private replacementState?: ToolResultReplacementState,
  ) {}

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: IToolExecutionContext,
  ): Promise<IToolExecutionResult> {
    const _eval = getActiveTrace(this.config.conversationId)?.evalCollector

    // 1. 工具查找
    const tool = this.toolRegistry.get(name)
    if (!tool) {
      const msg = ContextManagerClass.truncateToolResult(`Tool not found: ${name}`)
      _eval?.recordToolCall(name, true, false)
      return { output: msg, isError: true }
    }

    // 2. Plan mode 检查
    const planModeRejection = this.permissionManager.getPlanModeRejection(name)
    if (planModeRejection) {
      const truncated = ContextManagerClass.truncateToolResult(planModeRejection)
      _eval?.recordToolCall(name, true, false)
      return { output: planModeRejection, isError: true }
    }

    // 3. 权限审批
    if (this.permissionManager.needsApproval(name, input)) {
      let approved = false
      // DesktopToolExecutor 需要通过 sender 请求权限
      // 但 sender 是 IEventSender 而不是 Electron.WebContents
      // PermissionManager.requestApproval 需要 WebContents
      // 所以我们通过注入的原始 sender 回调处理
      if (this._rawSender) {
        approved = await this.permissionManager.requestApproval(
          this.config.conversationId,
          name,
          input,
          this._rawSender,
        )
      }
      if (!approved) {
        await this.hookRegistry?.emit('permission-denied', {
          toolName: name,
          toolInput: input,
          conversationId: this.config.conversationId,
        })
        const msg = `Permission denied for tool: ${name}`
        _eval?.recordToolCall(name, true, false)
        return { output: msg, isError: true }
      }
    }

    // 4. 执行工具
    let toolSpan: ReturnType<ReturnType<typeof getActiveTrace>['startToolSpan']> | undefined
    try {
      await this.hookRegistry?.emit('pre-tool', {
        toolName: name,
        toolInput: input,
        conversationId: this.config.conversationId,
      })

      // 文件快照（写入前）
      if (this.historyManager && tool.requiresSnapshot) {
        const rawPath = input.file_path != null
          ? String(input.file_path)
          : String(input.path ?? '')
        if (rawPath) {
          const absolutePath = path.isAbsolute(rawPath)
            ? rawPath
            : path.resolve(this.config.workingDirectory, rawPath)
          await this.historyManager.snapshot(absolutePath, name)
        }
      }

      toolSpan = getActiveTrace(this.config.conversationId)?.startToolSpan(name, input)
      const result = await tool.execute(input, {
        workingDirectory: context.workingDirectory,
        workspaceId: context.workspaceId,
        projectRoots: context.projectRoots,
        abortSignal: context.abortSignal,
        langfuseParentSpan: context.langfuseParentSpan ?? toolSpan,
        onSubAgentEvent: context.onSubAgentEvent,
      })

      // 展平输出
      const rawOutput = flattenToolOutput(result.output)
      const flatOutput = rawOutput.trim() === ''
        ? `(${name} completed with no output)`
        : rawOutput
      const truncatedOutput = truncateToolResult(name, flatOutput, undefined, tool.maxResultSizeChars)

      toolSpan?.update({
        output: truncatedOutput.slice(0, 1000),
        level: result.isError ? 'ERROR' : 'DEFAULT',
      })
      toolSpan?.end()

      await this.hookRegistry?.emit('post-tool', {
        toolName: name,
        toolInput: input,
        toolOutput: truncatedOutput,
        isError: result.isError,
        conversationId: this.config.conversationId,
      })

      _eval?.recordToolCall(name, result.isError, false)

      // 持久化检查：超大工具结果写入磁盘
      const persistedRef = await maybePersistLargeToolResult(
        name,
        name, // 使用工具名作为 toolCallId 的替代
        flatOutput,
        this.config.conversationId,
      )
      const finalOutput = persistedRef ?? truncatedOutput

      return { output: finalOutput, isError: result.isError }
    } catch (err) {
      const msg = ContextManagerClass.truncateToolResult(
        err instanceof Error ? err.message : String(err),
      )
      toolSpan?.update({
        output: msg.slice(0, 1000),
        level: 'ERROR',
        statusMessage: err instanceof Error ? err.message : String(err),
      })
      toolSpan?.end()
      _eval?.recordToolCall(name, true, false)
      return { output: msg, isError: true }
    }
  }

  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.toolRegistry.getDefinitions().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  isReadOnly(toolName: string): boolean {
    return this.toolRegistry.isReadOnly(toolName)
  }

  // 用于存储原始 Electron.WebContents 引用（权限审批需要）
  private _rawSender?: Electron.WebContents

  /** 设置原始 WebContents 引用（权限审批需要 Electron.WebContents） */
  setRawSender(sender: Electron.WebContents): void {
    this._rawSender = sender
  }
}

// ============================================================
// DesktopStreamProvider — 适配 LLMGateway 为 IStreamProvider
// ============================================================

export class DesktopStreamProvider implements IStreamProvider {
  constructor(private gateway: import('./llm/gateway').LLMGateway) {}

  async *stream(options: IStreamOptions): AsyncGenerator<StreamEvent> {
    // IStreamOptions -> LLMGateway 的 StreamOptions 格式转换
    yield* this.gateway.stream({
      model: options.model,
      messages: options.messages as Array<{
        role: string
        content: unknown
      }>,
      systemPrompt: options.systemPrompt,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      tools: options.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
      fallbackModel: options.fallbackModel,
      thinkingDepth: options.thinkingDepth,
    })
  }
}

// ============================================================
// DesktopPermissionAdapter — 适配 PermissionManager 为 IPermissionManager
// ============================================================

export class DesktopPermissionAdapter implements IPermissionManager {
  constructor(private pm: PermissionManager) {}

  needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean {
    return this.pm.needsApproval(toolName, toolInput)
  }

  async requestApproval(conversationId: string, toolName: string, toolInput: Record<string, unknown>): Promise<boolean> {
    // 注意：IPermissionManager.requestApproval 不接受 sender
    // DesktopToolExecutor 中单独处理权限审批（通过 _rawSender）
    return true
  }

  getPlanModeRejection(toolName: string): string | null {
    return this.pm.getPlanModeRejection(toolName)
  }
}

// ============================================================
// DesktopHookRegistry — 适配 HookRegistry 为 IHookRegistry
// ============================================================

export class DesktopHookRegistry implements IHookRegistry {
  constructor(private registry: HookRegistry) {}

  async emit(event: string, context: Record<string, unknown>): Promise<IHookResult | void> {
    return this.registry.emit(event as import('./hooks/hook-registry').HookEvent, context)
  }
}
