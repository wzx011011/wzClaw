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

  // Files (stubs for Phase 3)
  openFile: (request: { path: string }) => ipcRenderer.invoke('file:open', request),
  saveFile: (request: { path: string; content: string }) => ipcRenderer.invoke('file:save', request),
  onFileChanged: (callback: (payload: { path: string; content: string }) => void) => {
    const handler = (_: unknown, payload: { path: string; content: string }) => callback(payload)
    ipcRenderer.on('file:changed', handler)
    return () => ipcRenderer.removeListener('file:changed', handler)
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (request: Record<string, unknown>) => ipcRenderer.invoke('settings:update', request),
}

contextBridge.exposeInMainWorld('wzxclaw', api)
