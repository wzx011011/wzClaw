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

  // Session channels (renderer -> main)
  'session:list': 'session:list',
  'session:load': 'session:load',
  'session:delete': 'session:delete',

  // Session stream channels (main -> renderer)
  'session:compacted': 'session:compacted',

  // Context channels (renderer -> main)
  'agent:compact_context': 'agent:compact_context'
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
  'file:save': { filePath: string; content: string }
  'session:list': void
  'session:load': { sessionId: string }
  'session:delete': { sessionId: string }
  'agent:compact_context': void
}

// Response payloads (main returns to renderer via ipcMain.handle return)
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
  'file:save': void
  'session:list': SessionMeta[]
  'session:load': unknown[]
  'session:delete': { success: boolean }
  'agent:compact_context': { beforeTokens: number; afterTokens: number } | null
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
  'stream:text_delta': z.object({ content: z.string() }),
  'stream:tool_use_start': z.object({ id: z.string(), name: z.string() }),
  'stream:tool_use_end': z.object({ id: z.string(), parsedInput: z.record(z.unknown()) }),
  'stream:done': z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) })
} as const
