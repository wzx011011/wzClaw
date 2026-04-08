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

  // Session compacted stream listener
  onSessionCompacted: (callback: (payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => void) => {
    const handler = (_: unknown, payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => callback(payload)
    ipcRenderer.on('session:compacted', handler)
    return () => ipcRenderer.removeListener('session:compacted', handler)
  },

  // Compact context (manual trigger via /compact command)
  compactContext: () => ipcRenderer.invoke('agent:compact_context'),
}

contextBridge.exposeInMainWorld('wzxclaw', api)
