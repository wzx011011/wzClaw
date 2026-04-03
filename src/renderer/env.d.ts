import type { FileTreeNode, EditorTab } from '../shared/types'

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
      saveFile: (request: { filePath: string; content: string }) => Promise<void>
      getWorkspaceStatus: () => Promise<{ rootPath: string | null; isWatching: boolean }>
      onFileChanged: (cb: (p: { filePath: string; changeType: string }) => void) => () => void
      // Settings
      getSettings: () => Promise<{ provider: string; model: string; hasApiKey: boolean; baseURL?: string; systemPrompt?: string }>
      updateSettings: (request: Record<string, unknown>) => Promise<void>
    }
  }
}
export {}
