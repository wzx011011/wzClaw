// ============================================================
// Built-in Hooks — Logging and metrics hooks
// ============================================================

import type { HookRegistry } from './hook-registry'

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
}
