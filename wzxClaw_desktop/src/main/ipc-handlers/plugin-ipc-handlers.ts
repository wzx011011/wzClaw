import { ipcMain } from 'electron'
import { IPC_CHANNELS, IpcSchemas } from '../../shared/ipc-channels'
import { pluginToInfo } from '../../shared/types-plugin'
import { skillToInfo } from '../../shared/types-skill'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import { SettingsManager } from '../settings-manager'

export interface PluginIpcDeps {
  workspaceManager: WorkspaceManager
  settingsManager: SettingsManager
  /** Resolves current workspace projectRoots (shared helper) */
  resolveProjectRoots: () => string[]
}

export function registerPluginIpcHandlers(deps: PluginIpcDeps): void {
  const { workspaceManager, settingsManager, resolveProjectRoots } = deps

  // ============================================================
  // Plugins — list, get, install, uninstall, enable, disable, reload, get-skills
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:list'], async () => {
    const { pluginRegistry } = await import('../plugins')
    pluginRegistry.setSettingsManager(settingsManager)
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    return pluginRegistry.getAllInfo()
  })

  ipcMain.handle(IPC_CHANNELS['plugin:get'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    const plugin = pluginRegistry.find(request.name)
    if (!plugin) return null
    const info = pluginToInfo(plugin)
    const skills = pluginRegistry.getPluginSkills(plugin.name)
    info.commandCount = skills.length
    info.skillCount = skills.filter(s => s.skillRoot).length
    return info
  })

  ipcMain.handle(IPC_CHANNELS['plugin:install'], async (_event, request: { path: string; scope?: import('../../shared/types-plugin').PluginScope }) => {
    const { pluginRegistry } = await import('../plugins')
    const plugin = pluginRegistry.installFromDirectory(
      request.path,
      'local',
      request.scope ?? 'user',
    )
    if (!plugin) {
      return { success: false, message: `Failed to install plugin from ${request.path}` }
    }
    return { success: true, message: `Plugin '${plugin.name}' installed successfully`, pluginName: plugin.name }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:uninstall'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const removed = pluginRegistry.uninstall(request.name)
    return { success: removed, message: removed ? `Plugin '${request.name}' uninstalled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:enable'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const ok = await pluginRegistry.enable(request.name)
    return { success: ok, message: ok ? `Plugin '${request.name}' enabled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:disable'], async (_event, request: { name: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const ok = pluginRegistry.disable(request.name)
    return { success: ok, message: ok ? `Plugin '${request.name}' disabled` : `Plugin '${request.name}' not found` }
  })

  ipcMain.handle(IPC_CHANNELS['plugin:reload'], async () => {
    const { pluginRegistry } = await import('../plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.reload(cwd, projectRoots)
  })

  ipcMain.handle(IPC_CHANNELS['plugin:get-skills'], async (_event, request: { pluginName?: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await pluginRegistry.load(cwd, projectRoots)
    if (request.pluginName) {
      return pluginRegistry.getPluginSkills(request.pluginName).map(skillToInfo)
    }
    return pluginRegistry.getAllPluginSkillInfo()
  })

  // ============================================================
  // Plugins: install-from-source (marketplace: git/npm/url)
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:install-from-source'], async (_event, request) => {
    // Validate request with Zod schema
    const schema = IpcSchemas['plugin:install-from-source'].request
    const parsed = schema.safeParse(request)
    if (!parsed.success) {
      return { success: false, message: `Invalid request: ${parsed.error.message}` }
    }
    const { PluginInstaller } = await import('../plugins')
    const scope = request.scope ?? 'user'
    const projectRoot = scope === 'project'
      ? workspaceManager.getWorkspaceRoot() ?? undefined
      : undefined
    return PluginInstaller.fromMarketplaceSource(request.source, scope, projectRoot)
  })

  // ============================================================
  // Plugins: get-output-styles — merged CSS from all enabled plugins
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:get-output-styles'], async () => {
    const { pluginRegistry } = await import('../plugins')
    const { getAllOutputStylesCss } = await import('../plugins/plugin-output-styles')
    const plugins = pluginRegistry.getAll().filter(p => p.enabled)
    return getAllOutputStylesCss(plugins)
  })

  // ============================================================
  // Plugins: get-user-config / set-user-config
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:get-user-config'], async (_event, request: { pluginName: string }) => {
    const { pluginRegistry } = await import('../plugins')
    const plugin = pluginRegistry.find(request.pluginName)
    if (!plugin) return {}
    return plugin.userConfigValues ?? {}
  })

  ipcMain.handle(IPC_CHANNELS['plugin:set-user-config'], async (_event, request: { pluginName: string; values: Record<string, unknown> }) => {
    const { pluginRegistry } = await import('../plugins')
    const plugin = pluginRegistry.find(request.pluginName)
    if (!plugin) {
      return { success: false, message: `Plugin '${request.pluginName}' not found` }
    }
    plugin.userConfigValues = { ...plugin.userConfigValues, ...request.values }
    // 持久化到磁盘
    pluginRegistry.persistPluginState(plugin.name, {
      enabled: plugin.enabled,
      scope: 'user',
      userConfigValues: plugin.userConfigValues,
    })
    return { success: true, message: `User config saved for '${request.pluginName}'` }
  })

  // ============================================================
  // Plugin: search_marketplace — discover installable plugins
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['plugin:search_marketplace'], async (_event, request?: { query?: string }) => {
    // Validate request with Zod schema
    const schema = IpcSchemas['plugin:search_marketplace'].request
    const parsed = schema.safeParse(request ?? {})
    if (!parsed.success) {
      return []
    }
    const query = parsed.data?.query?.toLowerCase() ?? ''
    try {
      // Built-in marketplace: curated list of known plugins
      // NOTE: These are placeholder entries for UI demonstration.
      // installSource repos do not exist yet — isPlaceholder disables install button.
      const builtins: import('../../shared/types-plugin').MarketplacePluginDisplay[] = [
        {
          name: 'git-workflow',
          description: 'Git workflow automation — commit, branch, rebase, and PR management',
          tags: ['git', 'workflow', 'vcs'],
          category: 'Version Control',
          installSource: { source: 'github', repo: 'anthropics/git-workflow-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'code-quality',
          description: 'Code quality analysis — linting, formatting, and best practices enforcement',
          tags: ['quality', 'linting', 'formatting'],
          category: 'Code Quality',
          installSource: { source: 'github', repo: 'anthropics/code-quality-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'project-analysis',
          description: 'Project structure analysis and documentation generation',
          tags: ['analysis', 'documentation', 'structure'],
          category: 'Analysis',
          installSource: { source: 'github', repo: 'anthropics/project-analysis-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'context-aware-agent',
          description: 'Context-aware code suggestions based on project structure and dependencies',
          tags: ['agent', 'context', 'suggestions'],
          category: 'AI Enhancement',
          installSource: { source: 'github', repo: 'anthropics/context-aware-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'test-runner',
          description: 'Automated test discovery, execution, and coverage reporting',
          tags: ['testing', 'coverage', 'automation'],
          category: 'Testing',
          installSource: { source: 'github', repo: 'anthropics/test-runner-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'docker-helper',
          description: 'Docker container management and Dockerfile optimization',
          tags: ['docker', 'containers', 'devops'],
          category: 'DevOps',
          installSource: { source: 'github', repo: 'anthropics/docker-helper-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'database-tools',
          description: 'Database schema analysis, migration management, and query optimization',
          tags: ['database', 'sql', 'migrations'],
          category: 'Data',
          installSource: { source: 'github', repo: 'anthropics/database-tools-plugin' },
          installed: false,
          isPlaceholder: true,
        },
        {
          name: 'security-scanner',
          description: 'Security vulnerability scanning and dependency audit',
          tags: ['security', 'audit', 'vulnerabilities'],
          category: 'Security',
          installSource: { source: 'github', repo: 'anthropics/security-scanner-plugin' },
          installed: false,
          isPlaceholder: true,
        },
      ]

      // Mark installed plugins
      const { pluginRegistry } = await import('../plugins')
      const installedNames = new Set(pluginRegistry.getAll().map(p => p.name))
      for (const entry of builtins) {
        entry.installed = installedNames.has(entry.name)
        if (entry.installed) {
          const plugin = pluginRegistry.find(entry.name)
          entry.enabled = plugin?.enabled ?? false
        }
      }

      // Filter by query
      if (query) {
        return builtins.filter(p =>
          p.name.toLowerCase().includes(query) ||
          (p.description?.toLowerCase().includes(query) ?? false) ||
          (p.tags?.some(t => t.toLowerCase().includes(query)) ?? false) ||
          (p.category?.toLowerCase().includes(query) ?? false)
        )
      }
      return builtins
    } catch (err) {
      console.error('[plugin:search_marketplace]', err)
      return []
    }
  })
}
