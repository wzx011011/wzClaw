// ============================================================
// Plugin Hooks Bridge — load plugin hooks.json into HookRegistry
// Converts plugin hook definitions into registered Hook instances
// Modeled after Claude Code's hook loading flow
// ============================================================

import type { HookRegistry, HookEvent, HookResult } from '../hooks/hook-registry'
import type { LoadedPlugin } from '../../shared/types-plugin'
import { existsSync, readFileSync } from 'fs'
import { join, basename, isAbsolute } from 'path'

// 允许的 hook 命令白名单（只允许常用开发工具）
const ALLOWED_HOOK_COMMANDS = new Set([
  'git', 'node', 'npx', 'npm', 'pnpm', 'yarn',
  'python', 'python3', 'pip',
  'bash', 'sh', 'cmd', 'powershell',
  'echo', 'cat', 'ls', 'grep', 'sed', 'awk',
  'curl', 'wget', 'docker',
])
import { execFile } from 'child_process'

/**
 * Plugin hook definition from hooks.json.
 * Supports command-based hooks (shell commands) and handler-based hooks (built-in).
 */
interface PluginHookDef {
  /** Which event to listen to */
  event: string
  /** Shell command to execute */
  command?: string
  /** Command arguments */
  args?: string[]
  /** Working directory for command */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Timeout in ms (default: 15000) */
  timeout?: number
  /** Priority (lower = runs first, default: 100) */
  priority?: number
  /** Whether to pass context as JSON via stdin (default: true) */
  stdin?: boolean
}

/**
 * Parsed hooks.json structure.
 * Can be:
 * - Array of hook definitions
 * - Object with event names as keys and hook definitions as values
 * - Object with "hooks" property containing the above
 */
interface PluginHooksConfig {
  hooks?: PluginHookDef[] | Record<string, PluginHookDef | PluginHookDef[]>
  [key: string]: unknown
}

/**
 * Map of plugin hook event names to HookEvent types.
 */
const EVENT_MAP: Record<string, HookEvent> = {
  'pre-tool': 'pre-tool',
  'post-tool': 'post-tool',
  'session-start': 'session-start',
  'session-end': 'session-end',
  'error': 'error',
  'pre-compact': 'pre-compact',
  'post-compact': 'post-compact',
  'permission-denied': 'permission-denied',
  'turn-end': 'turn-end',
}

/**
 * Load hooks from a plugin and register them with the HookRegistry.
 *
 * @returns Array of registered hook IDs (for later cleanup)
 */
export function loadPluginHooks(
  plugin: LoadedPlugin,
  hookRegistry: HookRegistry,
): string[] {
  const registeredIds: string[] = []
  const hookDefs = collectHookDefs(plugin)
  const pluginName = plugin.name

  for (const def of hookDefs) {
    const hookEvent = EVENT_MAP[def.event]
    if (!hookEvent) {
      console.warn(`[plugin-hooks] Unknown event "${def.event}" in plugin "${pluginName}", skipping`)
      continue
    }

    if (!def.command) {
      console.warn(`[plugin-hooks] Hook in plugin "${pluginName}" has no command, skipping`)
      continue
    }

    const hookId = `plugin:${pluginName}:${def.event}:${def.command.slice(0, 30)}`
    const cwd = def.cwd ?? plugin.path

    hookRegistry.register({
      id: hookId,
      event: hookEvent,
      handler: createCommandHandler(def.command, def.args ?? [], cwd, def.env, def.stdin ?? true, def.timeout),
      priority: def.priority ?? 100,
      timeout: def.timeout ?? 15000,
    })

    registeredIds.push(hookId)
  }

  if (registeredIds.length > 0) {
    console.log(`[plugin-hooks] Registered ${registeredIds.length} hooks for plugin "${pluginName}"`)
  }

  return registeredIds
}

/**
 * Unregister all hooks for a plugin.
 */
