// ============================================================
// Plugin Loader — load plugins from local directories
// Scans: user plugins dir, project plugins dir, managed path
// Modeled after Claude Code's pluginLoader.ts
// ============================================================

import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, basename } from 'path'
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
 * Load a single plugin from a directory.
 *
 * Resolution order for manifest:
 * 1. plugin.json (strict) — full manifest with metadata
 * 2. Directory scan (non-strict) — minimal manifest from directory name
 *
 * Component resolution:
 * - commands/ → plugin commands (.md files)
 * - skills/ → plugin skills (SKILL.md directories)
 * - agents/ → plugin agents (.md files)
 * - hooks/hooks.json → lifecycle hooks
 * - .mcp.json → MCP server configs
 */
export function loadPlugin(options: LoadPluginOptions): LoadedPlugin | null {
  const { path: pluginPath, source, enabled = true, isBuiltin = false } = options
  const errors: PluginError[] = []

  // 1. Validate directory exists
  if (!existsSync(pluginPath)) {
    return null
  }

  // 2. Parse manifest
  const { manifest, errors: parseErrors } = parsePluginManifest(pluginPath)
  errors.push(...parseErrors)

  // If no manifest and not a valid plugin structure, skip
  const effectiveManifest: PluginManifest = manifest ?? createMinimalManifest(pluginPath)

  // 3. Resolve component paths
  const commandsPath = resolveComponentPath(pluginPath, 'commands')
  const agentsPath = resolveComponentPath(pluginPath, 'agents')
  const skillsPath = resolveComponentPath(pluginPath, 'skills')
  const outputStylesPath = resolveComponentPath(pluginPath, 'output-styles')

  // 4. Resolve additional paths from manifest
  const commandsPaths = resolveAdditionalPaths(pluginPath, effectiveManifest.commands)
  const agentsPaths = resolveAdditionalPaths(pluginPath, effectiveManifest.agents)
  const skillsPaths = resolveAdditionalPaths(pluginPath, effectiveManifest.skills)

  // 5. Load hooks configuration
  let hooksConfig: unknown = effectiveManifest.hooks
  if (!hooksConfig) {
    const hooksPath = join(pluginPath, 'hooks', 'hooks.json')
    if (existsSync(hooksPath)) {
      try {
        hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'))
      } catch (err) {
        errors.push({
          type: 'component-load-error',
          component: 'hooks',
          message: `Failed to parse hooks.json: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // 6. Load MCP server configs
  let mcpServers: Record<string, McpServerConfig> | undefined = { ...effectiveManifest.mcpServers }
  const mcpJsonPath = join(pluginPath, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
      const mcpServersFromJson = mcpConfig?.mcpServers ?? mcpConfig
      if (typeof mcpServersFromJson === 'object') {
        mcpServers = { ...mcpServers, ...mcpServersFromJson }
      }
    } catch (err) {
      errors.push({
        type: 'component-load-error',
        component: 'hooks' as any,
        message: `Failed to parse .mcp.json: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
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
 * Scan all plugin sources and return loaded plugins.
 *
 * Scan order (by directory):
 * 1. Managed plugins (enterprise path)
 * 2. User plugins (~/.wzxclaw/plugins/)
 * 3. Project plugins (.wzxclaw/plugins/ from cwd up to home)
 */
export function scanAllPlugins(options: ScanPluginsOptions): LoadedPlugin[] {
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
    if (!existsSync(dir)) continue

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry)

      // Only directories
      let stat: { isDirectory(): boolean; isSymbolicLink(): boolean }
      try {
        stat = statSync(entryPath)
      } catch {
        continue
      }
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue

      // Skip if already loaded (first source wins)
      if (seenNames.has(entry)) continue

      // Validate plugin structure
      if (!isValidPluginDirectory(entryPath)) continue

      // Load plugin
      const plugin = loadPlugin({ path: entryPath, source })
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

function resolveComponentPath(pluginPath: string, component: string): string | null {
  const componentPath = join(pluginPath, component)
  return existsSync(componentPath) ? componentPath : null
}

/**
 * Resolve additional paths from manifest fields.
 * Handles string, string[], and Record<string, CommandMetadata> formats.
 */
function resolveAdditionalPaths(
  pluginPath: string,
  manifestField: string | string[] | Record<string, unknown> | undefined,
): string[] {
  if (!manifestField) return []

  const paths: string[] = []

  if (typeof manifestField === 'string') {
    const resolved = join(pluginPath, manifestField)
    if (existsSync(resolved)) paths.push(resolved)
  } else if (Array.isArray(manifestField)) {
    for (const p of manifestField) {
      if (typeof p === 'string') {
        const resolved = join(pluginPath, p)
        if (existsSync(resolved)) paths.push(resolved)
      }
    }
  } else if (typeof manifestField === 'object') {
    // Record<string, CommandMetadata> — extract source paths
    for (const [, meta] of Object.entries(manifestField)) {
      if (meta && typeof meta === 'object' && 'source' in meta) {
        const source = (meta as { source?: string }).source
        if (source) {
          const resolved = join(pluginPath, source)
          if (existsSync(resolved)) paths.push(resolved)
        }
      }
    }
  }

  return paths
}

/**
 * Walk from cwd up to home, collecting .wzxclaw/plugins/ paths.
 * Returns shallow-first order (closest to home first).
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

// dirname import needed for getProjectDirsUpToHome
import { dirname } from 'path'
