// ============================================================
// Hand 感知工具执行器 — 实现 IToolExecutor 接口
// 将工具调用路由到在线 Hand 执行，聚合所有 Hand 的工具定义
// 超时和断连场景有 fallback 错误返回
// ============================================================

import { randomUUID } from 'node:crypto'
import type { IToolExecutor, IToolExecutionContext, IToolExecutionResult } from '@wzxclaw/brain'
import type { HandsRouter } from './hands-router.js'
import type { ToolDefinition } from './hands-router.js'

/** 默认工具执行超时时间（30s） */
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000

/** pending 调用条目 */
interface PendingCall {
  /** resolve 回调，用于返回执行结果 */
  resolve: (result: IToolExecutionResult) => void
  /** 超时定时器 */
  timer: ReturnType<typeof setTimeout>
  /** 目标 Hand ID（用于断连时清理） */
  handId: string
}

/**
 * Hand 感知工具执行器
 *
 * 实现 IToolExecutor 接口，将工具调用路由到在线 Hand：
 * - getDefinitions() 聚合所有在线 Hand 的工具定义
 * - execute() 查找目标 Hand，通过 WebSocket 发送 hand:execute，等待 hand:result
 * - isReadOnly() 从 Hand 注册的定义中读取
 * - 30s 超时 fallback、Hand 断连 fallback
 */
export class HandAwareToolExecutor implements IToolExecutor {
  /** Hand 路由器实例 */
  private readonly router: HandsRouter

  /** 等待中的工具调用 callId → PendingCall */
  private readonly pendingCalls = new Map<string, PendingCall>()

  /** callId → handId 反向索引，用于按 Hand 清理 */
  private readonly callToHand = new Map<string, string>()

  /** 执行超时时间 */
  private readonly timeoutMs: number

  constructor(router: HandsRouter, timeoutMs: number = DEFAULT_EXECUTE_TIMEOUT_MS) {
    this.router = router
    this.timeoutMs = timeoutMs
  }

  /**
   * 获取所有在线 Hand 的聚合工具定义
   * 委托给 HandsRouter.getAllDefinitions()
   */
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.router.getAllDefinitions()
  }

  /**
   * 执行工具调用
   *
   * 1. 通过 HandsRouter 查找能执行该工具的在线 Hand
   * 2. 生成 callId，通过 Hand 的 WebSocket 发送 hand:execute
   * 3. 等待 handleResult 被调用或超时
   * 4. Hand 断连时通过 handleHandDisconnect 清理
   */
  async execute(name: string, input: Record<string, unknown>, context: IToolExecutionContext): Promise<IToolExecutionResult> {
    // 查找能执行该工具的 Hand
    const hand = this.router.findHand(name)
    if (!hand) {
      return { output: `No hand available for tool: ${name}`, isError: true }
    }

    const callId = randomUUID()

    // 创建 Promise 等待结果
    const resultPromise = new Promise<IToolExecutionResult>((resolve) => {
      // 设置超时定时器
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        this.callToHand.delete(callId)
        resolve({ output: 'Tool execution timed out', isError: true })
      }, this.timeoutMs)

      // 存储 pending 调用
      this.pendingCalls.set(callId, { resolve, timer, handId: hand.id })
      this.callToHand.set(callId, hand.id)
    })

    // 通过 WebSocket 发送 hand:execute 消息
    const message = JSON.stringify({
      event: 'hand:execute',
      data: {
        callId,
        name,
        input,
        context: {
          workingDirectory: context.workingDirectory,
          projectRoots: context.projectRoots,
        },
      },
    })

    hand.ws.send(message)

    return resultPromise
  }

  /**
   * 处理 Hand 返回的工具执行结果
   * 由 server 层在收到 hand:result 消息时调用
   */
  handleResult(callId: string, output: string, isError: boolean): void {
    const pending = this.pendingCalls.get(callId)
    if (!pending) {
      // 未知的 callId，可能已超时或已清理，忽略
      return
    }

    clearTimeout(pending.timer)
    this.pendingCalls.delete(callId)
    this.callToHand.delete(callId)
    pending.resolve({ output, isError })
  }

  /**
   * 处理 Hand 断开连接
   * 清理该 Hand 所有 pending calls，返回断连错误
   */
  handleHandDisconnect(handId: string): void {
    // 遍历所有 pending calls，找到属于该 Hand 的
    for (const [callId, pending] of this.pendingCalls.entries()) {
      if (pending.handId === handId) {
        clearTimeout(pending.timer)
        this.pendingCalls.delete(callId)
        this.callToHand.delete(callId)
        pending.resolve({ output: 'Hand disconnected during execution', isError: true })
      }
    }
  }

  /**
   * 判断工具是否只读
   *
   * 遍历所有 Hand 的 definitions 查找匹配的工具，
   * 返回其 isReadOnly 属性。未找到则返回 false（保守策略）。
   */
  isReadOnly(toolName: string): boolean {
    // 从 router 的所有定义中查找
    const allDefs = this.router.getAllDefinitions()
    const def = allDefs.find(d => d.name === toolName)
    if (def) {
      return (def as ToolDefinition).isReadOnly ?? false
    }
    // 未知工具，保守返回 false
    return false
  }
}
