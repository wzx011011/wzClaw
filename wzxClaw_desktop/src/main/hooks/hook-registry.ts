// ============================================================
// Hook Registry — Pre/post tool execution and session lifecycle hooks
// v2: emit() 返回 HookResult，支持 stop hooks 影响循环行为
// ============================================================

export type HookEvent = 'pre-tool' | 'post-tool' | 'session-start' | 'session-end' | 'error' | 'pre-compact' | 'post-compact' | 'permission-denied' | 'turn-end'

export interface HookContext {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  conversationId?: string
  error?: Error | string
  timestamp: number
  /** turn-end 事件的上下文 */
  turnInfo?: {
    turnIndex: number
    toolCalls: string[]  // 本轮调用的工具名列表
    hadWrite: boolean    // 本轮是否有写操作
    outputTokens: number
  }
}

/** Hook 返回结果 — 可影响 agent 循环行为 */
export interface HookResult {
  /** 为 true 则阻止 agent 继续循环（直接终止） */
  preventContinuation?: boolean
  /** 非空则注入为 user message，循环继续（给 LLM 提醒/纠正） */
  blockingError?: string
}

export interface Hook {
  id: string
  event: HookEvent
  handler: (ctx: HookContext) => Promise<HookResult | void>
  priority: number // lower = runs first
  timeout: number  // ms
}

const DEFAULT_TIMEOUT = 15000

const EMPTY_RESULT: HookResult = {}

export class HookRegistry {
  private hooks: Map<HookEvent, Hook[]> = new Map()

  register(hook: Omit<Hook, 'priority' | 'timeout'> & { priority?: number; timeout?: number }): void {
    const fullHook: Hook = {
      ...hook,
      priority: hook.priority ?? 100,
      timeout: hook.timeout ?? DEFAULT_TIMEOUT
    }

    const list = this.hooks.get(hook.event) ?? []
    list.push(fullHook)
    list.sort((a, b) => a.priority - b.priority)
    this.hooks.set(hook.event, list)
  }

  unregister(hookId: string): void {
    for (const [event, list] of this.hooks) {
      const filtered = list.filter((h) => h.id !== hookId)
      if (filtered.length !== list.length) {
        this.hooks.set(event, filtered)
      }
    }
  }

  /**
   * 触发事件并聚合所有 hook 结果。
   * 任一 hook 返回 preventContinuation=true 则整体阻止继续。
   * 任一 hook 返回 blockingError 则注入为 user message。
   */
  async emit(event: HookEvent, context: Omit<HookContext, 'event' | 'timestamp'>): Promise<HookResult> {
    const hooks = this.hooks.get(event) ?? []
    const ctx: HookContext = {
      ...context,
      event,
      timestamp: Date.now()
    }

    let aggregated: HookResult = {}

    for (const hook of hooks) {
      try {
        const result = await Promise.race([
          hook.handler(ctx),
          new Promise<HookResult>((_, reject) =>
            setTimeout(() => reject(new Error(`Hook "${hook.id}" timed out after ${hook.timeout}ms`)), hook.timeout)
          )
        ]) ?? EMPTY_RESULT

        // 聚合结果
        if (result.preventContinuation) {
          aggregated.preventContinuation = true
        }
        if (result.blockingError && !aggregated.blockingError) {
          aggregated.blockingError = result.blockingError
        }
      } catch (err) {
        console.warn(`[HookRegistry] Hook "${hook.id}" failed:`, err)
        // Hooks should not block the main flow
      }
    }

    return aggregated
  }

  clear(): void {
    this.hooks.clear()
  }

  getHooks(event?: HookEvent): Hook[] {
    if (event) return this.hooks.get(event) ?? []
    const all: Hook[] = []
    for (const list of this.hooks.values()) {
      all.push(...list)
    }
    return all
  }
}