export function unloadPluginHooks(
  pluginName: string,
  hookRegistry: HookRegistry,
  registeredIds: string[],
): void {
  for (const id of registeredIds) {
    hookRegistry.unregister(id)
  }
  if (registeredIds.length > 0) {
    console.log(`[plugin-hooks] Unregistered ${registeredIds.length} hooks for plugin "${pluginName}"`)
  }
}

/**
 * Collect all hook definitions from a plugin.
 * Reads from hooksConfig (already parsed) or hooks/hooks.json on disk.
 */
function collectHookDefs(plugin: LoadedPlugin): PluginHookDef[] {
  const defs: PluginHookDef[] = []
  let config: PluginHooksConfig | undefined

  // 1. Try already-loaded hooksConfig
  if (plugin.hooksConfig && typeof plugin.hooksConfig === 'object') {
    config = plugin.hooksConfig as PluginHooksConfig
  } else {
    // 2. Try hooks/hooks.json on disk
    const hooksPath = join(plugin.path, 'hooks', 'hooks.json')
    if (existsSync(hooksPath)) {
      try {
        config = JSON.parse(readFileSync(hooksPath, 'utf-8'))
      } catch (err) {
        console.warn(`[plugin-hooks] Failed to parse hooks.json for "${plugin.name}":`, err)
        return defs
      }
    }
  }

  if (!config) return defs

  // Parse the config structure
  const rawHooks = config.hooks ?? config

  if (Array.isArray(rawHooks)) {
    defs.push(...rawHooks)
  } else if (typeof rawHooks === 'object') {
    // Record<string, HookDef | HookDef[]>
    for (const [key, value] of Object.entries(rawHooks)) {
      if (Array.isArray(value)) {
        defs.push(...value.map(v => ({ event: key, ...v })))
      } else if (typeof value === 'object' && value !== null) {
        defs.push({ event: key, ...value as PluginHookDef })
      }
    }
  }

  return defs
}

/**
 * Create a hook handler that executes a shell command.
 * Context is passed as JSON via stdin, and the command's stdout is parsed as HookResult.
 */
function createCommandHandler(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  useStdin?: boolean,
  timeout?: number,
): (ctx: import('../hooks/hook-registry').HookContext) => Promise<HookResult> {
  return async (ctx) => {
    // 安全检查：只允许白名单命令或绝对路径
    const base = basename(command)
    if (!ALLOWED_HOOK_COMMANDS.has(base) && !isAbsolute(command)) {
      console.warn(`[plugin-hooks] Blocked disallowed command: ${command}`)
      return {}
    }

    return new Promise<HookResult>((resolve) => {
      const childEnv = { ...process.env, ...env }
      const child = execFile(command, args, {
        cwd,
        env: childEnv,
        timeout: timeout ?? 15000,
        maxBuffer: 1024 * 1024, // 1MB
      }, (error, stdout, stderr) => {
        if (error) {
          console.warn(`[plugin-hooks] Command "${command}" failed:`, error.message)
          if (stderr) console.warn(`[plugin-hooks] stderr:`, stderr.slice(0, 500))
          resolve({})
          return
        }

        // Parse stdout as HookResult
        const output = stdout.trim()
        if (!output) {
          resolve({})
          return
        }

        try {
          const parsed = JSON.parse(output)
          resolve({
            preventContinuation: parsed.preventContinuation === true,
            blockingError: typeof parsed.blockingError === 'string' ? parsed.blockingError : undefined,
          })
        } catch {
          // Non-JSON output — treat as no-op
          resolve({})
        }
      })

      // Pass context as JSON via stdin
      if (useStdin !== false && child.stdin) {
        const contextJson = JSON.stringify({
          event: ctx.event,
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          toolOutput: ctx.toolOutput,
          isError: ctx.isError,
          conversationId: ctx.conversationId,
          timestamp: ctx.timestamp,
        })
        child.stdin.write(contextJson)
        child.stdin.end()
      } else if (child.stdin) {
        child.stdin.end()
      }
    })
  }
}
