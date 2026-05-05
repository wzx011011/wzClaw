// ============================================================
// Plugin Type System (modeled after Claude Code's plugin system)
// ============================================================

/**
 * Scope where a plugin is installed.
 * - 'user'    — global, available in all projects
 * - 'project' — current project (.wzxclaw/settings.json)
 * - 'local'   — current project (.wzxclaw/settings.local.json)
 * - 'managed' — enterprise policy, read-only
 */
export type PluginScope = 'user' | 'project' | 'local' | 'managed'

/**
 * Plugin directory structure components.
 * Each corresponds to a subdirectory in the plugin root.
 */
export type PluginComponent = 'commands' | 'agents' | 'skills' | 'hooks' | 'output-styles'

/**
 * User-configurable option declared in plugin manifest.
 * Users are prompted at enable time. Non-sensitive values go to
 * settings.json; sensitive values go to encrypted storage.
 */
export interface UserConfigOption {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  default?: string | number | boolean | string[]
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
}

/**
 * Message channel declaration — an MCP server that injects messages
 * into the conversation (e.g. Telegram, Slack).
 */
export interface PluginChannel {
  server: string
  displayName?: string
  userConfig?: Record<string, UserConfigOption>
}

/**
 * Plugin author information.
 */
export interface PluginAuthor {
  name: string
  email?: string
  url?: string
}

/**
 * Plugin manifest (plugin.json) — defines metadata and components.
 *
 * Directory structure:
 * ```
 * my-plugin/
 * ├── plugin.json          # This manifest
 * ├── commands/            # Slash commands (.md files)
 * │   ├── build.md
 * │   └── deploy.md
 * ├── agents/              # Sub-agents (.md files)
 * │   └── test-runner.md
 * ├── skills/              # Skills (SKILL.md directories)
 * │   └── code-review/
 * │       └── SKILL.md
 * ├── hooks/
 * │   └── hooks.json       # Lifecycle hooks
 * └── .mcp.json            # MCP server configs
 * ```
 */
export interface PluginManifest {
  /** Unique identifier (kebab-case) */
  name: string
  /** Semantic version */
  version?: string
  /** Brief description */
  description?: string
  /** Author info */
  author?: PluginAuthor
  /** Homepage URL */
  homepage?: string
  /** Source code repository */
  repository?: string
  /** SPDX license identifier */
  license?: string
  /** Tags for discovery */
  keywords?: string[]

  // ---- Component paths (relative to plugin root) ----

  /** Additional command files/directories beyond commands/ */
  commands?: string | string[] | Record<string, CommandMetadata>
  /** Additional agent files beyond agents/ */
  agents?: string | string[]
  /** Additional skill directories beyond skills/ */
  skills?: string | string[]
  /** Output style files */
  outputStyles?: string | string[]

  // ---- Inline configurations ----

  /** Hooks configuration (inline or path) */
  hooks?: unknown
  /** MCP server configs */
  mcpServers?: Record<string, McpServerConfig>
  /** LSP server configs */
  lspServers?: Record<string, unknown>

  // ---- User configuration ----

  /** User-configurable values prompted at enable time */
  userConfig?: Record<string, UserConfigOption>

  // ---- Channels ----

  /** Message channels (Telegram, Slack, etc.) */
  channels?: PluginChannel[]

  // ---- Dependencies ----

  /** Other plugins this plugin depends on */
  dependencies?: string[]

  // ---- Settings ----

  /** Settings to merge when plugin is enabled */
  settings?: Record<string, unknown>
}

/**
 * Metadata for a command when using object-mapping format in manifest.
 */
export interface CommandMetadata {
  source?: string
  content?: string
  description?: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
}

/**
 * Simplified MCP server config for plugin manifests.
 */
export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  transport?: 'stdio' | 'sse'
  env?: Record<string, string>
}

/**
 * A fully loaded and validated plugin ready for use.
 */
