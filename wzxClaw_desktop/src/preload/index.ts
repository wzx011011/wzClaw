import { contextBridge, ipcRenderer } from 'electron'
import type { AgentStep, Workspace } from '../shared/types'

const api = {
  // Agent
  sendMessage: (request: { conversationId: string; content: string; activeWorkspaceId?: string }) =>
    ipcRenderer.invoke('agent:send_message', request),
  stopGeneration: () => ipcRenderer.invoke('agent:stop'),

  // Stream listeners — return unsubscribe functions
  onStreamText: (callback: (payload: { content: string }) => void) => {
    const handler = (_: unknown, payload: { content: string }) => callback(payload)
    ipcRenderer.on('stream:text_delta', handler)
    return () => ipcRenderer.removeListener('stream:text_delta', handler)
  },
  onStreamThinking: (callback: (payload: { content: string }) => void) => {
    const handler = (_: unknown, payload: { content: string }) => callback(payload)
    ipcRenderer.on('stream:thinking_delta', handler)
    return () => ipcRenderer.removeListener('stream:thinking_delta', handler)
  },
  onStreamToolStart: (callback: (payload: { id: string; name: string; input?: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, payload: { id: string; name: string; input?: Record<string, unknown> }) => callback(payload)
    ipcRenderer.on('stream:tool_use_start', handler)
    return () => ipcRenderer.removeListener('stream:tool_use_start', handler)
  },
  onStreamToolResult: (callback: (payload: { id: string; output: string; isError: boolean; toolName: string }) => void) => {
    const handler = (_: unknown, payload: { id: string; output: string; isError: boolean; toolName: string }) => callback(payload)
    ipcRenderer.on('stream:tool_use_end', handler)
    return () => ipcRenderer.removeListener('stream:tool_use_end', handler)
  },
  onStreamEnd: (callback: (payload: { usage: { inputTokens: number; outputTokens: number } }) => void) => {
    const handler = (_: unknown, payload: { usage: { inputTokens: number; outputTokens: number } }) => callback(payload)
    ipcRenderer.on('stream:done', handler)
    return () => ipcRenderer.removeListener('stream:done', handler)
  },
  onStreamTurnEnd: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('stream:turn_end', handler)
    return () => ipcRenderer.removeListener('stream:turn_end', handler)
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
  onSubStreamToolStart: (callback: (payload: { parentToolCallId: string; id: string; name: string; input?: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, payload: { parentToolCallId: string; id: string; name: string; input?: Record<string, unknown> }) => callback(payload)
    ipcRenderer.on('stream:sub_tool_use_start', handler)
    return () => ipcRenderer.removeListener('stream:sub_tool_use_start', handler)
  },
  onSubStreamToolResult: (callback: (payload: { parentToolCallId: string; id: string; output: string; isError: boolean }) => void) => {
    const handler = (_: unknown, payload: { parentToolCallId: string; id: string; output: string; isError: boolean }) => callback(payload)
    ipcRenderer.on('stream:sub_tool_use_end', handler)
    return () => ipcRenderer.removeListener('stream:sub_tool_use_end', handler)
  },
  onSubStreamText: (callback: (payload: { parentToolCallId: string; content: string }) => void) => {
    const handler = (_: unknown, payload: { parentToolCallId: string; content: string }) => callback(payload)
    ipcRenderer.on('stream:sub_text', handler)
    return () => ipcRenderer.removeListener('stream:sub_text', handler)
  },

  // Workspace
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
  renameFile: (request: { oldPath: string; newPath: string }) => ipcRenderer.invoke('file:rename', request),
  deleteFile: (request: { filePath: string }) => ipcRenderer.invoke('file:delete', request),
  createFile: (request: { dirPath: string; name: string; type: 'file' | 'directory' }) => ipcRenderer.invoke('file:create', request),

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
  listSessions: (request?: { activeWorkspaceId?: string }) => ipcRenderer.invoke('session:list', request),
  loadSession: (request: { sessionId: string; activeWorkspaceId?: string }) => ipcRenderer.invoke('session:load', request),
  loadSessionTail: (request: { sessionId: string; tailCount: number; activeWorkspaceId?: string }) => ipcRenderer.invoke('session:load-tail', request),
  deleteSession: (request: { sessionId: string }) => ipcRenderer.invoke('session:delete', request),
  renameSession: (request: { sessionId: string; title: string }) => ipcRenderer.invoke('session:rename', request),
  duplicateSession: (request: { sessionId: string; activeWorkspaceId?: string }) => ipcRenderer.invoke('session:duplicate', request),
  saveLastSession: (request: { sessionId: string }) => ipcRenderer.invoke('session:save-last', request),
  getLastSession: (): Promise<{ sessionId: string | null }> => ipcRenderer.invoke('session:get-last'),
  onSessionRestore: (callback: (payload: { sessionId: string }) => void) => {
    const handler = (_: unknown, payload: { sessionId: string }) => callback(payload)
    ipcRenderer.on('session:restore', handler)
    return () => ipcRenderer.removeListener('session:restore', handler)
  },

  // Session compacted stream listener
  onSessionCompacted: (callback: (payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => void) => {
    const handler = (_: unknown, payload: { beforeTokens: number; afterTokens: number; auto: boolean }) => callback(payload)
    ipcRenderer.on('session:compacted', handler)
    return () => ipcRenderer.removeListener('session:compacted', handler)
  },

  // Session context restored — fires after session:load restores the agent loop (Phase 3.4)
  onSessionContextRestored: (callback: (payload: { sessionId: string; messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }) => void) => {
    const handler = (_: unknown, payload: { sessionId: string; messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }) => callback(payload)
    ipcRenderer.on('session:context-restored', handler)
    return () => ipcRenderer.removeListener('session:context-restored', handler)
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

  // Steps
  listSteps: () => ipcRenderer.invoke('step:list'),
  onStepCreated: (callback: (payload: AgentStep) => void) => {
    const handler = (_: unknown, payload: AgentStep) => callback(payload)
    ipcRenderer.on('step:created', handler)
    return () => ipcRenderer.removeListener('step:created', handler)
  },
  onStepUpdated: (callback: (payload: AgentStep) => void) => {
    const handler = (_: unknown, payload: AgentStep) => callback(payload)
    ipcRenderer.on('step:updated', handler)
    return () => ipcRenderer.removeListener('step:updated', handler)
  },

  // Tasks — top-level user work units
  listWorkspaces: (request?: { includeArchived?: boolean }): Promise<Workspace[]> =>
    ipcRenderer.invoke('workspace:list', request),
  getWorkspace: (request: { taskId: string }): Promise<Workspace | null> =>
    ipcRenderer.invoke('workspace:get', request),
  createWorkspace: (request: { title: string; description?: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:create', request),
  updateWorkspace: (request: { taskId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string } }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:update', request),
  deleteWorkspace: (request: { taskId: string }): Promise<void> =>
    ipcRenderer.invoke('workspace:delete', request),
  addTaskProject: (request: { taskId: string; folderPath: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:add-project', request),
  removeTaskProject: (request: { taskId: string; projectId: string }): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:remove-project', request),

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

  // Theme: update native titlebar overlay colors
  setTitleBarOverlay: (request: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke('theme:set-titlebar-overlay', request),

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

  // File history / revert (Phase 3.3)
  getFileHistory: (request: { filePath: string }) =>
    ipcRenderer.invoke('file:get-history', request),
  revertFile: (request: { toolCallId: string }) =>
    ipcRenderer.invoke('file:revert', request),

  // AskUserQuestion — main pushes question, renderer invokes answer (Phase 4.2)
  onAskUserQuestion: (callback: (payload: { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }) => void) => {
    const handler = (_: unknown, payload: { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }) => callback(payload)
    ipcRenderer.on('ask-user:question', handler)
    return () => ipcRenderer.removeListener('ask-user:question', handler)
  },
  answerUserQuestion: (payload: { questionId: string; selectedLabels: string[]; customText?: string }) =>
    ipcRenderer.invoke('ask-user:answer', payload),

  // TodoWrite — session task list updates (main -> renderer)
  onTodoUpdated: (callback: (payload: { todos: Array<{ content: string; status: string; activeForm: string }> }) => void) => {
    const handler = (_: unknown, payload: { todos: Array<{ content: string; status: string; activeForm: string }> }) => callback(payload)
    ipcRenderer.on('todo:updated', handler)
    return () => ipcRenderer.removeListener('todo:updated', handler)
  },

  // Shell utility — open a directory in the OS file manager
  openInExplorer: (folderPath: string) =>
    ipcRenderer.invoke('shell:open_path', { path: folderPath }),
  getExtensionPaths: (): Promise<{ commandsDir: string; skillsDir: string }> =>
    ipcRenderer.invoke('shell:get_extension_paths'),

  // Usage / cost tracking (Phase 4.4) — main pushes updates after each LLM response
  onUsageUpdate: (callback: (payload: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUSD: number; model: string }) => void) => {
    const handler = (_: unknown, payload: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUSD: number; model: string }) => callback(payload)
    ipcRenderer.on('usage:update', handler)
    return () => ipcRenderer.removeListener('usage:update', handler)
  },

  // Insights — generate session analysis report
  generateInsights: (): Promise<{ summary: string; htmlPath: string; totalSessions: number; totalCostUSD: number }> =>
    ipcRenderer.invoke('insights:generate'),
  onInsightsProgress: (callback: (payload: { stage: string; current: number; total: number; message: string }) => void) => {
    const handler = (_: unknown, payload: { stage: string; current: number; total: number; message: string }) => callback(payload)
    ipcRenderer.on('insights:progress', handler)
    return () => ipcRenderer.removeAllListeners('insights:progress')
  },

  // Context breakdown — returns detailed token usage per category
  getContextBreakdown: (): Promise<import('../shared/types').ContextBreakdownResponse> =>
    ipcRenderer.invoke('agent:context_breakdown'),

  // Data changed notification (mobile <-> desktop sync)
  onDataChanged: (callback: (payload: { source: string; entity: string; action: string; data: unknown }) => void) => {
    const handler = (_: unknown, payload: { source: string; entity: string; action: string; data: unknown }) => callback(payload)
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
}

contextBridge.exposeInMainWorld('wzxclaw', api)
