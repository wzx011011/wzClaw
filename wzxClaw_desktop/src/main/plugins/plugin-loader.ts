// ============================================================
// Plugin Loader — load plugins from local directories
// Scans: user plugins dir, project plugins dir, managed path
// 全异步实现，避免阻塞主进程事件循环
// ============================================================

import { promises as fsp } from 'fs'
import { join, basename, dirname } from 'path'
import type { LoadedPlugin, PluginManifest, PluginError, McpServerConfig } from '../../shared/types-plugin'
import { parsePluginManifest, createMinimalManifest, isValidPluginDirectory } from './plugin-manifest'
import { getPluginsDir } from '../paths'

// ============================================================
// Plugin directory resolution
// ============================================================

/** Get the user-level plugins directory */
export function getUserPluginsDir(): string {
  return getPluginsDir()
}

/** Get the project-level plugins directory */
export function getProjectPluginsDir(projectRoot: string): string {
  return join(projectRoot, '.wzxclaw', 'plugins')
}

/** Get managed plugins directory (enterprise) */
export function getManagedPluginsDir(): string | undefined {
  return process.env.WZXCLAW_MANAGED_PLUGINS_DIR || undefined
}

// ============================================================
// Load single plugin from directory
// ============================================================

export interface LoadPluginOptions {
  /** Absolute path to plugin root */
  path: string
  /** Source identifier */
  source: string
  /** Whether to enable by default */
  enabled?: boolean
  /** Whether this is a builtin plugin */
  isBuiltin?: boolean
}

/**
 * 异步加载单个插件。
 */
export async function loadPlugin(options: LoadPluginOptions): Promise<LoadedPlugin | null> {
  const { path: pluginPath, source, enabled = true, isBuiltin = false } = options
  const errors: PluginError[] = []

  // 1. Validate directory exists
  try {
    const stat = await fsp.stat(pluginPath)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }

  // 2. Parse manifest
  const { manifest, errors: parseErrors } = await parsePluginManifest(pluginPath)
  errors.push(...parseErrors)

  // If no manifest and not a valid plugin structure, skip
  const effectiveManifest: PluginManifest = manifest ?? createMinimalManifest(pluginPath)

  // 3. Resolve component paths
  const commandsPath = await resolveComponentPath(pluginPath, 'commands')
  const agentsPath = await resolveComponentPath(pluginPath, 'agents')
  const skillsPath = await resolveComponentPath(pluginPath, 'skills')
  const outputStylesPath = await resolveComponentPath(pluginPath, 'output-styles')

  // 4. Resolve additional paths from manifest
  const commandsPaths = await resolveAdditionalPaths(pluginPath, effectiveManifest.commands)
  const agentsPaths = await resolveAdditionalPaths(pluginPath, effectiveManifest.agents)
  const skillsPaths = await resolveAdditionalPaths(pluginPath, effectiveManifest.skills)

  // 5. Load hooks configuration
  let hooksConfig: unknown = effectiveManifest.hooks
  if (!hooksConfig) {
    const hooksPath = join(pluginPath, 'hooks', 'hooks.json')
    try {
      await fsp.access(hooksPath)
      const raw = await fsp.readFile(hooksPath, 'utf-8')
      hooksConfig = JSON.parse(raw)
    } catch {
      // hooks.json 不存在或无法读取 — 跳过
    }
    if (!hooksConfig) {
      // 尝试读取失败时记录错误
    }
  }

  // 6. Load MCP server configs
  let mcpServers: Record<string, McpServerConfig> | undefined = { ...effectiveManifest.mcpServers }
  const mcpJsonPath = join(pluginPath, '.mcp.json')
  try {
    await fsp.access(mcpJsonPath)
    const raw = await fsp.readFile(mcpJsonPath, 'utf-8')
    const mcpConfig = JSON.parse(raw)
    const mcpServersFromJson = mcpConfig?.mcpServers ?? mcpConfig
    if (typeof mcpServersFromJson === 'object') {
      mcpServers = { ...mcpServers, ...mcpServersFromJson }
    }
  } catch {
    // .mcp.json 不存在或无法读取 — 跳过
  }
  // Clean up empty mcpServers
  if (mcpServers && Object.keys(mcpServers).length === 0) {
    mcpServers = undefined
  }

  // 7. Build LoadedPlugin
  const plugin: LoadedPlugin = {
    name: effectiveManifest.name,
    manifest: effectiveManifest,
    path: pluginPath,
    source,
    enabled,
    isBuiltin,
    version: effectiveManifest.version,
    commandsPath: commandsPath ?? undefined,
    commandsPaths: commandsPaths.length > 0 ? commandsPaths : undefined,
    agentsPath: agentsPath ?? undefined,
    agentsPaths: agentsPaths.length > 0 ? agentsPaths : undefined,
    skillsPath: skillsPath ?? undefined,
    skillsPaths: skillsPaths.length > 0 ? skillsPaths : undefined,
    outputStylesPath: outputStylesPath ?? undefined,
    hooksConfig,
    mcpServers,
    errors: errors.length > 0 ? errors : undefined,
  }

  return plugin
}

