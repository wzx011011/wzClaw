import { contextBridge, ipcRenderer } from 'electron'

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
}

contextBridge.exposeInMainWorld('wzxclaw', api)
