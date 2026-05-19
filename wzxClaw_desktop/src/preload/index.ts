import { contextBridge, ipcRenderer } from 'electron'
import type { Workspace } from '../shared/types'

const api = {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (request: Record<string, unknown>) => ipcRenderer.invoke('settings:update', request),

  // Workspace (native folder operations)
  openFolder: () => ipcRenderer.invoke('workspace:open_folder'),
  getDirectoryTree: (request: { dirPath?: string; depth?: number }) =>
    ipcRenderer.invoke('workspace:get_tree', request),
  getWorkspaceStatus: () => ipcRenderer.invoke('workspace:status'),
  setFolder: (request: { folderPath: string }) => ipcRenderer.invoke('workspace:set_folder', request),

  // File operations
  readFile: (request: { filePath: string }) => ipcRenderer.invoke('file:read', request),
  readFileContent: (request: { filePath: string }) => ipcRenderer.invoke('file:read-content', request),
  readFolderTree: (request: { dirPath: string }) => ipcRenderer.invoke('file:read-folder-tree', request),
  saveFile: (request: { filePath: string; content: string }) => ipcRenderer.invoke('file:save', request),
  fsReadFile: (request: { path: string }) => ipcRenderer.invoke('file:read', { filePath: request.path }),
  fsWriteFile: (request: { path: string; content: string }) => ipcRenderer.invoke('file:save', { filePath: request.path, content: request.content }),
  fsTree: (request: { dirPath: string; depth?: number }) => ipcRenderer.invoke('workspace:get_tree', request),
  fsWatchStart: (_request: { path: string }) => Promise.resolve(),
  fsWatchStop: (_request: { path: string }) => Promise.resolve(),
  renameFile: (request: { oldPath: string; newPath: string }) => ipcRenderer.invoke('file:rename', request),
  deleteFile: (request: { filePath: string }) => ipcRenderer.invoke('file:delete', request),
  createFile: (request: { dirPath: string; name: string; type: 'file' | 'directory' }) => ipcRenderer.invoke('file:create', request),
  onFileChanged: (callback: (payload: { filePath: string; changeType: string }) => void) => {
    const handler = (_: unknown, payload: { filePath: string; changeType: string }) => callback(payload)
    ipcRenderer.on('file:changed', handler)
    return () => ipcRenderer.removeListener('file:changed', handler)
  },
  onFsWatch: (callback: (payload: { events: Array<{ path: string; type: string }> }) => void) => {
    const handler = (_: unknown, payload: { filePath: string; changeType: string }) => {
      callback({ events: [{ path: payload.filePath, type: payload.changeType }] })
    }
    ipcRenderer.on('file:changed', handler)
    return () => ipcRenderer.removeListener('file:changed', handler)
  },

  // Diff: apply accepted hunks to disk
  applyHunk: (request: { filePath: string; hunksToApply: string[]; modifiedContent: string }) =>
    ipcRenderer.invoke('file:apply-hunk', request),

  // Terminal
  createTerminal: (request: { cwd: string }) => ipcRenderer.invoke('terminal:create', request),
  killTerminal: (request: { terminalId: string }) => ipcRenderer.invoke('terminal:kill', request),
  terminalInput: (request: { terminalId: string; data: string }) => ipcRenderer.invoke('terminal:input', request),
  terminalResize: (request: { terminalId: string; cols: number; rows: number }) => ipcRenderer.invoke('terminal:resize', request),
  terminalOutput: (request: { terminalId: string }) => ipcRenderer.invoke('terminal:output', request),
  terminalSpawn: (request: { cwd?: string }) => ipcRenderer.invoke('terminal:create', { cwd: request.cwd }),
  terminalWrite: (request: { terminalId: string; data: string }) => ipcRenderer.invoke('terminal:input', request),
  onTerminalData: (callback: (payload: { terminalId: string; data: string }) => void) => {
    const handler = (_: unknown, payload: { terminalId: string; data: string }) => callback(payload)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onTerminalExit: (_callback: (payload: { terminalId: string; exitCode: number }) => void) => {
    return () => {}
  },

  // Preview (browser)
  previewOpen: (request: { url: string }) => ipcRenderer.invoke('browser:navigate', { url: request.url }),
  previewReload: () => ipcRenderer.invoke('browser:take_screenshot'),
  onPreviewUrlChange: (callback: (payload: { url: string | null }) => void) => {
    const handler = (_: unknown, payload: { url: string | null }) => callback({ url: payload.url })
    ipcRenderer.on('browser:status', handler)
    return () => ipcRenderer.removeListener('browser:status', handler)
  },

  // Hand status (NAS Hand Bridge)
  onHandStatus: (callback: (payload: { status: string; handId: string }) => void) => {
    const handler = (_: unknown, payload: { status: string; handId: string }) => callback(payload)
    ipcRenderer.on('hand:status', handler)
    return () => ipcRenderer.removeListener('hand:status', handler)
  },
  getHandStatus: (): Promise<{ status: string; handId: string }> =>
    ipcRenderer.invoke('hand:get_status'),
  reconnectHand: () => ipcRenderer.invoke('hand:reconnect'),
  disconnectHand: () => ipcRenderer.invoke('hand:disconnect'),

  // Permission mode
  getPermissionMode: () => ipcRenderer.invoke('permission:get_mode'),
  setPermissionMode: (request: { mode: string }) => ipcRenderer.invoke('permission:set_mode', request),

  // Plan mode (main -> renderer events, renderer -> main decision)
  onPlanModeEntered: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('agent:plan-mode-entered', handler)
    return () => ipcRenderer.removeListener('agent:plan-mode-entered', handler)
  },
  onPlanModeExited: (callback: (payload: { plan: string }) => void) => {
    const handler = (_: unknown, payload: { plan: string }) => callback(payload)
    ipcRenderer.on('agent:plan-mode-exited', handler)
    return () => ipcRenderer.removeListener('agent:plan-mode-exited', handler)
  },
  sendPlanDecision: (request: { approved: boolean }) =>
    ipcRenderer.invoke('agent:plan-decision', request),
  togglePlanMode: () =>
    ipcRenderer.invoke('agent:toggle_plan_mode'),

  // AskUserQuestion
  onAskUserQuestion: (callback: (payload: { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }) => void) => {
    const handler = (_: unknown, payload: { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }) => callback(payload)
    ipcRenderer.on('ask-user:question', handler)
    return () => ipcRenderer.removeListener('ask-user:question', handler)
  },
  answerUserQuestion: (payload: { questionId: string; selectedLabels: string[]; customText?: string }) =>
    ipcRenderer.invoke('ask-user:answer', payload),

  // File history / revert
  getFileHistory: (request: { filePath: string }) =>
    ipcRenderer.invoke('file:get-history', request),
  revertFile: (request: { toolCallId: string }) =>
    ipcRenderer.invoke('file:revert', request),

  // Workspaces — top-level user work units (local CRUD, mirrors agent-server)
  listWorkspaces: (request?: { includeArchived?: boolean }): Promise<Workspace[]> =>
    ipcRenderer.invoke('workspace:list', request),
  getWorkspace: (request: { workspaceId: string }): Promise<Workspace | null> =>
    ipcRenderer.invoke('workspace:get', request),
  createWorkspace: (request: { title: string; description?: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:create', request),
  updateWorkspace: (request: { workspaceId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string; systemPrompt?: string } }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:update', request),
  deleteWorkspace: (request: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke('workspace:delete', request),
  addWorkspaceProject: (request: { workspaceId: string; folderPath: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:add-project', request),
  removeWorkspaceProject: (request: { workspaceId: string; projectId: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:remove-project', request),

  // Shell utility
  openInExplorer: (folderPath: string) =>
    ipcRenderer.invoke('shell:open_path', { path: folderPath }),
  getExtensionPaths: (): Promise<{ commandsDir: string; skillsDir: string }> =>
    ipcRenderer.invoke('shell:get_extension_paths'),

  // Theme
  setTitleBarOverlay: (request: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke('theme:set-titlebar-overlay', request),

  // Host management — SSH-based server management
  listHosts: (request?: { includeArchived?: boolean }) =>
    ipcRenderer.invoke('host:list', request),
  getHost: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:get', request),
  createHost: (request: Record<string, unknown>) =>
    ipcRenderer.invoke('host:create', request),
  updateHost: (request: { hostId: string; updates: Record<string, unknown> }) =>
    ipcRenderer.invoke('host:update', request),
  deleteHost: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:delete', request),
  testHostConnection: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:test-connection', request),
  execHostCommand: (request: { hostId: string; command: string; timeout?: number }) =>
    ipcRenderer.invoke('host:exec', request),
  getHostMonitor: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:monitor', request),
  listHostDir: (request: { hostId: string; path: string }) =>
    ipcRenderer.invoke('host:sftp:list', request),
  downloadHostFile: (request: { hostId: string; remotePath: string; localPath: string }) =>
    ipcRenderer.invoke('host:sftp:download', request),
  uploadHostFile: (request: { hostId: string; localPath: string; remotePath: string }) =>
    ipcRenderer.invoke('host:sftp:upload', request),
  readHostFile: (request: { hostId: string; path: string }) =>
    ipcRenderer.invoke('host:sftp:read', request),
  mkdirHost: (request: { hostId: string; path: string }) =>
    ipcRenderer.invoke('host:sftp:mkdir', request),
  deleteHostFile: (request: { hostId: string; path: string }) =>
    ipcRenderer.invoke('host:sftp:delete', request),
  listHostDocker: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:docker:list', request),
  getHostDockerLogs: (request: { hostId: string; containerId: string; tail?: number }) =>
    ipcRenderer.invoke('host:docker:logs', request),
  hostDockerAction: (request: { hostId: string; containerId: string; action: string }) =>
    ipcRenderer.invoke('host:docker:action', request),
  getHostDockerStats: (request: { hostId: string; containerId: string }) =>
    ipcRenderer.invoke('host:docker:stats', request),
  listHostDockerImages: (request: { hostId: string }) =>
    ipcRenderer.invoke('host:docker:images', request),

  // Index
  getIndexStatus: () => ipcRenderer.invoke('index:status'),
  reindex: () => ipcRenderer.invoke('index:reindex'),
  searchIndex: (request: { query: string; topK?: number }) =>
    ipcRenderer.invoke('index:search', request),
  onIndexProgress: (callback: (payload: { status: string; fileCount: number; currentFile: string; error?: string }) => void) => {
    const handler = (_: unknown, payload: { status: string; fileCount: number; currentFile: string; error?: string }) => callback(payload)
    ipcRenderer.on('index:progress', handler)
    return () => ipcRenderer.removeListener('index:progress', handler)
  },

  // Browser
  navigateBrowser: (url: string) => ipcRenderer.invoke('browser:navigate', { url }),
  screenshotBrowser: () => ipcRenderer.invoke('browser:take_screenshot'),
  closeBrowser: () => ipcRenderer.invoke('browser:close'),
  onBrowserScreenshot: (callback: (payload: { url: string; base64: string; timestamp: number }) => void) => {
    const handler = (_: unknown, payload: { url: string; base64: string; timestamp: number }) => callback(payload)
    ipcRenderer.on('browser:screenshot', handler)
    return () => ipcRenderer.removeListener('browser:screenshot', handler)
  },
  onBrowserStatus: (callback: (payload: { running: boolean; url: string | null }) => void) => {
    const handler = (_: unknown, payload: { running: boolean; url: string | null }) => callback(payload)
    ipcRenderer.on('browser:status', handler)
    return () => ipcRenderer.removeListener('browser:status', handler)
  },

  // Relay
  connectRelay: (request: { token: string }) => ipcRenderer.invoke('relay:connect', request),
  disconnectRelay: () => ipcRenderer.invoke('relay:disconnect'),
  onRelayStatus: (callback: (payload: { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }) => void) => {
    const handler = (_: unknown, payload: { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }) => callback(payload)
    ipcRenderer.on('relay:status', handler)
    return () => ipcRenderer.removeListener('relay:status', handler)
  },
  getRelayQrCode: (request?: { token: string }) =>
    ipcRenderer.invoke('relay:qrcode', request ?? {}),
  getRelayStatus: () =>
    ipcRenderer.invoke('relay:get_status'),

  // MCP
  listMcpServers: (): Promise<Array<{ name: string; transport: string; connected: boolean }>> =>
    ipcRenderer.invoke('mcp:list_servers'),
  addMcpServer: (request: { name: string; command?: string; args?: string[]; url?: string; transport: 'stdio' | 'sse' }): Promise<void> =>
    ipcRenderer.invoke('mcp:add_server', request),
  removeMcpServer: (request: { name: string }): Promise<void> =>
    ipcRenderer.invoke('mcp:remove_server', request),
  listMcpTools: (): Promise<Array<{ name: string; description: string; serverName: string }>> =>
    ipcRenderer.invoke('mcp:list_tools'),

  // Skills
  listSkills: (): Promise<import('../shared/types-skill').SkillInfo[]> =>
    ipcRenderer.invoke('skill:list'),
  getSkillPrompt: (request: { name: string; args: string }): Promise<string | null> =>
    ipcRenderer.invoke('skill:get-prompt', request),
  reloadSkills: (): Promise<void> =>
    ipcRenderer.invoke('skill:reload'),
  invokeSkill: (request: { name: string; args: string }): Promise<{ content: string } | { error: string }> =>
    ipcRenderer.invoke('skill:invoke', request),

  // Tools list
  listTools: (): Promise<Array<{ name: string; description: string; isReadOnly: boolean; requiresApproval: boolean }>> =>
    ipcRenderer.invoke('tools:list'),

  // Plugins
  listPlugins: (): Promise<import('../shared/types-plugin').PluginInfo[]> =>
    ipcRenderer.invoke('plugin:list'),
  getPlugin: (request: { name: string }): Promise<import('../shared/types-plugin').PluginInfo | null> =>
    ipcRenderer.invoke('plugin:get', request),
  installPlugin: (request: { path: string; scope?: import('../shared/types-plugin').PluginScope }): Promise<{ success: boolean; message: string; pluginName?: string }> =>
    ipcRenderer.invoke('plugin:install', request),
  uninstallPlugin: (request: { name: string }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('plugin:uninstall', request),
  enablePlugin: (request: { name: string }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('plugin:enable', request),
  disablePlugin: (request: { name: string }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('plugin:disable', request),
  reloadPlugins: (): Promise<void> =>
    ipcRenderer.invoke('plugin:reload'),
  getPluginSkills: (request?: { pluginName?: string }): Promise<import('../shared/types-skill').SkillInfo[]> =>
    ipcRenderer.invoke('plugin:get-skills', request ?? {}),
  installPluginFromSource: (request: { source: import('../shared/types-plugin').MarketplacePluginSource; scope?: import('../shared/types-plugin').PluginScope }): Promise<import('../shared/types-plugin').PluginInstallResult> =>
    ipcRenderer.invoke('plugin:install-from-source', request),
  getPluginOutputStyles: (): Promise<{ css: string; styleNames: string[] }> =>
    ipcRenderer.invoke('plugin:get-output-styles'),
  getPluginUserConfig: (request: { pluginName: string }): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('plugin:get-user-config', request),
  setPluginUserConfig: (request: { pluginName: string; values: Record<string, unknown> }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke('plugin:set-user-config', request),
  searchPluginMarketplace: (request?: { query?: string }): Promise<import('../shared/types-plugin').MarketplacePluginDisplay[]> =>
    ipcRenderer.invoke('plugin:search_marketplace', request ?? {}),

  // Permission request listener (local desktop permission system)
  onPermissionRequest: (callback: (payload: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => void) => {
    const handler = (_: unknown, payload: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => callback(payload)
    ipcRenderer.on('agent:permission_request', handler)
    return () => ipcRenderer.removeListener('agent:permission_request', handler)
  },
  sendPermissionResponse: (response: { approved: boolean; sessionCache: boolean }) =>
    ipcRenderer.invoke('agent:permission_response', response),

  // Data sync notification
  onDataChanged: (callback: (payload: { source: string; entity: string; action: string; data: unknown }) => void) => {
    const handler = (_: unknown, payload: { source: string; entity: string; action: string; data: unknown }) => callback(payload)
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
}

contextBridge.exposeInMainWorld('wzxclaw', api)
