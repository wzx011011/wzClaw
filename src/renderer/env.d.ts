import type { FileTreeNode, SessionMeta } from '../shared/types'

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
      // Workspace
      openFolder: () => Promise<{ rootPath: string } | null>
      getDirectoryTree: (request: { dirPath?: string; depth?: number }) => Promise<FileTreeNode[]>
      readFile: (request: { filePath: string }) => Promise<{ content: string; language: string }>
      readFileContent: (request: { filePath: string }) => Promise<{ content: string; size: number; path: string } | { error: string; size: number; limit: number }>
      readFolderTree: (request: { dirPath: string }) => Promise<{ tree: string; fileCount: number; path: string } | { error: string }>
      saveFile: (request: { filePath: string; content: string }) => Promise<void>
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
    }
  }
}
export {}
