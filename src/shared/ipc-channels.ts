import { z } from 'zod'
import { UserMessageSchema, TokenUsageSchema } from './types'
import type { FileTreeNode, SessionMeta, AgentTask } from './types'

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
  'stream:turn_end': 'stream:turn_end',
  'stream:mobile_user_message': 'stream:mobile_user_message',
  'stream:retrying': 'stream:retrying',

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
  'file:rename': 'file:rename',
  'file:delete': 'file:delete',

  // Session channels (renderer -> main)
  'session:list': 'session:list',
  'session:load': 'session:load',
  'session:delete': 'session:delete',
  'session:rename': 'session:rename',

  // Session stream channels (main -> renderer)
  'session:compacted': 'session:compacted',
  'session:context-restored': 'session:context-restored',

  // Diff channels (renderer -> main)
  'file:apply-hunk': 'file:apply-hunk',

  // File history / revert channels (renderer -> main)
  'file:get-history': 'file:get-history',
  'file:revert': 'file:revert',

  // Plan mode channels (main -> renderer events, renderer -> main decision)
  'agent:plan-mode-entered': 'agent:plan-mode-entered',
  'agent:plan-mode-exited': 'agent:plan-mode-exited',
  'agent:plan-decision': 'agent:plan-decision',

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
  'symbol:result': 'symbol:result',

  // Task channels (renderer -> main for list, main -> renderer for streaming)
  'task:list': 'task:list',
  'task:created': 'task:created',
  'task:updated': 'task:updated',

  // Index channels (renderer -> main for status/reindex/search, main -> renderer for progress)
  'index:status': 'index:status',
  'index:reindex': 'index:reindex',
  'index:search': 'index:search',
  'index:progress': 'index:progress',

  // Git channels (renderer -> main)
  'git:status': 'git:status',

  // Permission mode channels (renderer -> main)
  'permission:get_mode': 'permission:get_mode',
  'permission:set_mode': 'permission:set_mode',

  // MCP channels (renderer -> main)
  'mcp:list_servers': 'mcp:list_servers',
  'mcp:add_server': 'mcp:add_server',
  'mcp:remove_server': 'mcp:remove_server',
  'mcp:list_tools': 'mcp:list_tools',

  // Browser channels (renderer -> main for control, main -> renderer for screenshot/status)
  'browser:navigate': 'browser:navigate',
  'browser:take_screenshot': 'browser:take_screenshot',
  'browser:close': 'browser:close',
  'browser:screenshot': 'browser:screenshot',
  'browser:status': 'browser:status',

  // Mobile channels (renderer -> main, main -> renderer)
  'mobile:start': 'mobile:start',
  'mobile:stop': 'mobile:stop',
  'mobile:status': 'mobile:status',
  'mobile:qrcode': 'mobile:qrcode',

  // Relay channels (renderer -> main, main -> renderer)
  'relay:connect': 'relay:connect',
  'relay:disconnect': 'relay:disconnect',
  'relay:status': 'relay:status',
  'relay:get_status': 'relay:get_status',
  'relay:qrcode': 'relay:qrcode',

  // AskUserQuestion channels (main -> renderer push, renderer -> main invoke)
  'ask-user:question': 'ask-user:question',
  'ask-user:answer': 'ask-user:answer',

  // Usage / cost tracking (main -> renderer push)
  'usage:update': 'usage:update',

  // Todo panel (main -> renderer push)
  'todo:updated': 'todo:updated',

  // Shell utility (renderer -> main)
  'shell:open_path': 'shell:open_path',
  'shell:get_extension_paths': 'shell:get_extension_paths',
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
    relayToken?: string
  }
  'workspace:open_folder': void
  'workspace:get_tree': { dirPath?: string; depth?: number }
  'workspace:watch': void
  'workspace:status': void
  'file:read': { filePath: string }
  'file:read-content': { filePath: string }
  'file:read-folder-tree': { dirPath: string }
  'file:save': { filePath: string; content: string }
  'file:rename': { oldPath: string; newPath: string }
  'file:delete': { filePath: string }
  'session:list': void
  'session:load': { sessionId: string }
  'session:delete': { sessionId: string }
  'session:rename': { sessionId: string; title: string }
  'file:apply-hunk': { filePath: string; hunksToApply: string[]; modifiedContent: string }
  'file:get-history': { filePath: string }
  'file:revert': { toolCallId: string }
  'agent:compact_context': void
  'agent:plan-decision': { approved: boolean }
  'terminal:create': { cwd: string }
  'terminal:kill': { terminalId: string }
  'terminal:input': { terminalId: string; data: string }
  'terminal:resize': { terminalId: string; cols: number; rows: number }
  'terminal:output': { terminalId: string }
  'symbol:query': { operation: string; params: Record<string, unknown> }
  'task:list': void
  'index:status': void
  'index:reindex': void
  'index:search': { query: string; topK?: number }
  'git:status': void
  'permission:get_mode': void
  'permission:set_mode': { mode: string }
  'mcp:list_servers': void
  'mcp:add_server': { name: string; command?: string; args?: string[]; url?: string; transport: 'stdio' | 'sse' }
  'mcp:remove_server': { name: string }
  'mcp:list_tools': void
  'browser:navigate': { url: string }
  'browser:take_screenshot': void
  'browser:close': void
  'mobile:start': void
  'mobile:stop': void
  'relay:connect': { token: string }
  'relay:disconnect': void
  'relay:get_status': void
  'relay:qrcode': { token?: string }
  'ask-user:answer': { questionId: string; selectedLabels: string[]; customText?: string }
  'shell:open_path': { path: string }
  'shell:get_extension_paths': void
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
    relayToken?: string
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
  'file:rename': { success: boolean }
  'file:delete': { success: boolean }
  'session:list': SessionMeta[]
  'session:load': unknown[]
  'session:delete': { success: boolean }
  'session:rename': { success: boolean }
  'file:apply-hunk': { success: boolean }
  'file:get-history': Array<{ toolCallId: string; timestamp: number; filePath: string }>
  'file:revert': { success: boolean; error?: string }
  'agent:compact_context': { beforeTokens: number; afterTokens: number } | null
  'agent:plan-decision': void
  'terminal:create': { terminalId: string }
  'terminal:kill': void
  'terminal:input': void
  'terminal:resize': void
  'terminal:output': { buffer: string }
  'symbol:query': { results: Array<{ filePath: string; line: number; symbolName: string; kind: string }> }
  'task:list': AgentTask[]
  'index:status': { status: string; fileCount: number; currentFile: string; error?: string }
  'index:reindex': void
  'index:search': Array<{ filePath: string; startLine: number; endLine: number; content: string; score: number }>
  'git:status': { branch: string; changedFiles: number }
  'permission:get_mode': { mode: string }
  'permission:set_mode': void
  'mcp:list_servers': Array<{ name: string; transport: string; connected: boolean }>
  'mcp:add_server': void
  'mcp:remove_server': void
  'mcp:list_tools': Array<{ name: string; description: string; serverName: string }>
  'browser:navigate': { title: string }
  'browser:take_screenshot': { base64: string }
  'browser:close': void
  'mobile:start': { lanQrCode: string; tunnelQrCode: string | null; localUrl: string; tunnelUrl: string | null; tunnelError: string | null }
  'mobile:stop': void
  'relay:connect': void
  'relay:disconnect': void
  'relay:get_status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  'relay:qrcode': { qrCode: string }
  'ask-user:answer': void
  'shell:open_path': void
  'shell:get_extension_paths': { commandsDir: string; skillsDir: string }
}