// ============================================================
// Scan directories for plugins
// ============================================================

export interface ScanPluginsOptions {
  /** Working directory */
  cwd: string
  /** Additional project roots */
  projectRoots?: string[]
}

/**
 * 异步扫描所有插件来源。
 */
export async function scanAllPlugins(options: ScanPluginsOptions): Promise<LoadedPlugin[]> {
  const { cwd, projectRoots = [] } = options
  const plugins: LoadedPlugin[] = []
  const seenNames = new Set<string>()

  // Collect all directories to scan
  const scanDirs: Array<{ dir: string; source: string; isBuiltin?: boolean }> = []

  // 1. Managed path
  const managedDir = getManagedPluginsDir()
  if (managedDir) {
    scanDirs.push({ dir: managedDir, source: 'managed' })
  }

  // 2. User plugins
  scanDirs.push({ dir: getUserPluginsDir(), source: 'user' })

  // 3. Project plugins (walk up from cwd)
  const projectDirs = getProjectDirsUpToHome(cwd)
  for (const dir of projectDirs) {
    scanDirs.push({ dir, source: 'project' })
  }

  // 4. Additional project roots
  for (const root of projectRoots) {
    const rootDirs = getProjectDirsUpToHome(root)
    for (const dir of rootDirs) {
      scanDirs.push({ dir, source: 'project' })
    }
  }

  // Scan each directory
  for (const { dir, source } of scanDirs) {
    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry)

      // Only directories
      let stat: { isDirectory(): boolean; isSymbolicLink(): boolean }
      try {
        stat = await fsp.stat(entryPath)
      } catch {
        continue
      }
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue

      // Skip if already loaded (first source wins)
      if (seenNames.has(entry)) continue

      // Validate plugin structure
      if (!(await isValidPluginDirectory(entryPath))) continue

      // Load plugin
      const plugin = await loadPlugin({ path: entryPath, source })
      if (plugin) {
        seenNames.add(plugin.name)
        plugins.push(plugin)
      }
    }
  }

  console.log(`[plugins] Scanned ${plugins.length} plugins from ${scanDirs.length} directories`)
  return plugins
}

// ============================================================
// Helpers
// ============================================================

async function resolveComponentPath(pluginPath: string, component: string): Promise<string | null> {
  const componentPath = join(pluginPath, component)
  try {
    await fsp.access(componentPath)
    return componentPath
  } catch {
    return null
  }
}

/**
 * 异步解析 manifest 中的额外路径。
 */
async function resolveAdditionalPaths(
  pluginPath: string,
  manifestField: string | string[] | Record<string, unknown> | undefined,
): Promise<string[]> {
  if (!manifestField) return []

  const paths: string[] = []

  if (typeof manifestField === 'string') {
    const resolved = join(pluginPath, manifestField)
    try { await fsp.access(resolved); paths.push(resolved) } catch { /* skip */ }
  } else if (Array.isArray(manifestField)) {
    for (const p of manifestField) {
      if (typeof p === 'string') {
        const resolved = join(pluginPath, p)
        try { await fsp.access(resolved); paths.push(resolved) } catch { /* skip */ }
      }
    }
  } else if (typeof manifestField === 'object') {
    for (const [, meta] of Object.entries(manifestField)) {
      if (meta && typeof meta === 'object' && 'source' in meta) {
        const source = (meta as { source?: string }).source
        if (source) {
          const resolved = join(pluginPath, source)
          try { await fsp.access(resolved); paths.push(resolved) } catch { /* skip */ }
        }
      }
    }
  }

  return paths
}

/**
 * Walk from cwd up to home, collecting .wzxclaw/plugins/ paths.
 */
function getProjectDirsUpToHome(cwd: string): string[] {
  const home = require('os').homedir()
  const dirs: string[] = []

  let current = cwd
  while (current) {
    dirs.push(join(current, '.wzxclaw', 'plugins'))
    const parent = dirname(current)
    if (parent === current || parent === home) break
    current = parent
  }

  return dirs
}
