import type { FileTreeNode, SessionMeta, AgentStep } from '../shared/types'

declare global {
  interface Window {
    wzxclaw: {
      // Agent
      sendMessage: (request: { conversationId: string; content: string }) => Promise<void>
      stopGeneration: () => Promise<void>
      // Stream listeners
      onStreamText: (cb: (p: { content: string }) => void) => () => void
      onStreamToolStart: (cb: (p: { id: string; name: string }) => void) => () => void
      onStreamToolResult: (cb: (p: { id: string; output: string; isError: boolean }) => void) => () => void
      onStreamEnd: (cb: (p: { usage: { inputTokens: number; outputTokens: number } }) => void) => () => void
      onStreamError: (cb: (p: { error: string }) => void) => () => void
      onStreamRetrying: (cb: (p: { attempt: number; maxAttempts: number; delayMs: number }) => void) => () => void
      // Workspace
      openFolder: () => Promise<{ rootPath: string } | null>
      getDirectoryTree: (request: { dirPath?: string; depth?: number }) => Promise<FileTreeNode[]>
      readFile: (request: { filePath: string }) => Promise<{ content: string; language: string }>
      readFileContent: (request: { filePath: string }) => Promise<{ content: string; size: number; path: string } | { error: string; size: number; limit: number }>
      readFolderTree: (request: { dirPath: string }) => Promise<{ tree: string; fileCount: number; path: string } | { error: string }>
      saveFile: (request: { filePath: string; content: string }) => Promise<void>
      renameFile: (request: { oldPath: string; newPath: string }) => Promise<{ success: boolean }>
      deleteFile: (request: { filePath: string }) => Promise<{ success: boolean }>
      getWorkspaceStatus: () => Promise<{ rootPath: string | null; isWatching: boolean }>
      onFileChanged: (cb: (p: { filePath: string; changeType: string }) => void) => () => void
      // Permissions
      onPermissionRequest: (cb: (p: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => void) => () => void
      sendPermissionResponse: (response: { approved: boolean; sessionCache: boolean }) => Promise<void>
      // Settings
      getSettings: () => Promise<{ provider: string; model: string; hasApiKey: boolean; baseURL?: string; systemPrompt?: string }>
      updateSettings: (request: Record<string, unknown>) => Promise<void>
      // Sessions
      listSessions: () => Promise<SessionMeta[]>
      loadSession: (request: { sessionId: string }) => Promise<unknown[]>
      deleteSession: (request: { sessionId: string }) => Promise<{ success: boolean }>
      renameSession: (request: { sessionId: string; title: string }) => Promise<{ success: boolean }>
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
      // Mobile
      startMobileServer: () => Promise<{ lanQrCode: string; tunnelQrCode: string | null; localUrl: string; tunnelUrl: string | null; tunnelError: string | null }>
      stopMobileServer: () => Promise<void>
      onMobileStatus: (cb: (p: { running: boolean; port: number | null; localUrl: string | null; tunnelUrl: string | null; clients: Array<{ id: string; userAgent: string; connectedAt: number }> }) => void) => () => void
      // Relay
      connectRelay: (request: { token: string }) => Promise<void>
      disconnectRelay: () => Promise<void>
      onRelayStatus: (cb: (p: { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }) => void) => () => void
      getRelayQrCode: (request?: { token: string }) => Promise<{ qrCode: string }>
      getRelayStatus: () => Promise<{ connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }>
      // Mobile user message (relay/mobile -> renderer)
      onMobileUserMessage: (cb: (p: { content: string; source: 'mobile' }) => void) => () => void
      // Permission mode
      getPermissionMode: () => Promise<{ mode: string }>
      setPermissionMode: (request: { mode: string }) => Promise<void>
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
    }
  }
}
export {}
