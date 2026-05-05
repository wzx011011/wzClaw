// ============================================================
// Plugin Registry — unified registry managing all plugin sources
// Bridges plugins with the skill registry and MCP manager
// Modeled after Claude Code's commands.ts getCommands() flow
// ============================================================

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { LoadedPlugin, PluginInfo, PluginScope } from '../../shared/types-plugin'
import { pluginToInfo } from '../../shared/types-plugin'
import type { Skill, SkillInfo } from '../../shared/types-skill'
import { skillToInfo } from '../../shared/types-skill'
import { scanAllPlugins, loadPlugin } from './plugin-loader'
import { loadPluginCommands } from './plugin-commands'
import { loadPluginHooks, unloadPluginHooks } from './plugin-hooks'
import { loadPluginAgents, agentToSkill, type PluginAgent } from './plugin-agents'
import type { SettingsManager } from '../settings-manager'
import type { HookRegistry } from '../hooks/hook-registry'
import type { MCPManager } from '../mcp/mcp-manager'

// ============================================================
// Plugin state persistence
// ============================================================

interface PluginState {
  enabled: boolean
  scope: PluginScope
  userConfigValues?: Record<string, unknown>
}

// ============================================================
// Singleton registry
// ============================================================

class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>()
  private pluginSkills = new Map<string, Skill[]>()
  private pluginAgents = new Map<string, PluginAgent[]>()
  private pluginStates = new Map<string, PluginState>()
  private settingsManager: SettingsManager | null = null
  private hookRegistry: HookRegistry | null = null
  private mcpManager: MCPManager | null = null
  private pluginHookIds = new Map<string, string[]>()
  private loaded = false
  private loadingPromise: Promise<void> | null = null
  private cwd = ''

  /**
   * Set the settings manager for persisting plugin state.
   */
  setSettingsManager(sm: SettingsManager): void {
    this.settingsManager = sm
  }

  /**
   * Set the hook registry for plugin lifecycle hooks.
   */
  setHookRegistry(hr: HookRegistry): void {
    this.hookRegistry = hr
  }

  /**
   * Set the MCP manager for plugin MCP server lifecycle.
   */
  setMcpManager(mcp: MCPManager): void {
    this.mcpManager = mcp
  }

  /**
   * Load all plugins from all sources.
   * Idempotent — returns cached results unless forceReload.
   */
  async load(cwd: string, projectRoots: string[] = [], forceReload = false): Promise<void> {
    if (this.loaded && !forceReload && this.cwd === cwd) return

    if (this.loadingPromise) {
      await this.loadingPromise
      return
    }

    this.loadingPromise = this._load(cwd, projectRoots)
    try {
      await this.loadingPromise
    } finally {
      this.loadingPromise = null
    }
  }

  private async _load(cwd: string, projectRoots: string[]): Promise<void> {
    this.cwd = cwd
    this.plugins.clear()
    this.pluginSkills.clear()
    this.pluginAgents.clear()

    // 0. Load builtin plugins (shipped with the app)
    const builtinPlugins = await this.loadBuiltinPlugins()

    // 1. Scan directories for external plugins
    const scannedPlugins = await scanAllPlugins({ cwd, projectRoots })

    // 2. Load persisted states from settings
    if (this.settingsManager) {
      const saved = this.settingsManager.getPluginStates()
      for (const [name, state] of Object.entries(saved)) {
        this.pluginStates.set(name, { enabled: state.enabled, scope: state.scope as PluginScope })
      }
    }

    // 3. Merge builtin + scanned plugins (builtin first, external overrides by name)
    const allPlugins: LoadedPlugin[] = [...builtinPlugins]
    const builtinNames = new Set(builtinPlugins.map(p => p.name))
    for (const plugin of scannedPlugins) {
      if (!builtinNames.has(plugin.name)) {
        allPlugins.push(plugin)
      }
    }

    // 4. Apply saved states (enabled/disabled) and load components
    for (const plugin of allPlugins) {
      const state = this.pluginStates.get(plugin.name)
      if (state) {
        plugin.enabled = state.enabled
        plugin.userConfigValues = state.userConfigValues
      } else {
        // New plugin — default enabled, persist state
        this.persistPluginState(plugin.name, { enabled: true, scope: 'user' as PluginScope })
      }

      this.plugins.set(plugin.name, plugin)

      // 3. Load commands/skills/hooks from enabled plugins
      if (plugin.enabled) {
        const result = await loadPluginCommands(plugin)
        this.pluginSkills.set(plugin.name, result.skills)

        // Load plugin hooks into HookRegistry
        if (this.hookRegistry) {
          const hookIds = loadPluginHooks(plugin, this.hookRegistry)
          this.pluginHookIds.set(plugin.name, hookIds)
        }

        // Load agents from plugin
        const agentResult = loadPluginAgents(plugin)
        this.pluginAgents.set(plugin.name, agentResult.agents)
        if (agentResult.errors.length > 0) {
          console.warn(`[plugins] ${plugin.name} had ${agentResult.errors.length} agent loading errors`)
        }

        if (result.errors.length > 0) {
          console.warn(`[plugins] ${plugin.name} had ${result.errors.length} loading errors`)
          for (const err of result.errors) {
            console.warn(`  ${err.path}: ${err.error}`)
          }
        }

        // Connect plugin MCP servers
        await this.connectPluginMcpServers(plugin)
      }
    }

    const enabledCount = [...this.plugins.values()].filter(p => p.enabled).length
    const totalSkills = [...this.pluginSkills.values()].reduce((sum, s) => sum + s.length, 0)
    console.log(`[plugins] Registry loaded: ${this.plugins.size} plugins (${enabledCount} enabled), ${totalSkills} plugin skills`)
    this.loaded = true
  }

  /**
   * Force reload all plugins.
   */
  async reload(cwd: string, projectRoots: string[] = []): Promise<void> {
    this.loaded = false
    await this.load(cwd, projectRoots, true)
  }

  // ============================================================
  // Query methods
  // ============================================================

  /**
   * Get all loaded plugins.
   */
  getAll(): LoadedPlugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Get all plugins as PluginInfo (serialized for IPC).
   */
  getAllInfo(): PluginInfo[] {
    return this.getAll().map(plugin => {
      const info = pluginToInfo(plugin)
      const skills = this.pluginSkills.get(plugin.name) ?? []
      info.commandCount = skills.length
      info.skillCount = skills.filter(s => s.skillRoot).length
      const agents = this.pluginAgents.get(plugin.name) ?? []
      info.agentCount = agents.length
      return info
    })
  }

  /**
   * Find a plugin by name.
   */
  find(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name)
  }

  /**
   * Get all skills from all enabled plugins (commands + agents converted to skills).
   */
  getAllPluginSkills(): Skill[] {
    const skills: Skill[] = []
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled) continue
      const pluginSkills = this.pluginSkills.get(plugin.name) ?? []
      skills.push(...pluginSkills)
      // Include agents as skills
      const agents = this.pluginAgents.get(plugin.name) ?? []
      skills.push(...agents.map(agentToSkill))
    }
    return skills
  }

  /**
   * Get all plugin skills as SkillInfo (serialized for IPC).
   */
  getAllPluginSkillInfo(): SkillInfo[] {
    return this.getAllPluginSkills().map(skillToInfo)
  }

  /**
   * Get skills for a specific plugin (commands + agents).
   */
  getPluginSkills(pluginName: string): Skill[] {
    const skills = [...(this.pluginSkills.get(pluginName) ?? [])]
    const agents = this.pluginAgents.get(pluginName) ?? []
    skills.push(...agents.map(agentToSkill))
    return skills
  }

  /**
   * Get agents for a specific plugin.
   */
  getPluginAgents(pluginName: string): PluginAgent[] {
    return this.pluginAgents.get(pluginName) ?? []
  }

  // ============================================================
  // Lifecycle operations
  // ============================================================

  /**
   * Persist plugin state to settings.json.
   */
  private persistPluginState(name: string, state: PluginState & { userConfigValues?: Record<string, unknown> }): void {
    this.pluginStates.set(name, state)
    this.settingsManager?.savePluginState(name, {
      enabled: state.enabled,
      scope: state.scope,
      userConfigValues: state.userConfigValues,
    })
  }

  /**
   * Enable a plugin. Reloads its commands/skills/hooks.
   */
  async enable(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false

    plugin.enabled = true
    const state: PluginState = {
      ...this.pluginStates.get(name),
      enabled: true,
      scope: this.pluginStates.get(name)?.scope ?? 'user',
    }
    this.persistPluginState(name, state)

    // Reload commands
    const result = await loadPluginCommands(plugin)
    this.pluginSkills.set(name, result.skills)

    // Register hooks
    if (this.hookRegistry) {
      const hookIds = loadPluginHooks(plugin, this.hookRegistry)
      this.pluginHookIds.set(name, hookIds)
    }

    // Load agents
    const agentResult = loadPluginAgents(plugin)
    this.pluginAgents.set(name, agentResult.agents)

    // Connect MCP servers
    await this.connectPluginMcpServers(plugin)

    console.log(`[plugins] Enabled ${name} (${result.skills.length} commands, ${agentResult.agents.length} agents loaded)`)
    return true
  }

  /**
   * Disable a plugin. Removes its commands/skills/hooks.
   */
  disable(name: string): boolean {
    const plugin = this.plugins.get(name)
    if (!plugin) return false

    plugin.enabled = false
    this.pluginSkills.delete(name)
    this.pluginAgents.delete(name)

    // Unregister hooks
    if (this.hookRegistry) {
      const hookIds = this.pluginHookIds.get(name) ?? []
      unloadPluginHooks(name, this.hookRegistry, hookIds)
      this.pluginHookIds.delete(name)
    }

    // Disconnect MCP servers
    this.disconnectPluginMcpServers(plugin)

    const state: PluginState = {
      ...this.pluginStates.get(name),
      enabled: false,
      scope: this.pluginStates.get(name)?.scope ?? 'user',
    }
    this.persistPluginState(name, state)

    console.log(`[plugins] Disabled ${name}`)
    return true
  }

  /**
   * Install a plugin from a local directory.
   */
  async installFromDirectory(dirPath: string, source: string = 'local', scope: PluginScope = 'user'): Promise<LoadedPlugin | null> {
    const plugin = await loadPlugin({ path: dirPath, source, enabled: true })
    if (!plugin) return null

    this.plugins.set(plugin.name, plugin)
    this.persistPluginState(plugin.name, { enabled: true, scope })

    // Load commands + agents
    const result = await loadPluginCommands(plugin)
    this.pluginSkills.set(plugin.name, result.skills)
    const agentResult = loadPluginAgents(plugin)
    this.pluginAgents.set(plugin.name, agentResult.agents)

    console.log(`[plugins] Installed ${plugin.name} from ${dirPath} (${result.skills.length} commands, ${agentResult.agents.length} agents)`)
    return plugin
  }

  /**
   * Uninstall a plugin.
   */
  uninstall(name: string): boolean {
    const existed = this.plugins.has(name)

    // Unregister hooks
    if (this.hookRegistry) {
      const hookIds = this.pluginHookIds.get(name) ?? []
      unloadPluginHooks(name, this.hookRegistry, hookIds)
      this.pluginHookIds.delete(name)
    }

    this.plugins.delete(name)
    this.pluginSkills.delete(name)
    this.pluginAgents.delete(name)
    this.pluginStates.delete(name)
    this.settingsManager?.removePluginState(name)
    if (existed) {
      console.log(`[plugins] Uninstalled ${name}`)
    }
    return existed
  }

  /**
   * Get plugin count by source.
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {}
    for (const plugin of this.plugins.values()) {
      const key = `${plugin.source}:${plugin.enabled ? 'enabled' : 'disabled'}`
      stats[key] = (stats[key] ?? 0) + 1
    }
    return stats
  }

  /**
   * Get merged CSS from all enabled plugins' output-styles.
   */
  getAllOutputStyles(): { css: string; styleNames: string[] } {
    const { getAllOutputStylesCss } = require('./plugin-output-styles') as typeof import('./plugin-output-styles')
    const enabled = [...this.plugins.values()].filter(p => p.enabled)
    return getAllOutputStylesCss(enabled)
  }

  /**
   * Get user config values for a plugin.
   */
  getUserConfig(pluginName: string): Record<string, unknown> {
    const plugin = this.plugins.get(pluginName)
    return plugin?.userConfigValues ?? {}
  }

  /**
   * Set user config values for a plugin.
   */
  setUserConfig(pluginName: string, values: Record<string, unknown>): boolean {
    const plugin = this.plugins.get(pluginName)
    if (!plugin) return false
    plugin.userConfigValues = { ...plugin.userConfigValues, ...values }
    return true
  }

  // ============================================================
  // Builtin plugin loading
  // ============================================================

  /**
   * Load builtin plugins shipped with the app in src/main/plugins/builtin/.
   * These are always available and marked as isBuiltin.
   */
  private async loadBuiltinPlugins(): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = []
    const builtinDir = join(__dirname, 'builtin')

    if (!existsSync(builtinDir)) {
      console.warn('[plugins] Builtin plugin directory not found:', builtinDir)
      return plugins
    }

    let entries: string[]
    try {
      entries = readdirSync(builtinDir)
    } catch {
      return plugins
    }

    for (const entry of entries) {
      const entryPath = join(builtinDir, entry)
      try {
        const stat = statSync(entryPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      const plugin = await loadPlugin({
        path: entryPath,
        source: 'builtin',
        enabled: true,
        isBuiltin: true,
      })
      if (plugin) {
        plugins.push(plugin)
      }
    }

    console.log(`[plugins] Loaded ${plugins.length} builtin plugins`)
    return plugins
  }

  // ============================================================
  // MCP server lifecycle
  // ============================================================

  /**
   * Connect all MCP servers defined by a plugin.
   * Server names are prefixed with "plugin:{pluginName}:" to avoid collisions.
   */
  private async connectPluginMcpServers(plugin: LoadedPlugin): Promise<void> {
    if (!this.mcpManager || !plugin.mcpServers) return

    for (const [serverName, config] of Object.entries(plugin.mcpServers)) {
      const prefixedName = `plugin:${plugin.name}:${serverName}`
      try {
        await this.mcpManager.connectServer({
          name: prefixedName,
          command: config.command,
          args: config.args,
          url: config.url,
          transport: config.transport,
          env: config.env,
        })
        console.log(`[plugins] Connected MCP server "${prefixedName}" from plugin "${plugin.name}"`)
      } catch (err) {
        console.warn(`[plugins] Failed to connect MCP server "${prefixedName}" from plugin "${plugin.name}":`, err)
      }
    }
  }

  /**
   * Disconnect all MCP servers for a plugin.
   */
  private disconnectPluginMcpServers(plugin: LoadedPlugin): void {
    if (!this.mcpManager || !plugin.mcpServers) return

    for (const serverName of Object.keys(plugin.mcpServers)) {
      const prefixedName = `plugin:${plugin.name}:${serverName}`
      try {
        this.mcpManager.disconnectServer(prefixedName)
      } catch { /* ignore */ }
    }
  }
}

// Singleton instance
export const pluginRegistry = new PluginRegistry()
