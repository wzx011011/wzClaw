import { z } from 'zod'
import type { FileTreeNode, SessionConfig, SessionConfigPatch, Workspace, ThemeMode, AccentColor, Host, HostMonitorData, DockerContainer, SftpEntry, SshExecEvent } from './types'
import { AGENT_CHANNELS } from './ipc/agent'
import { SETTINGS_CHANNELS } from './ipc/settings'
import { WORKSPACE_CHANNELS } from './ipc/workspace'
import { FILE_CHANNELS } from './ipc/file'
import { TERMINAL_CHANNELS } from './ipc/terminal'
import { INDEXING_CHANNELS } from './ipc/indexing'
import { PERMISSION_CHANNELS } from './ipc/permission'
import { MCP_CHANNELS } from './ipc/mcp'
import { BROWSER_CHANNELS } from './ipc/browser'
import { RELAY_CHANNELS } from './ipc/relay'
import { HAND_CHANNELS } from './ipc/hand'
import { SKILL_CHANNELS } from './ipc/skill'
import { PLUGIN_CHANNELS } from './ipc/plugin'
import { HOST_CHANNELS } from './ipc/host'
import { SYSTEM_CHANNELS } from './ipc/system'

// ============================================================
// IPC Channel Name Constants — assembled from domain files
// See src/shared/ipc/{domain}.ts for per-domain groupings
// ============================================================

export const IPC_CHANNELS = {
  ...AGENT_CHANNELS,
  ...SETTINGS_CHANNELS,
  ...WORKSPACE_CHANNELS,
  ...FILE_CHANNELS,
  ...TERMINAL_CHANNELS,
  ...INDEXING_CHANNELS,
  ...PERMISSION_CHANNELS,
  ...MCP_CHANNELS,
  ...BROWSER_CHANNELS,
  ...RELAY_CHANNELS,
  ...HAND_CHANNELS,
  ...SKILL_CHANNELS,
  ...PLUGIN_CHANNELS,
  ...HOST_CHANNELS,
  ...SYSTEM_CHANNELS,
} as const

export type IpcChannelName = keyof typeof IPC_CHANNELS

// ============================================================
// Payload Type Maps (per D-10)
// ============================================================

