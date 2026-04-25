// ============================================================
// Built-in Hooks — Logging, metrics, and stop hooks
// v2: 新增 stagnation stop hook（连续只读不写 → 注入提醒）
// ============================================================

import type { HookRegistry, HookResult } from './hook-registry'

/** 写操作工具名称集合 */
const WRITE_TOOLS = new Set(['FileWrite', 'FileEdit', 'Bash'])

/** 停滞检测窗口和阈值 */
const STAGNATION_WINDOW = 6
const STAGNATION_MIN_TURNS = 3

/**
 * 创建停滞检测 stop hook 的状态追踪器。
 * 返回一个 turn-end hook handler。
 */
function createStagnationHook(): (ctx: any) => Promise<HookResult> {
  const history: boolean[] = []  // true = 有写操作

  return async (ctx) => {
    const hadWrite = ctx.turnInfo?.hadWrite ?? false
    history.push(hadWrite)

    // 保留窗口大小的历史
    if (history.length > STAGNATION_WINDOW) {
      history.shift()
    }

    // 需要至少 MIN_TURNS 轮才判定
    if (history.length < STAGNATION_MIN_TURNS) return {}

    // 连续 N 轮无写操作 → 停滞
    if (history.length >= STAGNATION_WINDOW && history.every(h => !h)) {
      history.length = 0  // 重置，避免反复触发
      return {
        blockingError: `你已连续 ${STAGNATION_WINDOW} 轮只读不写。请采取行动（修改文件、执行命令）或向用户确认方向是否正确。`,
      }
    }

    return {}
  }
}

/**
 * Register built-in hooks for logging and metrics.
 */
export function registerBuiltInHooks(registry: HookRegistry): void {
  // Logging hook — logs all tool executions
  registry.register({
    id: 'builtin:tool-logger',
    event: 'pre-tool',
    handler: async (ctx) => {
      console.log(`[Hook] Tool start: ${ctx.toolName}`, ctx.toolInput ? Object.keys(ctx.toolInput) : [])
    },
    priority: 10
  })

  registry.register({
    id: 'builtin:tool-result-logger',
    event: 'post-tool',
    handler: async (ctx) => {
      const status = ctx.isError ? 'ERROR' : 'OK'
      const outputPreview = ctx.toolOutput?.substring(0, 100) ?? ''
      console.log(`[Hook] Tool done: ${ctx.toolName} [${status}] ${outputPreview}`)
    },
    priority: 10
  })

  // Metrics hook — tracks tool execution timing
  const toolTimings = new Map<string, number>()

  registry.register({
    id: 'builtin:metrics-start',
    event: 'pre-tool',
    handler: async (ctx) => {
      if (ctx.toolName) {
        toolTimings.set(ctx.toolName, ctx.timestamp)
      }
    },
    priority: 5
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
    priority: 5
  })

  // Session lifecycle logging
  registry.register({
    id: 'builtin:session-start',
    event: 'session-start',
    handler: async (ctx) => {
      console.log(`[Hook] Session started: ${ctx.conversationId}`)
    },
    priority: 10
  })

  registry.register({
    id: 'builtin:session-end',
    event: 'session-end',
    handler: async (ctx) => {
      console.log(`[Hook] Session ended: ${ctx.conversationId}`)
    },
    priority: 10
  })

  // Error logging
  registry.register({
    id: 'builtin:error-logger',
    event: 'error',
    handler: async (ctx) => {
      console.error(`[Hook] Error in conversation ${ctx.conversationId}:`, ctx.error)
    },
    priority: 1
  })

  // Compaction lifecycle logging
  registry.register({
    id: 'builtin:pre-compact',
    event: 'pre-compact',
    handler: async (ctx) => {
      console.log(`[Hook] Context compaction starting: ${ctx.conversationId}`)
    },
    priority: 10
  })

  registry.register({
    id: 'builtin:post-compact',
    event: 'post-compact',
    handler: async (ctx) => {
      console.log(`[Hook] Context compaction complete: ${ctx.conversationId}`)
    },
    priority: 10
  })

  // Permission-denied logging
  registry.register({
    id: 'builtin:permission-denied',
    event: 'permission-denied',
    handler: async (ctx) => {
      console.warn(`[Hook] Permission denied for tool "${ctx.toolName}" in conversation ${ctx.conversationId}`)
    },
    priority: 10
  })

  // ---- Stop Hook: 停滞检测 ----
  // 连续 N 轮只读不写 → 注入 blockingError 提醒 agent 采取行动
  registry.register({
    id: 'builtin:stagnation-detect',
    event: 'turn-end',
    handler: createStagnationHook(),
    priority: 100,  // 低优先级，在其他 turn-end hook 之后运行
  })
}
