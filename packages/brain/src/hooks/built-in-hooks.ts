// ============================================================
// Built-in Hooks — Logging, metrics, stagnation detection
//
// 注册日志、计时、停滞检测等内置钩子。
// 纯 TypeScript，无 Electron 依赖。
// ============================================================

import type { HookContext, HookRegistry, HookResult } from './hook-registry.js'

const STAGNATION_WINDOW = 6
const STAGNATION_MIN_TURNS = 3

/**
 * 创建停滞检测 hook：连续 N 轮只读不写 → 注入提醒/终止
 */
function createStagnationHook(): (ctx: HookContext) => Promise<HookResult> {
  const history: boolean[] = []
  let stagnationCount = 0
  const MAX_STAGNATION_WARNINGS = 3

  return async (ctx) => {
    const hadWrite = ctx.turnInfo?.hadWrite ?? false
    history.push(hadWrite)

    if (history.length > STAGNATION_WINDOW) {
      history.shift()
    }

    if (history.length < STAGNATION_MIN_TURNS) return {}

    if (history.length >= STAGNATION_WINDOW && history.every((h) => !h)) {
      history.length = 0
      stagnationCount++

      if (stagnationCount > MAX_STAGNATION_WARNINGS) {
        return {
          preventContinuation: true,
          blockingError: `已连续 ${stagnationCount} 次检测到停滞，强制终止。`,
        }
      }

      return {
        blockingError: `你已连续 ${STAGNATION_WINDOW} 轮只读不写。请采取行动或向用户确认方向。（${stagnationCount}/${MAX_STAGNATION_WARNINGS}）`,
      }
    }

    if (hadWrite && stagnationCount > 0) {
      stagnationCount = 0
    }

    return {}
  }
}

/** 注册所有内置钩子到 registry */
export function registerBuiltInHooks(registry: HookRegistry): void {
  // Tool logging
  registry.register({
    id: 'builtin:tool-logger',
    event: 'pre-tool',
    handler: async (ctx) => {
      console.log(`[Hook] Tool start: ${ctx.toolName}`, ctx.toolInput ? Object.keys(ctx.toolInput) : [])
    },
    priority: 10,
  })

  registry.register({
    id: 'builtin:tool-result-logger',
    event: 'post-tool',
    handler: async (ctx) => {
      const status = ctx.isError ? 'ERROR' : 'OK'
      const outputPreview = ctx.toolOutput?.substring(0, 100) ?? ''
      console.log(`[Hook] Tool done: ${ctx.toolName} [${status}] ${outputPreview}`)
    },
    priority: 10,
  })

  // Metrics timing
  const toolTimings = new Map<string, number>()

  registry.register({
    id: 'builtin:metrics-start',
    event: 'pre-tool',
    handler: async (ctx) => {
      if (ctx.toolName) {
        toolTimings.set(ctx.toolName, ctx.timestamp)
      }
    },
    priority: 5,
  })

  registry.register({
    id: 'builtin:metrics-end',
    event: 'post-tool',
    handler: async (ctx) => {
      if (ctx.toolName) {
        const start = toolTimings.get(ctx.toolName)
        if (start) {
          const duration = ctx.timestamp - start
          console.log(`[Metrics] ${ctx.toolName}: ${duration}ms`)
          toolTimings.delete(ctx.toolName)
        }
      }
    },
    priority: 5,
  })

  // Session lifecycle
  registry.register({
    id: 'builtin:session-start',
    event: 'session-start',
    handler: async (ctx) => {
      console.log(`[Hook] Session started: ${ctx.conversationId}`)
    },
    priority: 10,
  })

  registry.register({
    id: 'builtin:session-end',
    event: 'session-end',
    handler: async (ctx) => {
      console.log(`[Hook] Session ended: ${ctx.conversationId}`)
    },
    priority: 10,
  })

  // Error logging
  registry.register({
    id: 'builtin:error-logger',
    event: 'error',
    handler: async (ctx) => {
      console.error(`[Hook] Error in conversation ${ctx.conversationId}:`, ctx.error)
    },
    priority: 1,
  })

  // Compaction lifecycle
  registry.register({
    id: 'builtin:pre-compact',
    event: 'pre-compact',
    handler: async (ctx) => {
      console.log(`[Hook] Context compaction starting: ${ctx.conversationId}`)
    },
    priority: 10,
  })

  registry.register({
    id: 'builtin:post-compact',
    event: 'post-compact',
    handler: async (ctx) => {
      console.log(`[Hook] Context compaction complete: ${ctx.conversationId}`)
    },
    priority: 10,
  })

  // Permission-denied logging
  registry.register({
    id: 'builtin:permission-denied',
    event: 'permission-denied',
    handler: async (ctx) => {
      console.warn(`[Hook] Permission denied for "${ctx.toolName}" in ${ctx.conversationId}`)
    },
    priority: 10,
  })

  // Stagnation detection
  registry.register({
    id: 'builtin:stagnation-detect',
    event: 'turn-end',
    handler: createStagnationHook(),
    priority: 100,
  })
}