// Request payloads (renderer sends to main via ipcRenderer.invoke)
export interface IpcRequestPayloads {
  'todo:load': { sessionId: string }
  'agent:permission_response': {
    approved: boolean
    sessionCache: boolean
  }
  'settings:get': void
  'settings:update': {
    provider?: string
    model?: string
    apiKey?: string
    baseURL?: string
    systemPrompt?: string
    relayToken?: string
    thinkingDepth?: string
    showToolSteps?: boolean
    language?: string
    themeMode?: ThemeMode
    accentColor?: AccentColor
  }
  'workspace:open_folder': void
  'workspace:set_folder': { folderPath: string }
  'workspace:get_tree': { dirPath?: string; depth?: number }
  'workspace:watch': void
  'workspace:status': void
  'file:read': { filePath: string }
  'file:read-content': { filePath: string }
  'file:read-folder-tree': { dirPath: string }
  'file:save': { filePath: string; content: string }
  'file:rename': { oldPath: string; newPath: string }
  'file:delete': { filePath: string }
  'file:create': { dirPath: string; name: string; type: 'file' | 'directory' }
  'file:apply-hunk': { filePath: string; hunksToApply: string[]; modifiedContent: string }
  'file:get-history': { filePath: string }
  'file:revert': { toolCallId: string }
  'system:doctor': void
  'agent:plan-decision': { approved: boolean }
  'agent:toggle_plan_mode': void
  'terminal:create': { cwd: string }
  'terminal:kill': { terminalId: string }
  'terminal:input': { terminalId: string; data: string }
  'terminal:resize': { terminalId: string; cols: number; rows: number }
  'terminal:output': { terminalId: string }
  'index:status': void
  'index:reindex': void
  'index:search': { query: string; topK?: number }
  'git:status': void
  'permission:get_mode': void
  'permission:set_mode': { mode: string }
  'mcp:list_servers': void
  'mcp:add_server': { name: string; command?: string; args?: string[]; url?: string; transport: 'stdio' | 'sse' }
  'mcp:remove_server': { name: string }
  'mcp:list_tools': void
  'browser:navigate': { url: string }
  'browser:take_screenshot': void
  'browser:close': void
  'relay:connect': { token: string }
  'relay:disconnect': void
  'relay:get_status': void
  'relay:qrcode': { token?: string }
  // Hand channels
  'hand:get_status': void
  'hand:reconnect': void
  'hand:disconnect': void
  'ask-user:answer': { questionId: string; selectedLabels: string[]; customText?: string }
  'workspace:list': { includeArchived?: boolean }
  'workspace:get': { workspaceId: string }
  'workspace:create': { title: string; description?: string }
  'workspace:update': { workspaceId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string; systemPrompt?: string } }
  'workspace:delete': { workspaceId: string }
  'workspace:add-project': { workspaceId: string; folderPath: string }
  'workspace:remove-project': { workspaceId: string; projectId: string }
  'shell:open_path': { path: string }
  'shell:get_extension_paths': void
  'skill:list': void
  'skill:get-prompt': { name: string; args: string }
  'skill:reload': void
  'skill:invoke': { name: string; args: string }

  'tools:list': void

  // Plugin channels
  'plugin:list': void
  'plugin:get': { name: string }
  'plugin:install': { path: string; scope?: import('./types-plugin').PluginScope }
  'plugin:uninstall': { name: string }
  'plugin:enable': { name: string }
  'plugin:disable': { name: string }
  'plugin:reload': void
  'plugin:get-skills': { pluginName?: string }
  'plugin:install-from-source': { source: import('./types-plugin').MarketplacePluginSource; scope?: import('./types-plugin').PluginScope }
  'plugin:get-output-styles': void
  'plugin:get-user-config': { pluginName: string }
  'plugin:set-user-config': { pluginName: string; values: Record<string, unknown> }
  'plugin:search_marketplace': { query?: string }

  // Host management
  'host:list': { includeArchived?: boolean }
  'host:get': { hostId: string }
  'host:create': { name: string; host: string; port?: number; username: string; authType: 'password' | 'key'; password?: string; keyPath?: string; description?: string; tags?: string[] }
  'host:update': { hostId: string; updates: Partial<Pick<Host, 'name' | 'host' | 'port' | 'username' | 'authType' | 'description' | 'tags' | 'archived'>> & { password?: string; keyPath?: string } }
  'host:delete': { hostId: string }
  'host:test-connection': { hostId: string }
  'host:exec': { hostId: string; command: string; timeout?: number }
  'host:monitor': { hostId: string }
  'host:sftp:list': { hostId: string; path: string }
  'host:sftp:download': { hostId: string; remotePath: string; localPath: string }
  'host:sftp:upload': { hostId: string; localPath: string; remotePath: string }
  'host:sftp:read': { hostId: string; path: string }
  'host:sftp:mkdir': { hostId: string; path: string }
  'host:sftp:delete': { hostId: string; path: string }
  'host:docker:list': { hostId: string }
  'host:docker:logs': { hostId: string; containerId: string; tail?: number }
  'host:docker:action': { hostId: string; containerId: string; action: 'start' | 'stop' | 'restart' | 'remove' }
  'host:docker:stats': { hostId: string; containerId: string }
  'host:docker:images': { hostId: string }
}
export interface IpcResponsePayloads {
  'todo:load': Array<{ content: string; status: string; activeForm: string }>
  'settings:get': {
    provider: string
    model: string
    hasApiKey: boolean
    maskedApiKey?: string
    baseURL?: string
    systemPrompt?: string
    relayToken?: string
    thinkingDepth?: string
    showToolSteps?: boolean
    language?: string
    themeMode?: ThemeMode
    accentColor?: AccentColor
  }
  'settings:update': void
  'workspace:open_folder': { rootPath: string } | null
  'workspace:set_folder': { rootPath: string } | null
  'workspace:get_tree': FileTreeNode[]
  'workspace:watch': void
  'workspace:status': { rootPath: string | null; isWatching: boolean }
  'file:read': { content: string; language: string }
  'file:read-content': { content: string; size: number; path: string } | { error: string; size: number; limit: number }
  'file:read-folder-tree': { tree: string; fileCount: number; path: string } | { error: string }
  'file:save': void
  'file:rename': { success: boolean }
  'file:delete': { success: boolean }
  'file:create': { success: boolean; filePath: string }
  'file:apply-hunk': { success: boolean }
  'file:get-history': Array<{ toolCallId: string; timestamp: number; filePath: string }>
  'file:revert': { success: boolean; error?: string }
  'system:doctor': string
  'agent:plan-decision': void
  'agent:toggle_plan_mode': { active: boolean }
  'terminal:create': { terminalId: string }
  'terminal:kill': void
  'terminal:input': void
  'terminal:resize': void
  'terminal:output': { buffer: string }
  'symbol:query': { results: Array<{ filePath: string; line: number; symbolName: string; kind: string }> }
  'index:status': { status: string; fileCount: number; currentFile: string; error?: string }
  'index:reindex': void
  'index:search': Array<{ filePath: string; startLine: number; endLine: number; content: string; score: number }>
  'git:status': { branch: string; changedFiles: number }
  'permission:get_mode': { mode: string }
  'permission:set_mode': void
  'tools:list': Array<{ name: string; description: string; isReadOnly: boolean; requiresApproval: boolean }>
  'mcp:list_servers': Array<{ name: string; transport: string; connected: boolean }>
  'mcp:add_server': void
  'mcp:remove_server': void
  'mcp:list_tools': Array<{ name: string; description: string; serverName: string }>
  'browser:navigate': { title: string }
  'browser:take_screenshot': { base64: string }
  'browser:close': void
  'relay:connect': void
  'relay:disconnect': void
  'relay:get_status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  'relay:qrcode': { qrCode: string }
  // Hand channel responses
  'hand:get_status': { status: string; handId: string }
  'hand:reconnect': void
  'hand:disconnect': void
  'ask-user:answer': void
  'workspace:list': Workspace[]
  'workspace:get': Workspace | null
  'workspace:create': Workspace
  'workspace:update': Workspace
  'workspace:delete': void
  'workspace:add-project': Workspace
  'workspace:remove-project': Workspace
  'shell:open_path': void
  'shell:get_extension_paths': { commandsDir: string; skillsDir: string }
  'skill:list': import('./types-skill').SkillInfo[]
  'skill:get-prompt': string | null
  'skill:reload': void
  'skill:invoke': { content: string } | { error: string }