export interface LoadedPlugin {
  /** Plugin name (from manifest) */
  name: string
  /** Parsed manifest */
  manifest: PluginManifest
  /** Absolute path to plugin root directory */
  path: string
  /** Source identifier: 'builtin' | 'local' | '{marketplace-name}' */
  source: string
  /** Whether this plugin is currently enabled */
  enabled: boolean
  /** True for built-in plugins that ship with the app */
  isBuiltin?: boolean
  /** Version string */
  version?: string

  // ---- Resolved component paths ----

  /** Absolute path to commands/ directory */
  commandsPath?: string
  /** Additional command paths from manifest */
  commandsPaths?: string[]
  /** Absolute path to agents/ directory */
  agentsPath?: string
  /** Additional agent paths from manifest */
  agentsPaths?: string[]
  /** Absolute path to skills/ directory */
  skillsPath?: string
  /** Additional skill paths from manifest */
  skillsPaths?: string[]
  /** Absolute path to output-styles/ directory */
  outputStylesPath?: string

  // ---- Loaded configurations ----

  /** Parsed hooks configuration */
  hooksConfig?: unknown
  /** MCP servers from manifest + .mcp.json */
  mcpServers?: Record<string, McpServerConfig>
  /** Resolved user config values */
  userConfigValues?: Record<string, unknown>

  // ---- Errors ----

  /** Errors encountered during loading */
  errors?: PluginError[]
}

/**
 * Plugin error with discriminated type.
 */
export type PluginError =
  | { type: 'manifest-not-found'; message: string }
  | { type: 'manifest-parse-error'; message: string; detail?: string }
  | { type: 'manifest-validation-error'; message: string; detail?: string }
  | { type: 'component-load-error'; component: PluginComponent; message: string }
  | { type: 'dependency-error'; message: string }
  | { type: 'generic-error'; message: string }

/**
 * Serialized plugin info sent over IPC (no functions, no circular refs).
 */
export interface PluginInfo {
  name: string
  description?: string
  version?: string
  author?: PluginAuthor
  source: string
  enabled: boolean
  isBuiltin?: boolean
  /** Component counts */
  commandCount: number
  skillCount: number
  agentCount: number
  hasHooks: boolean
  hasMcpServers: boolean
  hasUserConfig: boolean
  /** Errors during loading */
  errors?: Array<{ type: string; message: string }>
}

/** Convert LoadedPlugin → PluginInfo (strip internal data) */
export function pluginToInfo(plugin: LoadedPlugin): PluginInfo {
  return {
    name: plugin.name,
    description: plugin.manifest.description,
    version: plugin.version ?? plugin.manifest.version,
    author: plugin.manifest.author,
    source: plugin.source,
    enabled: plugin.enabled,
    isBuiltin: plugin.isBuiltin,
    commandCount: 0, // will be populated after command loading
    skillCount: 0,
    agentCount: 0,
    hasHooks: !!plugin.hooksConfig,
    hasMcpServers: !!(plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0),
    hasUserConfig: !!(plugin.manifest.userConfig && Object.keys(plugin.manifest.userConfig).length > 0),
    errors: plugin.errors?.map(e => ({ type: e.type, message: e.message })),
  }
}

// ============================================================
// Marketplace Types (Phase 4)
// ============================================================

/**
 * Source location for a marketplace.
 */
export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string; path?: string }
  | { source: 'git'; url: string; ref?: string; path?: string }
  | { source: 'url'; url: string; headers?: Record<string, string> }
  | { source: 'directory'; path: string }

/**
 * Marketplace manifest (marketplace.json).
 */
export interface MarketplaceManifest {
  name: string
  owner: PluginAuthor
  plugins: MarketplaceEntry[]
}

/**
 * A plugin entry in a marketplace.
 */
export interface MarketplaceEntry {
  name: string
  source: string | MarketplacePluginSource
  description?: string
  category?: string
  tags?: string[]
  strict?: boolean
}

export type MarketplacePluginSource =
  | { source: 'github'; repo: string; ref?: string; path?: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'npm'; package: string; version?: string }
  | { source: 'url'; url: string }

/**
 * Plugin installation result.
 */
export interface PluginInstallResult {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
}
