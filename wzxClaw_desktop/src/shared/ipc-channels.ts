import { z } from 'zod'
import type { FileTreeNode, SessionMeta, AgentStep, Workspace, SessionTaskState } from './types'

// ============================================================
// IPC Channel Name Constants (per D-08, D-10, Pattern 4)
// ============================================================

export const IPC_CHANNELS = {
  // Agent channels (renderer -> main)
  'agent:send_message': 'agent:send_message',
  'agent:stop': 'agent:stop',

  // Stream channels (main -> renderer, fire-and-forget via webContents.send)
  'stream:text_delta': 'stream:text_delta',
  'stream:thinking_delta': 'stream:thinking_delta',
  'stream:tool_call_preview': 'stream:tool_call_preview',
  'stream:tool_use_start': 'stream:tool_use_start',
  'stream:tool_use_end': 'stream:tool_use_end',
  'stream:tool_progress': 'stream:tool_progress',
  'stream:error': 'stream:error',
  'stream:done': 'stream:done',
  'stream:turn_end': 'stream:turn_end',
  'stream:mobile_user_message': 'stream:mobile_user_message',
  'stream:retrying': 'stream:retrying',
  'stream:sub_tool_use_start': 'stream:sub_tool_use_start',
  'stream:sub_tool_use_end': 'stream:sub_tool_use_end',
  'stream:sub_text': 'stream:sub_text',

  // Permission channels (main -> renderer request, renderer -> main response)
  'agent:permission_request': 'agent:permission_request',
  'agent:permission_response': 'agent:permission_response',

  // Settings channels (renderer -> main)
  'settings:get': 'settings:get',
  'settings:update': 'settings:update',

  // Workspace channels (renderer -> main)
  'workspace:open_folder': 'workspace:open_folder',
  'workspace:set_folder': 'workspace:set_folder',
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
  'file:create': 'file:create',

  // Session channels (renderer -> main)
  'session:list': 'session:list',
  'session:load': 'session:load',
  'session:load-tail': 'session:load-tail',
  'session:delete': 'session:delete',
  'session:rename': 'session:rename',
  'session:save-last': 'session:save-last',
  'session:get-last': 'session:get-last',
  'session:duplicate': 'session:duplicate',

  // Session stream channels (main -> renderer)
  'session:compacted': 'session:compacted',
  'session:context-restored': 'session:context-restored',
  'session:restore': 'session:restore',
  'session:running_changed': 'session:running_changed',
  'session:task_status_changed': 'session:task_status_changed',

  // Diff channels (renderer -> main)
  'file:apply-hunk': 'file:apply-hunk',

  // File history / revert channels (renderer -> main)
  'file:get-history': 'file:get-history',
  'file:revert': 'file:revert',
  'session:rewind': 'session:rewind',
  'session:export': 'session:export',

  // Plan mode channels (main -> renderer events, renderer -> main decision)
  'agent:plan-mode-entered': 'agent:plan-mode-entered',
  'agent:plan-mode-exited': 'agent:plan-mode-exited',
  'agent:plan-decision': 'agent:plan-decision',
  'agent:toggle_plan_mode': 'agent:toggle_plan_mode',

  // Context channels (renderer -> main)
  'agent:compact_context': 'agent:compact_context',
  'system:doctor': 'system:doctor',

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

  // Step channels (renderer -> main for list, main -> renderer for streaming)
  'step:list': 'step:list',
  'step:created': 'step:created',
  'step:updated': 'step:updated',

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
  'todo:load': 'todo:load',

  // Workspace management channels (renderer -> main)
  'workspace:list': 'workspace:list',
  'workspace:get': 'workspace:get',
  'workspace:create': 'workspace:create',
  'workspace:update': 'workspace:update',
  'workspace:delete': 'workspace:delete',
  'workspace:add-project': 'workspace:add-project',
  'workspace:remove-project': 'workspace:remove-project',

  // Shell utility (renderer -> main)
  'shell:open_path': 'shell:open_path',
  'shell:get_extension_paths': 'shell:get_extension_paths',

  // Insights (renderer -> main for trigger, main -> renderer for progress)
  'insights:generate': 'insights:generate',
  'insights:progress': 'insights:progress',

  // Context breakdown (renderer -> main for token usage analysis)
  'agent:context_breakdown': 'agent:context_breakdown',

  // Theme channels (renderer -> main)
  'theme:set-titlebar-overlay': 'theme:set-titlebar-overlay',

  // Data sync channels (main -> renderer push for mobile sync)
  'data:changed': 'data:changed',

  // File save request (main -> renderer, triggers unsaved file prompt)
  'file:save_request': 'file:save_request',

  // Skill channels (renderer -> main)
  'skill:list': 'skill:list',
  'skill:get-prompt': 'skill:get-prompt',
  'skill:reload': 'skill:reload',
  'skill:invoke': 'skill:invoke',

  // Tool list (renderer -> main)
  'tools:list': 'tools:list',

  // Plugin channels (renderer -> main)
  'plugin:list': 'plugin:list',
  'plugin:get': 'plugin:get',
  'plugin:install': 'plugin:install',
  'plugin:uninstall': 'plugin:uninstall',
  'plugin:enable': 'plugin:enable',
  'plugin:disable': 'plugin:disable',
  'plugin:reload': 'plugin:reload',
  'plugin:get-skills': 'plugin:get-skills',
  'plugin:install-from-source': 'plugin:install-from-source',
  'plugin:get-output-styles': 'plugin:get-output-styles',
  'plugin:get-user-config': 'plugin:get-user-config',
  'plugin:set-user-config': 'plugin:set-user-config',
  'plugin:search_marketplace': 'plugin:search_marketplace',
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
    activeWorkspaceId?: string
    images?: Array<{ data: string; mimeType: string; name?: string }>
  }
  'agent:stop': void
  'todo:load': { sessionId: string }
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
    thinkingDepth?: string
    showToolSteps?: boolean
    language?: string
  }
  'workspace:open_folder': void
  'workspace:set_folder': { folderPath: string }
  'workspace:get_tree': { dirPath?: string; depth?: number }
  'workspace:watch': void
  'workspace:status': void
  'file:read': { filePath: string }
  'file:read-content': { filePath: string }
  'file:read-folder-tree': { dirPath: string }
  'file:save': { filePath: string; content: string }
  'file:rename': { oldPath: string; newPath: string }
  'file:delete': { filePath: string }
  'file:create': { dirPath: string; name: string; type: 'file' | 'directory' }
  'session:list': void
  'session:load': { sessionId: string; activeWorkspaceId?: string }
  'session:load-tail': { sessionId: string; tailCount: number; activeWorkspaceId?: string }
  'session:delete': { sessionId: string; activeWorkspaceId?: string }
  'session:rename': { sessionId: string; title: string; activeWorkspaceId?: string }
  'session:duplicate': { sessionId: string; activeWorkspaceId?: string }
  'file:apply-hunk': { filePath: string; hunksToApply: string[]; modifiedContent: string }
  'file:get-history': { filePath: string }
  'file:revert': { toolCallId: string }
  'session:rewind': { sessionId: string; targetMessageId: string }
  'session:export': { sessionId: string; format: 'markdown' | 'json' }
  'agent:compact_context': void
  'system:doctor': void
  'agent:plan-decision': { approved: boolean }
  'agent:toggle_plan_mode': void
  'terminal:create': { cwd: string }
  'terminal:kill': { terminalId: string }
  'terminal:input': { terminalId: string; data: string }
  'terminal:resize': { terminalId: string; cols: number; rows: number }
  'terminal:output': { terminalId: string }
  'symbol:query': { operation: string; params: Record<string, unknown> }
  'step:list': void
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
  'relay:connect': { token: string }
  'relay:disconnect': void
  'relay:get_status': void
  'relay:qrcode': { token?: string }
  'ask-user:answer': { questionId: string; selectedLabels: string[]; customText?: string }
  'workspace:list': { includeArchived?: boolean }
  'workspace:get': { workspaceId: string }
  'workspace:create': { title: string; description?: string }
  'workspace:update': { workspaceId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string } }
  'workspace:delete': { workspaceId: string }
  'workspace:add-project': { workspaceId: string; folderPath: string }
  'workspace:remove-project': { workspaceId: string; projectId: string }
  'shell:open_path': { path: string }
  'shell:get_extension_paths': void
  'insights:generate': void
  'agent:context_breakdown': void
  'skill:list': void
  'skill:get-prompt': { name: string; args: string }
  'skill:reload': void
  'skill:invoke': { name: string; args: string }

  'tools:list': void

  // Plugin channels
  'plugin:list': void
  'plugin:get': { name: string }
  'plugin:install': { path: string; scope?: import('./types-plugin').PluginScope }
  'plugin:uninstall': { name: string }
  'plugin:enable': { name: string }
  'plugin:disable': { name: string }
  'plugin:reload': void
  'plugin:get-skills': { pluginName?: string }
  'plugin:install-from-source': { source: import('./types-plugin').MarketplacePluginSource; scope?: import('./types-plugin').PluginScope }
  'plugin:get-output-styles': void
  'plugin:get-user-config': { pluginName: string }
  'plugin:set-user-config': { pluginName: string; values: Record<string, unknown> }
  'plugin:search_marketplace': { query?: string }
}
export interface IpcResponsePayloads {
  'agent:send_message': void
  'agent:stop': void
  'todo:load': Array<{ content: string; status: string; activeForm: string }>
  'settings:get': {
    provider: string
    model: string
    hasApiKey: boolean
    maskedApiKey?: string
    baseURL?: string
    systemPrompt?: string
    relayToken?: string
    thinkingDepth?: string
    showToolSteps?: boolean
    language?: string
  }
  'settings:update': void
  'workspace:open_folder': { rootPath: string } | null
  'workspace:set_folder': { rootPath: string } | null
  'workspace:get_tree': FileTreeNode[]
  'workspace:watch': void
  'workspace:status': { rootPath: string | null; isWatching: boolean }
  'file:read': { content: string; language: string }
  'file:read-content': { content: string; size: number; path: string } | { error: string; size: number; limit: number }
  'file:read-folder-tree': { tree: string; fileCount: number; path: string } | { error: string }
  'file:save': void
  'file:rename': { success: boolean }
  'file:delete': { success: boolean }
  'file:create': { success: boolean; filePath: string }
  'session:list': { sessions: SessionMeta[]; runningSessionIds: string[] }
  'session:load': unknown[]
  'session:load-tail': { messages: unknown[]; totalCount: number; hasMore: boolean }
  'session:delete': { success: boolean }
  'session:rename': { success: boolean }
  'session:duplicate': { newSessionId: string }
  'file:apply-hunk': { success: boolean }
  'file:get-history': Array<{ toolCallId: string; timestamp: number; filePath: string }>
  'file:revert': { success: boolean; error?: string }
  'session:rewind': { success: boolean; removedCount: number; revertedFiles: string[]; error?: string }
  'session:export': { filePath: string; messageCount: number }
  'agent:compact_context': { beforeTokens: number; afterTokens: number } | null
  'system:doctor': string
  'agent:plan-decision': void
  'agent:toggle_plan_mode': { active: boolean }
  'terminal:create': { terminalId: string }
  'terminal:kill': void
  'terminal:input': void
  'terminal:resize': void
  'terminal:output': { buffer: string }
  'symbol:query': { results: Array<{ filePath: string; line: number; symbolName: string; kind: string }> }
  'step:list': AgentStep[]
  'index:status': { status: string; fileCount: number; currentFile: string; error?: string }
  'index:reindex': void
  'index:search': Array<{ filePath: string; startLine: number; endLine: number; content: string; score: number }>
  'git:status': { branch: string; changedFiles: number }
  'permission:get_mode': { mode: string }
  'permission:set_mode': void
  'tools:list': Array<{ name: string; description: string; isReadOnly: boolean; requiresApproval: boolean }>
  'mcp:list_servers': Array<{ name: string; transport: string; connected: boolean }>
  'mcp:add_server': void
  'mcp:remove_server': void
  'mcp:list_tools': Array<{ name: string; description: string; serverName: string }>
  'browser:navigate': { title: string }
  'browser:take_screenshot': { base64: string }
  'browser:close': void
  'relay:connect': void
  'relay:disconnect': void
  'relay:get_status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  'relay:qrcode': { qrCode: string }
  'ask-user:answer': void
  'workspace:list': Workspace[]
  'workspace:get': Workspace | null
  'workspace:create': Workspace
  'workspace:update': Workspace
  'workspace:delete': void
  'workspace:add-project': Workspace
  'workspace:remove-project': Workspace
  'shell:open_path': void
  'shell:get_extension_paths': { commandsDir: string; skillsDir: string }
  'insights:generate': { summary: string; htmlPath: string; totalSessions: number; totalCostUSD: number }
  'agent:context_breakdown': import('./types').ContextBreakdownResponse
  'skill:list': import('./types-skill').SkillInfo[]
  'skill:get-prompt': string | null
  'skill:reload': void
  'skill:invoke': { content: string } | { error: string }