// Stream payloads (main sends to renderer via webContents.send)
export interface IpcStreamPayloads {
  'stream:text_delta': { content: string }
  'stream:tool_use_start': { id: string; name: string }
  'stream:tool_use_delta': { id: string; partialJson: string }
  'stream:tool_use_end': { id: string; parsedInput: Record<string, unknown> }
  'stream:error': { error: string }
  'stream:done': { usage: { inputTokens: number; outputTokens: number } }
  'stream:turn_end': Record<string, never>
  'stream:mobile_user_message': { content: string; source: 'mobile' }
  'stream:retrying': { attempt: number; maxAttempts: number; delayMs: number }
  'agent:permission_request': {
    toolName: string
    toolInput: Record<string, unknown>
    reason: string
  }
  'file:changed': { filePath: string; changeType: 'created' | 'modified' | 'deleted' }
  'session:compacted': { beforeTokens: number; afterTokens: number; auto: boolean }
  'session:context-restored': { sessionId: string; messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }
  'agent:plan-mode-entered': Record<string, never>
  'agent:plan-mode-exited': { plan: string }
  'terminal:data': { terminalId: string; data: string }
  'symbol:query': { queryId: string; operation: string; params: Record<string, unknown> }
  'symbol:result': { queryId: string; result: unknown; isError: boolean }
  'task:created': AgentTask
  'task:updated': AgentTask
  'index:progress': { status: string; fileCount: number; currentFile: string; error?: string }
  'browser:screenshot': { url: string; base64: string; timestamp: number }
  'browser:status': { running: boolean; url: string | null }
  'mobile:status': { running: boolean; port: number | null; localUrl: string | null; tunnelUrl: string | null; clients: Array<{ id: string; userAgent: string; connectedAt: number }> }
  'relay:status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  'mobile:qrcode': { qrCode: string }
  'ask-user:question': { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
  'usage:update': { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUSD: number; model: string }
  'todo:updated': { todos: Array<{ content: string; status: string; activeForm: string }> }
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
  'stream:done': z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) }),
  'session:load': {
    request: z.object({ sessionId: z.string().min(1) }),
    response: z.array(z.unknown())
  },
  'session:delete': {
    request: z.object({ sessionId: z.string().min(1) }),
    response: z.object({ success: z.boolean() })
  },
  'session:rename': {
    request: z.object({ sessionId: z.string().min(1), title: z.string().min(1) }),
    response: z.object({ success: z.boolean() })
  }
} as const
