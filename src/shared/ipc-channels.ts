import { z } from 'zod'
import { UserMessageSchema, TokenUsageSchema } from './types'
import type { FileTreeNode, SessionMeta } from './types'

// ============================================================
// IPC Channel Name Constants (per D-08, D-10, Pattern 4)
// ============================================================

export const IPC_CHANNELS = {
  // Agent channels (renderer -> main)
  'agent:send_message': 'agent:send_message',
  'agent:stop': 'agent:stop',

  // Stream channels (main -> renderer, fire-and-forget via webContents.send)
  'stream:text_delta': 'stream:text_delta',
  'stream:tool_use_start': 'stream:tool_use_start',
  'stream:tool_use_delta': 'stream:tool_use_delta',
  'stream:tool_use_end': 'stream:tool_use_end',
  'stream:error': 'stream:error',
  'stream:done': 'stream:done',

  // Permission channels (main -> renderer request, renderer -> main response)
  'agent:permission_request': 'agent:permission_request',
  'agent:permission_response': 'agent:permission_response',

  // Settings channels (renderer -> main)
  'settings:get': 'settings:get',
  'settings:update': 'settings:update',

  // Workspace channels (renderer -> main)
  'workspace:open_folder': 'workspace:open_folder',
  'workspace:get_tree': 'workspace:get_tree',
  'workspace:watch': 'workspace:watch',
  'workspace:status': 'workspace:status',

  // File channels (renderer -> main, plus main -> renderer for changes)
  'file:read': 'file:read',
  'file:save': 'file:save',
  'file:changed': 'file:changed',
  'file:read-content': 'file:read-content',
  'file:read-folder-tree': 'file:read-folder-tree',

  // Session channels (renderer -> main)
  'session:list': 'session:list',
  'session:load': 'session:load',
  'session:delete': 'session:delete',
  'session:rename': 'session:rename',

  // Session stream channels (main -> renderer)
  'session:compacted': 'session:compacted',

  // Diff channels (renderer -> main)
  'file:apply-hunk': 'file:apply-hunk',

  // Context channels (renderer -> main)
  'agent:compact_context': 'agent:compact_context',

  // Terminal channels (renderer <-> main)
  'terminal:create': 'terminal:create',
  'terminal:kill': 'terminal:kill',
  'terminal:input': 'terminal:input',
  'terminal:resize': 'terminal:resize',
  'terminal:data': 'terminal:data',
  'terminal:output': 'terminal:output',

  // Symbol navigation channels (main -> renderer query, renderer -> main result)
  'symbol:query': 'symbol:query',
  'symbol:result': 'symbol:result'
} as const

export type IpcChannelName = keyof typeof IPC_CHANNELS

// ============================================================
// Payload Type Maps (per D-10)
// ============================================================