  // Plugin channels
  'plugin:list': import('./types-plugin').PluginInfo[]
  'plugin:get': import('./types-plugin').PluginInfo | null
  'plugin:install': { success: boolean; message: string; pluginName?: string }
  'plugin:uninstall': { success: boolean; message: string }
  'plugin:enable': { success: boolean; message: string }
  'plugin:disable': { success: boolean; message: string }
  'plugin:reload': void
  'plugin:get-skills': import('./types-skill').SkillInfo[]
  'plugin:install-from-source': import('./types-plugin').PluginInstallResult
  'plugin:get-output-styles': { css: string; styleNames: string[] }
  'plugin:get-user-config': Record<string, unknown>
  'plugin:set-user-config': { success: boolean; message: string }
  'plugin:search_marketplace': import('./types-plugin').MarketplacePluginDisplay[]

  // Host management
  'host:list': Host[]
  'host:get': Host | null
  'host:create': Host
  'host:update': Host
  'host:delete': void
  'host:test-connection': { success: boolean; error?: string; info?: { os: string; hostname: string } }
  'host:exec': { success: boolean; exitCode: number; stdout: string; stderr: string }
  'host:monitor': HostMonitorData
  'host:sftp:list': SftpEntry[]
  'host:sftp:download': { success: boolean; localPath: string }
  'host:sftp:upload': { success: boolean; remotePath: string }
  'host:sftp:read': { content: string; size: number; path: string } | { error: string }
  'host:sftp:mkdir': { success: boolean }
  'host:sftp:delete': { success: boolean }
  'host:docker:list': DockerContainer[]
  'host:docker:logs': { logs: string; containerId: string }
  'host:docker:action': { success: boolean; containerId: string; action: string }
  'host:docker:stats': { cpuPercent: number; memoryMB: number; memoryLimitMB: number; networkIO: string; blockIO: string }
  'host:docker:images': Array<{ repository: string; tag: string; id: string; created: string; size: string }>
}

