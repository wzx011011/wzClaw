import { contextBridge, ipcRenderer } from 'electron'
import type { AgentTask } from '../shared/types'

const api = {
  // Agent
  sendMessage: (request: { conversationId: string; content: string }) =>
    ipcRenderer.invoke('agent:send_message', request),
  stopGeneration: () => ipcRenderer.invoke('agent:stop'),

  // Stream listeners — return unsubscribe functions
  onStreamText: (callback: (payload: { content: string }) => void) => {
    const handler = (_: unknown, payload: { content: string }) => callback(payload)
    ipcRenderer.on('stream:text_delta', handler)
    return () => ipcRenderer.removeListener('stream:text_delta', handler)
  },
  onStreamToolStart: (callback: (payload: { id: string; name: string }) => void) => {
    const handler = (_: unknown, payload: { id: string; name: string }) => callback(payload)
    ipcRenderer.on('stream:tool_use_start', handler)
    return () => ipcRenderer.removeListener('stream:tool_use_start', handler)
  },
  onStreamToolResult: (callback: (payload: { id: string; output: string; isError: boolean }) => void) => {
    const handler = (_: unknown, payload: { id: string; output: string; isError: boolean }) => callback(payload)
    ipcRenderer.on('stream:tool_use_end', handler)
    return () => ipcRenderer.removeListener('stream:tool_use_end', handler)
  },
  onStreamEnd: (callback: (payload: { usage: { inputTokens: number; outputTokens: number } }) => void) => {
    const handler = (_: unknown, payload: { usage: { inputTokens: number; outputTokens: number } }) => callback(payload)
    ipcRenderer.on('stream:done', handler)
    return () => ipcRenderer.removeListener('stream:done', handler)
  },
  onStreamError: (callback: (payload: { error: string }) => void) => {
    const handler = (_: unknown, payload: { error: string }) => callback(payload)
    ipcRenderer.on('stream:error', handler)
    return () => ipcRenderer.removeListener('stream:error', handler)
  },
  onStreamRetrying: (callback: (payload: { attempt: number; maxAttempts: number; delayMs: number }) => void) => {
    const handler = (_: unknown, payload: { attempt: number; maxAttempts: number; delayMs: number }) => callback(payload)
    ipcRenderer.on('stream:retrying', handler)
    return () => ipcRenderer.removeListener('stream:retrying', handler)
  },

  // Workspace
  openFolder: () => ipcRenderer.invoke('workspace:open_folder'),
  getDirectoryTree: (request: { dirPath?: string; depth?: number }) =>
    ipcRenderer.invoke('workspace:get_tree', request),
  getWorkspaceStatus: () => ipcRenderer.invoke('workspace:status'),

  // File operations
  readFile: (request: { filePath: string }) => ipcRenderer.invoke('file:read', request),
  readFileContent: (request: { filePath: string }) => ipcRenderer.invoke('file:read-content', request),
  readFolderTree: (request: { dirPath: string }) => ipcRenderer.invoke('file:read-folder-tree', request),
  saveFile: (request: { filePath: string; content: string }) => ipcRenderer.invoke('file:save', request),
  renameFile: (request: { oldPath: string; newPath: string }) => ipcRenderer.invoke('file:rename', request),
  deleteFile: (request: { filePath: string }) => ipcRenderer.invoke('file:delete', request),

  // File change listener — returns unsubscribe function
  onFileChanged: (callback: (payload: { filePath: string; changeType: string }) => void) => {
    const handler = (_: unknown, payload: { filePath: string; changeType: string }) => callback(payload)
    ipcRenderer.on('file:changed', handler)
    return () => ipcRenderer.removeListener('file:changed', handler)
  },

  // Permission request listener — returns unsubscribe function (per D-64, D-65)
  onPermissionRequest: (callback: (payload: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => void) => {
    const handler = (_: unknown, payload: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => callback(payload)
    ipcRenderer.on('agent:permission_request', handler)
    return () => ipcRenderer.removeListener('agent:permission_request', handler)
  },
  sendPermissionResponse: (response: { approved: boolean; sessionCache: boolean }) =>
    ipcRenderer.invoke('agent:permission_response', response),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (request: Record<string, unknown>) => ipcRenderer.invoke('settings:update', request),

  // Sessions
  listSessions: () => ipcRenderer.invoke('session:list'),
  loadSession: (request: { sessionId: string }) => ipcRenderer.invoke('session:load', request),
  deleteSession: (request: { sessionId: string }) => ipcRenderer.invoke('session:delete', request),
  renameSession: (request: { sessionId: string; title: string }) => ipcRenderer.invoke('session:rename', request),

  // Session compacted stream listener
  onSessionCompacted: (callback: (payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => void) => {
    const handler = (_: unknown, payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => callback(payload)
    ipcRenderer.on('session:compacted', handler)
    return () => ipcRenderer.removeListener('session:compacted', handler)
  },

  // Compact context (manual trigger via /compact command)
  compactContext: () => ipcRenderer.invoke('agent:compact_context'),

  // Diff: apply accepted hunks to disk
  applyHunk: (request: { filePath: string; hunksToApply: string[]; modifiedContent: string }) =>
    ipcRenderer.invoke('file:apply-hunk', request),

  // Terminal
  createTerminal: (request: { cwd: string }) => ipcRenderer.invoke('terminal:create', request),
  killTerminal: (request: { terminalId: string }) => ipcRenderer.invoke('terminal:kill', request),
  terminalInput: (request: { terminalId: string; data: string }) => ipcRenderer.invoke('terminal:input', request),
  terminalResize: (request: { terminalId: string; cols: number; rows: number }) => ipcRenderer.invoke('terminal:resize', request),
  terminalOutput: (request: { terminalId: string }) => ipcRenderer.invoke('terminal:output', request),
  onTerminalData: (callback: (payload: { terminalId: string; data: string }) => void) => {
    const handler = (_: unknown, payload: { terminalId: string; data: string }) => callback(payload)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  // Symbol navigation (main -> renderer query, renderer -> main result)
  onSymbolQuery: (callback: (payload: { queryId: string; operation: string; params: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, payload: { queryId: string; operation: string; params: Record<string, unknown> }) => callback(payload)
    ipcRenderer.on('symbol:query', handler)
    return () => ipcRenderer.removeListener('symbol:query', handler)
  },
  sendSymbolResult: (response: { queryId: string; result: unknown; isError: boolean }) =>
    ipcRenderer.send('symbol:result', response),

  // Tasks
  listTasks: () => ipcRenderer.invoke('task:list'),
  onTaskCreated: (callback: (payload: AgentTask) => void) => {
    const handler = (_: unknown, payload: AgentTask) => callback(payload)
    ipcRenderer.on('task:created', handler)
    return () => ipcRenderer.removeListener('task:created', handler)
  },
  onTaskUpdated: (callback: (payload: AgentTask) => void) => {
    const handler = (_: unknown, payload: AgentTask) => callback(payload)
    ipcRenderer.on('task:updated', handler)
    return () => ipcRenderer.removeListener('task:updated', handler)
  },

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

  // Mobile
  startMobileServer: () => ipcRenderer.invoke('mobile:start'),
  stopMobileServer: () => ipcRenderer.invoke('mobile:stop'),
  onMobileStatus: (callback: (payload: { running: boolean; port: number | null; localUrl: string | null; tunnelUrl: string | null; clients: Array<{ id: string; userAgent: string; connectedAt: number }> }) => void) => {
    const handler = (_: unknown, payload: any) => callback(payload)
    ipcRenderer.on('mobile:status', handler)
    return () => ipcRenderer.removeListener('mobile:status', handler)
  },

  // Relay
  connectRelay: (request: { token: string }) => ipcRenderer.invoke('relay:connect', request),
  disconnectRelay: () => ipcRenderer.invoke('relay:disconnect'),
  onRelayStatus: (callback: (payload: { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }) => void) => {
    const handler = (_: unknown, payload: any) => callback(payload)
    ipcRenderer.on('relay:status', handler)
    return () => ipcRenderer.removeListener('relay:status', handler)
  },
  getRelayQrCode: (request?: { token: string }) =>
    ipcRenderer.invoke('relay:qrcode', request ?? {}),
  getRelayStatus: () =>
    ipcRenderer.invoke('relay:get_status'),

  // Mobile user message (relay/mobile -> renderer)
  onMobileUserMessage: (callback: (payload: { content: string; source: 'mobile' }) => void) => {
    const handler = (_: unknown, payload: { content: string; source: 'mobile' }) => callback(payload)
    ipcRenderer.on('stream:mobile_user_message', handler)
    return () => ipcRenderer.removeListener('stream:mobile_user_message', handler)
  },

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
}

contextBridge.exposeInMainWorld('wzxclaw', api)
