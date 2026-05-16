// ============================================================
// HookRegistry — 钩子注册表
//
// 管理 pre/post tool、session lifecycle、error、compact 等事件的钩子。
// 支持 priority 排序、timeout 超时、结果聚合。
// 纯 TypeScript，无 Electron 依赖。
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
  turnInfo?: {
    turnIndex: number
    toolCalls: string[]
    hadWrite: boolean
    outputTokens: number
  }
}

export interface HookResult {
  preventContinuation?: boolean
  blockingError?: string
}

export interface Hook {
  id: string
  event: HookEvent
  handler: (ctx: HookContext) => Promise<HookResult | void>
  priority: number
  timeout: number
}

const DEFAULT_TIMEOUT = 15000

const EMPTY_RESULT: HookResult = {}

export class HookRegistry {
  private hooks: Map<HookEvent, Hook[]> = new Map()

  register(hook: Omit<Hook, 'priority' | 'timeout'> & { priority?: number; timeout?: number }): void {
    const fullHook: Hook = {
      ...hook,
      priority: hook.priority ?? 100,
      timeout: hook.timeout ?? DEFAULT_TIMEOUT,
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
   */
  async emit(event: HookEvent, context: Omit<HookContext, 'event' | 'timestamp'>): Promise<HookResult> {
    const hooks = this.hooks.get(event) ?? []
    const ctx: HookContext = {
      ...context,
      event,
      timestamp: Date.now(),
    }

    let aggregated: HookResult = {}

    for (const hook of hooks) {
      try {
        const result = await Promise.race([
          hook.handler(ctx),
          new Promise<HookResult>((_, reject) =>
            setTimeout(() => reject(new Error(`Hook "${hook.id}" timed out after ${hook.timeout}ms`)), hook.timeout),
          ),
        ]) ?? EMPTY_RESULT

        if (result.preventContinuation) {
          aggregated.preventContinuation = true
        }
        if (result.blockingError && !aggregated.blockingError) {
          aggregated.blockingError = result.blockingError
        }
      } catch (err) {
        console.warn(`[HookRegistry] Hook "${hook.id}" failed:`, err)
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