  // Plugin channels
  'plugin:list': import('./types-plugin').PluginInfo[]
  'plugin:get': import('./types-plugin').PluginInfo | null
  'plugin:install': { success: boolean; message: string; pluginName?: string }
  'plugin:uninstall': { success: boolean; message: string }
  'plugin:enable': { success: boolean; message: string }
  'plugin:disable': { success: boolean; message: string }
  'plugin:reload': void
  'plugin:get-skills': import('./types-skill').SkillInfo[]
  'plugin:install-from-source': import('./types-plugin').PluginInstallResult
  'plugin:get-output-styles': { css: string; styleNames: string[] }
  'plugin:get-user-config': Record<string, unknown>
  'plugin:set-user-config': { success: boolean; message: string }
  'plugin:search_marketplace': import('./types-plugin').MarketplacePluginDisplay[]
}

// Stream payloads (main sends to renderer via webContents.send)
export interface IpcStreamPayloads {
  'stream:text_delta': { content: string }
  'stream:thinking_delta': { content: string }
  'stream:tool_call_preview': { id: string; name: string }
  'stream:tool_use_start': { id: string; name: string }
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
  'session:running_changed': { sessionId: string; isRunning: boolean }
  'session:task_status_changed': SessionTaskState
  'agent:plan-mode-entered': Record<string, never>
  'agent:plan-mode-exited': { plan: string }
  'terminal:data': { terminalId: string; data: string }
  'symbol:query': { queryId: string; operation: string; params: Record<string, unknown> }
  'symbol:result': { queryId: string; result: unknown; isError: boolean }
  'step:created': AgentStep
  'step:updated': AgentStep
  'index:progress': { status: string; fileCount: number; currentFile: string; error?: string }
  'browser:screenshot': { url: string; base64: string; timestamp: number }
  'browser:status': { running: boolean; url: string | null }
  'relay:status': { connected: boolean; connecting: boolean; reconnectAttempt: number; mobileConnected: boolean; mobileIdentity: string | null }
  'ask-user:question': { questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
  'usage:update': { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCostUSD: number; model: string }
  'todo:updated': { todos: Array<{ content: string; status: string; activeForm: string }> }
  'insights:progress': { stage: string; current: number; total: number; message: string }
}

// ============================================================
// Zod Schemas for IPC Validation (per D-09)
// ============================================================

export const IpcSchemas = {
  'agent:send_message': {
    request: z.object({
      conversationId: z.string(),
      content: z.string().min(1),
      activeWorkspaceId: z.string().optional(),
      images: z.array(z.object({
        data: z.string(),
        mimeType: z.string(),
        name: z.string().optional()
      })).optional()
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
  'stream:thinking_delta': z.object({ content: z.string() }),
  'stream:tool_call_preview': z.object({ id: z.string(), name: z.string() }),
  'stream:tool_use_start': z.object({ id: z.string(), name: z.string() }),
  'stream:tool_use_end': z.object({ id: z.string(), parsedInput: z.record(z.unknown()) }),
  'stream:done': z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) }),
  'session:load': {
    request: z.object({ sessionId: z.string().min(1), activeWorkspaceId: z.string().optional() }),
    response: z.array(z.unknown())
  },
  'session:delete': {
    request: z.object({ sessionId: z.string().min(1), activeWorkspaceId: z.string().optional() }),
    response: z.object({ success: z.boolean() })
  },
  'session:rename': {
    request: z.object({ sessionId: z.string().min(1), title: z.string().min(1), activeWorkspaceId: z.string().optional() }),
    response: z.object({ success: z.boolean() })
  },
  'session:duplicate': {
    request: z.object({ sessionId: z.string().min(1), activeWorkspaceId: z.string().optional() }),
    response: z.object({ newSessionId: z.string() })
  },
  'plugin:install-from-source': {
    request: z.object({
      source: z.union([
        z.object({ source: z.literal('github'), repo: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('git'), url: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('url'), url: z.string().min(1), headers: z.record(z.string()).optional() }),
        z.object({ source: z.literal('directory'), path: z.string().min(1) }),
      ]),
      scope: z.enum(['user', 'project', 'local', 'managed']).optional()
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string(),
      pluginId: z.string().optional(),
      pluginName: z.string().optional(),
      scope: z.enum(['user', 'project', 'local', 'managed']).optional()
    })
  },
  'plugin:search_marketplace': {
    request: z.object({ query: z.string().optional() }).optional(),
    response: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
      author: z.string().optional(),
      homepage: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      installSource: z.union([
        z.object({ source: z.literal('github'), repo: z.string().min(1), ref: z.string().optional(), path: z.string().optional() }),
        z.object({ source: z.literal('git'), url: z.string().min(1), ref: z.string().optional() }),
        z.object({ source: z.literal('npm'), package: z.string().min(1), version: z.string().optional() }),
        z.object({ source: z.literal('url'), url: z.string().min(1) }),
      ]),
      installed: z.boolean(),
      enabled: z.boolean().optional(),
      isPlaceholder: z.boolean().optional(),
    }))
  }
} as const