// Request payloads (renderer sends to main via ipcRenderer.invoke)
export interface IpcRequestPayloads {
  'agent:send_message': {
    conversationId: string
    content: string
  }
  'agent:stop': void
  'agent:permission_response': {
    approved: boolean
    sessionCache: boolean
  }
  'settings:get': void
  'settings:update': {
    provider?: string
    model?: string
    apiKey?: string
    baseURL?: string
    systemPrompt?: string
  }
  'workspace:open_folder': void
  'workspace:get_tree': { dirPath?: string; depth?: number }
  'workspace:watch': void
  'workspace:status': void
  'file:read': { filePath: string }
  'file:read-content': { filePath: string }
  'file:read-folder-tree': { dirPath: string }
  'file:save': { filePath: string; content: string }
  'session:list': void
  'session:load': { sessionId: string }
  'session:delete': { sessionId: string }
  'session:rename': { sessionId: string; title: string }
  'file:apply-hunk': { filePath: string; hunksToApply: string[]; modifiedContent: string }
  'agent:compact_context': void
  'terminal:create': { cwd: string }
  'terminal:kill': { terminalId: string }
  'terminal:input': { terminalId: string; data: string }
  'terminal:resize': { terminalId: string; cols: number; rows: number }
  'terminal:output': { terminalId: string }
  'symbol:query': { operation: string; params: Record<string, unknown> }
}
export interface IpcResponsePayloads {
  'agent:send_message': void
  'agent:stop': void
  'settings:get': {
    provider: string
    model: string
    hasApiKey: boolean
    baseURL?: string
    systemPrompt?: string
  }
  'settings:update': void
  'workspace:open_folder': { rootPath: string } | null
  'workspace:get_tree': FileTreeNode[]
  'workspace:watch': void
  'workspace:status': { rootPath: string | null; isWatching: boolean }
  'file:read': { content: string; language: string }
  'file:read-content': { content: string; size: number; path: string } | { error: string; size: number; limit: number }
  'file:read-folder-tree': { tree: string; fileCount: number; path: string } | { error: string }
  'file:save': void
  'session:list': SessionMeta[]
  'session:load': unknown[]
  'session:delete': { success: boolean }
  'session:rename': { success: boolean }
  'file:apply-hunk': { success: boolean }
  'agent:compact_context': { beforeTokens: number; afterTokens: number } | null
  'terminal:create': { terminalId: string }
  'terminal:kill': void
  'terminal:input': void
  'terminal:resize': void
  'terminal:output': { buffer: string }
  'symbol:query': { results: Array<{ filePath: string; line: number; symbolName: string; kind: string }> }
}

// Stream payloads (main sends to renderer via webContents.send)
export interface IpcStreamPayloads {
  'stream:text_delta': { content: string }
  'stream:tool_use_start': { id: string; name: string }
  'stream:tool_use_delta': { id: string; partialJson: string }
  'stream:tool_use_end': { id: string; parsedInput: Record<string, unknown> }
  'stream:error': { error: string }
  'stream:done': { usage: { inputTokens: number; outputTokens: number } }
  'agent:permission_request': {
    toolName: string
    toolInput: Record<string, unknown>
    reason: string
  }
  'file:changed': { filePath: string; changeType: 'created' | 'modified' | 'deleted' }
  'session:compacted': { beforeTokens: number; afterTokens: number; auto: boolean }
  'terminal:data': { terminalId: string; data: string }
  'symbol:query': { queryId: string; operation: string; params: Record<string, unknown> }
  'symbol:result': { queryId: string; result: unknown; isError: boolean }
}

// ============================================================
// Zod Schemas for IPC Validation (per D-09)
// ============================================================

export const IpcSchemas = {
  'agent:send_message': {
    request: z.object({
      conversationId: z.string(),
      content: z.string().min(1)
    }),
    response: z.undefined()
  },
  'file:read-content': {
    request: z.object({
      filePath: z.string().min(1)
    }),
    response: z.union([
      z.object({
        content: z.string(),
        size: z.number(),
        path: z.string()
      }),
      z.object({
        error: z.string(),
        size: z.number(),
        limit: z.number()
      })
    ])
  },
  'file:read-folder-tree': {
    request: z.object({
      dirPath: z.string().min(1)
    }),
    response: z.union([
      z.object({
        tree: z.string(),
        fileCount: z.number(),
        path: z.string()
      }),
      z.object({
        error: z.string()
      })
    ])
  },
  'file:save': {
    request: z.object({
      filePath: z.string().min(1),
      content: z.string()
    }),
    response: z.void()
  },
  'file:apply-hunk': {
    request: z.object({
      filePath: z.string().min(1),
      hunksToApply: z.array(z.string()),
      modifiedContent: z.string()
    }),
    response: z.object({ success: z.boolean() })
  },
  'stream:text_delta': z.object({ content: z.string() }),
  'stream:tool_use_start': z.object({ id: z.string(), name: z.string() }),
  'stream:tool_use_end': z.object({ id: z.string(), parsedInput: z.record(z.unknown()) }),
  'stream:done': z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) })
} as const