// Stream payloads (main sends to renderer via webContents.send)
export interface IpcStreamPayloads {
  'agent:permission_request': {
    toolName: string
    toolInput: Record<string, unknown>
    reason: string
  }
  'file:changed': { filePath: string; changeType: 'created' | 'modified' | 'deleted' }
  'agent:plan-mode-entered': Record<string, never>
  'agent:plan-mode-exited': { plan: string }
  'terminal:data': { terminalId: string; data: string }
  'symbol:query': { queryId: string; operation: string; params: Record<string, unknown> }
  'symbol:result': { queryId: string; result: unknown; isError: boolean }
  'index:progress': { status: string; fileCount: number; currentFile: string; error?: string }
  'browser:screenshot': { url: string; base64: string; timestamp: number }
  'browser:status': { running: boolean; url: string | null }
  'relay:status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  // Hand status stream (main -> renderer push)
  'hand:status': { status: string; handId: string }
  'ask-user:question': { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }

  // Host SSH exec stream (main -> renderer)
  'host:exec:stream': SshExecEvent
}

// ============================================================
// Zod Schemas for IPC Validation (per D-09)
// ============================================================

export const IpcSchemas = {
  'file:read-content': {
    request: z.object({
      filePath: z.string().min(1)
    }),
    response: z.union([
      z.object({
        content: z.string(),
        size: z.number(),
        path: z.string()
      }),
      z.object({
        error: z.string(),
        size: z.number(),
        limit: z.number()
      })
    ])
  },
  'file:read-folder-tree': {
    request: z.object({
      dirPath: z.string().min(1)
    }),
    response: z.union([
      z.object({
        tree: z.string(),
        fileCount: z.number(),
        path: z.string()
      }),
      z.object({
        error: z.string()
      })
    ])
  },
  'file:save': {
    request: z.object({
      filePath: z.string().min(1),
      content: z.string()
    }),
    response: z.void()
  },
  'file:apply-hunk': {
    request: z.object({
      filePath: z.string().min(1),
      hunksToApply: z.array(z.string()),
      modifiedContent: z.string()
    }),
    response: z.object({ success: z.boolean() })
  },
  'plugin:install-from-source': {
    request: z.object({
      source: z.union([
        z.object({ source: z.literal('github'), repo: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('git'), url: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('url'), url: z.string().min(1), headers: z.record(z.string()).optional() }),
        z.object({ source: z.literal('directory'), path: z.string().min(1) }),
      ]),
      scope: z.enum(['user', 'project', 'local', 'managed']).optional()
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string(),
      pluginId: z.string().optional(),
      pluginName: z.string().optional(),
      scope: z.enum(['user', 'project', 'local', 'managed']).optional()
    })
  },
  'plugin:search_marketplace': {
    request: z.object({ query: z.string().optional() }).optional(),
    response: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
      author: z.string().optional(),
      homepage: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      installSource: z.union([
        z.object({ source: z.literal('github'), repo: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('git'), url: z.string().min(1), ref: z.string().optional() }),
        z.object({ source: z.literal('npm'), package: z.string().min(1), version: z.string().optional() }),
        z.object({ source: z.literal('url'), url: z.string().min(1) }),
      ]),
      installed: z.boolean(),
      enabled: z.boolean().optional(),
      isPlaceholder: z.boolean().optional(),
    }))
  },
  // Host management schemas
  'host:create': {
    request: z.object({
      name: z.string().min(1),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().min(1),
      authType: z.enum(['password', 'key']),
      password: z.string().optional(),
      keyPath: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional()
    }),
    response: z.any() // Host type — complex nested, validated at runtime
  },
  'host:update': {
    request: z.object({
      hostId: z.string().min(1),
      updates: z.record(z.unknown())
    }),
    response: z.any()
  },
  'host:exec': {
    request: z.object({
      hostId: z.string().min(1),
      command: z.string().min(1),
      timeout: z.number().int().min(1000).optional()
    }),
    response: z.object({
      success: z.boolean(),
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string()
    })
  },
  'host:sftp:list': {
    request: z.object({
      hostId: z.string().min(1),
      path: z.string().min(1)
    }),
    response: z.array(z.any())
  },
  'host:docker:action': {
    request: z.object({
      hostId: z.string().min(1),
      containerId: z.string().min(1),
      action: z.enum(['start', 'stop', 'restart', 'remove'])
    }),
    response: z.object({
      success: z.boolean(),
      containerId: z.string(),
      action: z.string()
    })
  }
} as const
