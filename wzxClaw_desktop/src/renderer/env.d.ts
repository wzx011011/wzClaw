import type { FileTreeNode, SessionMeta, AgentStep, Task } from '../shared/types'

declare global {
  interface Window {
    wzxclaw: {
      // Agent
      sendMessage: (request: { conversationId: string; content: string; activeTaskId?: string }) => Promise<void>
      stopGeneration: () => Promise<void>
      // Stream listeners
      onStreamText: (cb: (p: { content: string }) => void) => () => void
      onStreamThinking: (cb: (p: { content: string }) => void) => () => void
      onStreamToolStart: (cb: (p: { id: string; name: string; input?: Record<string, unknown> }) => void) => () => void
      onStreamToolResult: (cb: (p: { id: string; output: string; isError: boolean; toolName: string }) => void) => () => void
      onStreamEnd: (cb: (p: { usage: { inputTokens: number; outputTokens: number } }) => void) => () => void
      onStreamTurnEnd: (cb: () => void) => () => void
      onStreamError: (cb: (p: { error: string }) => void) => () => void
      onStreamRetrying: (cb: (p: { attempt: number; maxAttempts: number; delayMs: number }) => void) => () => void
      onSubStreamToolStart: (cb: (p: { parentToolCallId: string; id: string; name: string; input?: Record<string, unknown> }) => void) => () => void
      onSubStreamToolResult: (cb: (p: { parentToolCallId: string; id: string; output: string; isError: boolean }) => void) => () => void
      onSubStreamText: (cb: (p: { parentToolCallId: string; content: string }) => void) => () => void
      // Workspace
      openFolder: () => Promise<{ rootPath: string } | null>
      setFolder: (request: { folderPath: string }) => Promise<{ rootPath: string } | null>
      getDirectoryTree: (request: { dirPath?: string; depth?: number }) => Promise<FileTreeNode[]>
      readFile: (request: { filePath: string }) => Promise<{ content: string; language: string }>
      readFileContent: (request: { filePath: string }) => Promise<{ content: string; size: number; path: string } | { error: string; size: number; limit: number }>
      readFolderTree: (request: { dirPath: string }) => Promise<{ tree: string; fileCount: number; path: string } | { error: string }>
      saveFile: (request: { filePath: string; content: string }) => Promise<void>
      renameFile: (request: { oldPath: string; newPath: string }) => Promise<{ success: boolean }>
      deleteFile: (request: { filePath: string }) => Promise<{ success: boolean }>
      createFile: (request: { dirPath: string; name: string; type: 'file' | 'directory' }) => Promise<{ success: boolean; filePath: string }>
      getWorkspaceStatus: () => Promise<{ rootPath: string | null; isWatching: boolean }>
      onFileChanged: (cb: (p: { filePath: string; changeType: string }) => void) => () => void
      // Permissions
      onPermissionRequest: (cb: (p: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => void) => () => void
      sendPermissionResponse: (response: { approved: boolean; sessionCache: boolean }) => Promise<void>
      // Settings
      getSettings: () => Promise<{ provider: string; model: string; hasApiKey: boolean; baseURL?: string; systemPrompt?: string; relayToken?: string; thinkingDepth?: string }>
      updateSettings: (request: Record<string, unknown>) => Promise<void>
      // Sessions
      listSessions: (request?: { activeTaskId?: string }) => Promise<SessionMeta[]>
      loadSession: (request: { sessionId: string }) => Promise<unknown[]>
      deleteSession: (request: { sessionId: string }) => Promise<{ success: boolean }>
      renameSession: (request: { sessionId: string; title: string }) => Promise<{ success: boolean }>
      duplicateSession: (request: { sessionId: string; activeTaskId?: string }) => Promise<{ newSessionId: string }>
      saveLastSession: (request: { sessionId: string }) => Promise<void>
      getLastSession: () => Promise<{ sessionId: string | null }>
      onSessionRestore: (cb: (p: { sessionId: string }) => void) => () => void
      onSessionCompacted: (cb: (p: { beforeTokens: number; afterTokens: number; auto: boolean }) => void) => () => void
      onSessionContextRestored: (cb: (p: { sessionId: string; messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }) => void) => () => void
      compactContext: () => Promise<{ beforeTokens: number; afterTokens: number } | null>
      // Diff
      applyHunk: (request: { filePath: string; hunksToApply: string[]; modifiedContent: string }) => Promise<{ success: boolean }>
      // Terminal
      createTerminal: (request: { cwd: string }) => Promise<{ terminalId: string }>
      killTerminal: (request: { terminalId: string }) => Promise<void>
      terminalInput: (request: { terminalId: string; data: string }) => Promise<void>
      terminalResize: (request: { terminalId: string; cols: number; rows: number }) => Promise<void>
      terminalOutput: (request: { terminalId: string }) => Promise<{ buffer: string }>
      onTerminalData: (cb: (p: { terminalId: string; data: string }) => void) => () => void
      // Symbol navigation
      onSymbolQuery: (cb: (p: { queryId: string; operation: string; params: Record<string, unknown> }) => void) => () => void
      sendSymbolResult: (response: { queryId: string; result: unknown; isError: boolean }) => void
      // Steps
      listSteps: () => Promise<AgentStep[]>
      onStepCreated: (cb: (p: AgentStep) => void) => () => void
      onStepUpdated: (cb: (p: AgentStep) => void) => () => void
      // Tasks
      listTasks: (request?: { includeArchived?: boolean }) => Promise<Task[]>
      getTask: (request: { taskId: string }) => Promise<Task | null>
      createTask: (request: { title: string; description?: string }) => Promise<Task>
      updateTask: (request: { taskId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string; progressSummary?: string } }) => Promise<Task>
      deleteTask: (request: { taskId: string }) => Promise<void>
      addTaskProject: (request: { taskId: string; folderPath: string }) => Promise<Task>
      removeTaskProject: (request: { taskId: string; projectId: string }) => Promise<Task>
      // Index
      getIndexStatus: () => Promise<{ status: string; fileCount: number; currentFile: string; error?: string }>
      reindex: () => Promise<void>
      searchIndex: (request: { query: string; topK?: number }) => Promise<Array<{ filePath: string; startLine: number; endLine: number; content: string; score: number }>>
      onIndexProgress: (cb: (p: { status: string; fileCount: number; currentFile: string; error?: string }) => void) => () => void
      // Browser
      navigateBrowser: (url: string) => Promise<{ title: string }>
      screenshotBrowser: () => Promise<{ base64: string }>
      closeBrowser: () => Promise<void>
      onBrowserScreenshot: (cb: (p: { url: string; base64: string; timestamp: number }) => void) => () => void
      onBrowserStatus: (cb: (p: { running: boolean; url: string | null }) => void) => () => void
      // Relay
      connectRelay: (request: { token: string }) => Promise<void>
      disconnectRelay: () => Promise<void>
      onRelayStatus: (cb: (p: { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null; mobiles: Array<{ deviceId: string; name: string | null; platform: string | null; osVersion: string | null; appVersion: string | null; connectedAt: number }> }) => void) => () => void
      getRelayQrCode: (request?: { token: string }) => Promise<{ qrCode: string }>
      getRelayStatus: () => Promise<{ connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null; mobiles: Array<{ deviceId: string; name: string | null; platform: string | null; osVersion: string | null; appVersion: string | null; connectedAt: number }> }>
      // Mobile user message (relay/mobile -> renderer)
      onMobileUserMessage: (cb: (p: { content: string; source: 'mobile' }) => void) => () => void
      // Permission mode
      getPermissionMode: () => Promise<{ mode: string }>
      setPermissionMode: (request: { mode: string }) => Promise<void>
      setTitleBarOverlay: (request: { color: string; symbolColor: string }) => Promise<void>
      // Plan mode
      onPlanModeEntered: (cb: () => void) => () => void
      onPlanModeExited: (cb: (p: { plan: string }) => void) => () => void
      sendPlanDecision: (request: { approved: boolean }) => Promise<void>
      // File history / revert
      getFileHistory: (request: { filePath: string }) => Promise<Array<{ toolCallId: string; timestamp: number; filePath: string }>>
      revertFile: (request: { toolCallId: string }) => Promise<{ success: boolean; error?: string }>
      // AskUserQuestion (Phase 4.2)
      onAskUserQuestion: (cb: (p: { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }) => void) => () => void
      answerUserQuestion: (payload: { questionId: string; selectedLabels: string[]; customText?: string }) => Promise<void>
      // Usage / cost tracking (Phase 4.4)
      onUsageUpdate: (cb: (p: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUSD: number; model: string }) => void) => () => void
      // Todo panel
      onTodoUpdated: (cb: (p: { todos: Array<{ content: string; status: string; activeForm: string }> }) => void) => () => void
      // Shell utilities
      openInExplorer: (folderPath: string) => Promise<void>
      getExtensionPaths: () => Promise<{ commandsDir: string; skillsDir: string }>
      // Insights
      generateInsights: () => Promise<{ summary: string; htmlPath: string; totalSessions: number; totalCostUSD: number }>
      onInsightsProgress: (cb: (p: { stage: string; current: number; total: number; message: string }) => void) => () => void
      // Context breakdown
      getContextBreakdown: () => Promise<import('../shared/types').ContextBreakdownResponse>
      // Data changed notification (mobile <-> desktop sync)
      onDataChanged: (cb: (p: { source: string; entity: string; action: string; data: unknown }) => void) => () => void
    }
  }
}
export {}
