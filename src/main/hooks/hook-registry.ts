// ============================================================
// Hook Registry — Pre/post tool execution and session lifecycle hooks
// ============================================================

export type HookEvent = 'pre-tool' | 'post-tool' | 'session-start' | 'session-end' | 'error' | 'pre-compact' | 'post-compact' | 'permission-denied'

export interface HookContext {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  conversationId?: string
  error?: Error | string
  timestamp: number
}

export interface Hook {
  id: string
  event: HookEvent
  handler: (ctx: HookContext) => Promise<void>
  priority: number // lower = runs first
  timeout: number  // ms
}

const DEFAULT_TIMEOUT = 15000

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

  async emit(event: HookEvent, context: Omit<HookContext, 'event' | 'timestamp'>): Promise<void> {
    const hooks = this.hooks.get(event) ?? []
    const ctx: HookContext = {
      ...context,
      event,
      timestamp: Date.now()
    }

    for (const hook of hooks) {
      try {
        await Promise.race([
          hook.handler(ctx),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Hook "${hook.id}" timed out after ${hook.timeout}ms`)), hook.timeout)
          )
        ])
      } catch (err) {
        console.warn(`[HookRegistry] Hook "${hook.id}" failed:`, err)
        // Hooks should not block the main flow
      }
    }
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
