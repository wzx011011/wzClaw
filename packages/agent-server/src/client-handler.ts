// ============================================================
// ClientHandler — 客户端 WebSocket 连接处理 + AgentLoop 桥接
// 管理 client 类型 WebSocket 连接，处理 Client 协议消息
// 将 AgentLoop 的 AgentEvent 转换为 Client 协议格式推送给客户端
// ============================================================

import type { WebSocket } from 'ws'
import path from 'path'
import {
  encodeAgentEvent,
  type AgentLoop,
  type AgentConfig,
  type ISessionStore,
  type IToolExecutor,
  type IEventSender,
  type SessionConfigPatch,
} from '@wzxclaw/brain'
import type { ServerMessage } from './types.js'
import { SessionService } from './session-service.js'
import { WorkspaceService, type WorkspaceUpdate } from './workspace-service.js'
import { HostStore, type HostEntry } from './host-store.js'
import { TerminalSessionRouter } from './terminal-session-router.js'
import type { HandsRouter } from './hands-router.js'

interface ConnectionState {
  activeLoop: AgentLoop | null
  consuming: boolean
  permissionMode: string
  /** 心跳定时器 — 定期 ping 检测连接存活 */
  heartbeatTimer: ReturnType<typeof setInterval> | null
  /** 上一次收到 pong 或消息的时间 */
  lastAliveAt: number
}

/** 服务器默认权限模式。优先从环境变量读取，默认以“总是询问”为安全基准。 */
const DEFAULT_PERMISSION_MODE: ConnectionState['permissionMode'] = (() => {
  const envValue = process.env.WZXCLAW_DEFAULT_PERMISSION_MODE
  const valid = ['always-ask', 'accept-edits', 'plan', 'bypass'] as const
  return (valid as readonly string[]).includes(envValue ?? '')
    ? (envValue as ConnectionState['permissionMode'])
    : 'always-ask'
})()

/**
 * WebSocket 事件发送适配器
 *
 * 实现 brain 包的 IEventSender 接口，将 send() 调用
 * 适配为 WebSocket JSON 消息发送。
 */
class WebSocketEventSender implements IEventSender {
  constructor(private ws: WebSocket) {}

  send(channel: string, data: unknown): void {
    if (this.isDestroyed()) return
    const msg: ServerMessage = { event: channel, data }
    this.ws.send(JSON.stringify(msg))
  }

  isDestroyed(): boolean {
    return this.ws.readyState !== 1 // WebSocket.OPEN = 1
  }
}

/** 默认 AgentConfig（服务器端使用） */
const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'deepseek-chat',
  provider: 'openai',
  systemPrompt: '',
  workingDirectory: '/tmp',
  projectRoots: ['/tmp'],
  conversationId: '',
}

/** AgentLoop 工厂函数类型 */
export type AgentLoopFactory = () => AgentLoop

export type AgentConfigDefaults = Partial<Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory' | 'projectRoots'>>

type ChatSendData = {
  sessionId: string
  message: string
  workspaceId?: string
  targetHandId?: string
  model?: string
  provider?: AgentConfig['provider']
  workingDirectory?: string
  projectRoots?: string[]
}

/**
 * ClientHandler — 客户端 WebSocket 连接处理器
 *
 * 管理 client 类型 WebSocket 连接的生命周期：
 * - 处理 chat:send 消息，启动 AgentLoop 并流式推送事件
 * - 处理 session:list/load/create/delete CRUD 操作
 * - 同一客户端同时只运行一个 AgentLoop（新请求取消旧的）
 * - WebSocket 关闭时清理资源
 */
export class ClientHandler {
  /** 会话持久化存储 */
  private readonly sessionStore: ISessionStore

  /** 会话配置 / 元数据 / 运行时状态服务 */
  private readonly sessionService: SessionService

  /** 工作区服务（Web/手机共享工作区能力） */
  private readonly workspaceService: WorkspaceService | null

  /** 工具执行器（Hand 感知） */
  private readonly toolExecutor: IToolExecutor

  /** AgentLoop 工厂函数 */
  private createLoop: AgentLoopFactory

  /** 每个 WebSocket 连接独立的运行时状态 */
  private readonly connectionStates = new Map<WebSocket, ConnectionState>()

  /** 服务器级 Agent 配置默认值 */
  private readonly agentConfigDefaults: AgentConfigDefaults

  /** 远程主机存储 */
  private readonly hostStore: HostStore

  /** Terminal 会话路由器（terminalId → clientWs / handId） */
  private readonly terminalRouter: TerminalSessionRouter

  /** Hands 路由器（用于按工具名查找在线 Hand，可选） */
  private readonly handsRouter: HandsRouter | null

  constructor(
    sessionStore: ISessionStore,
    toolExecutor: IToolExecutor,
    workspaceService?: WorkspaceService | null,
    createLoop?: AgentLoopFactory,
    agentConfigDefaults: AgentConfigDefaults = {},
    handsRouter?: HandsRouter | null,
    terminalRouter?: TerminalSessionRouter,
  ) {
    this.sessionStore = sessionStore
    this.sessionService = new SessionService(sessionStore)
    this.toolExecutor = toolExecutor
    this.workspaceService = workspaceService ?? null
    this.agentConfigDefaults = agentConfigDefaults
    this.handsRouter = handsRouter ?? null
    this.terminalRouter = terminalRouter ?? new TerminalSessionRouter()
    const configDir = process.env.WZXCLAW_CONFIG_DIR || '/root/.wzxclaw'
    this.hostStore = new HostStore(configDir)
    // 默认工厂函数 — 实际使用时由 server.ts 注入
    this.createLoop = createLoop ?? (() => {
      throw new Error('AgentLoop factory not configured')
    })
  }

  /** 获取 TerminalSessionRouter（用于 server 层路由 hand 推送帧） */
  getTerminalRouter(): TerminalSessionRouter {
    return this.terminalRouter
  }

  /**
   * 设置 AgentLoop 工厂函数（用于测试或延迟配置）
   */
  setLoopFactory(factory: AgentLoopFactory): void {
    this.createLoop = factory
  }

  /**
   * 处理新的客户端 WebSocket 连接
   *
   * 注册 message/close 事件监听器，按 event 字段分发处理。
   * 每个连接独立管理自己的 AgentLoop 生命周期。
   */
  handleConnection(ws: WebSocket): void {
    const now = Date.now()
    this.connectionStates.set(ws, { activeLoop: null, consuming: false, permissionMode: DEFAULT_PERMISSION_MODE, heartbeatTimer: null, lastAliveAt: now })

    // 启动心跳：每 30 秒 ping 一次，60 秒无响应则关闭连接
    const timer = setInterval(() => {
      const state = this.connectionStates.get(ws)
      if (!state) { clearInterval(timer); return }
      if (Date.now() - state.lastAliveAt > 60_000) {
        ws.terminate()
        return
      }
      if (ws.readyState === 1) {
        ws.ping()
      }
    }, 30_000)

    this.connectionStates.get(ws)!.heartbeatTimer = timer

    ws.on('pong', () => {
      const state = this.connectionStates.get(ws)
      if (state) state.lastAliveAt = Date.now()
    })

    ws.on('message', (raw: unknown) => {
      const state = this.connectionStates.get(ws)
      if (state) state.lastAliveAt = Date.now()
      this.handleMessage(ws, raw)
    })

    ws.on('close', () => {
      this.handleClose(ws)
    })
  }

  /**
   * 处理收到的消息
   * 解析 JSON，按 event 字段分发到对应的处理函数
   */
  private handleMessage(ws: WebSocket, raw: unknown): void {
    // 解析 JSON
    let parsed: ServerMessage
    try {
      const str = typeof raw === 'string' ? raw : String(raw)
      parsed = JSON.parse(str)
    } catch {
      // 无效 JSON — 忽略
      return
    }

    const { event, data } = parsed

    switch (event) {
      case 'capabilities:get':
        this.handleCapabilitiesGet(ws)
        break
      case 'chat:send':
        this.handleChatSend(ws, data as ChatSendData)
          .catch((err) => this.sendStreamError(ws, err))
        break
      case 'session:list':
        this.handleSessionList(ws, data as { workspaceId?: string } | undefined)
        break
      case 'session:load':
        this.handleSessionLoad(ws, data as { sessionId: string })
        break
      case 'session:create':
        this.handleSessionCreate(ws, data as SessionConfigPatch | undefined)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'session:delete':
        this.handleSessionDelete(ws, data as { sessionId: string })
        break
      case 'session:rename':
        this.handleSessionRename(ws, data as { sessionId: string; title: string })
        break
      case 'session:config:get':
        this.handleSessionConfigGet(ws, data as { sessionId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'session:config:update':
        this.handleSessionConfigUpdate(ws, data as { sessionId: string; patch: SessionConfigPatch })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'chat:stop':
        this.handleStopGeneration(ws, data as { sessionId?: string } | undefined)
        break
      case 'tool:execute':
        this.handleToolExecute(ws, data as { name: string; input: Record<string, unknown> })
        break
      case 'tool:list':
        this.handleToolList(ws)
        break
      case 'workspace:list':
        this.handleWorkspaceList(ws, data as { includeArchived?: boolean } | undefined)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:get':
        this.handleWorkspaceGet(ws, data as { workspaceId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:create':
        this.handleWorkspaceCreate(ws, data as { title: string; description?: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:update':
        this.handleWorkspaceUpdate(ws, data as { workspaceId: string; updates: WorkspaceUpdate })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:delete':
        this.handleWorkspaceDelete(ws, data as { workspaceId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:add-project':
        this.handleWorkspaceAddProject(ws, data as { workspaceId: string; folderPath: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'workspace:remove-project':
        this.handleWorkspaceRemoveProject(ws, data as { workspaceId: string; projectId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'permission:get':
        this.handlePermissionGet(ws)
        break
      case 'permission:set':
        this.handlePermissionSet(ws, data as { mode: string })
        break
      case 'ask-user:answer':
        this.handleAskUserAnswer(ws, data as { questionId: string; answer: string })
        break
      case 'session:export':
        this.handleSessionExport(ws, data as { sessionId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'session:duplicate':
        this.handleSessionDuplicate(ws, data as { sessionId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'knowledge:get':
        this.handleKnowledgeGet(ws)
        break
      case 'mcp:list':
        this.handleMcpList(ws)
        break
      case 'settings:get':
        this.handleSettingsGet(ws)
        break
      case 'fs:readFile':
        this.handleFsReadFile(ws, data as { path: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'fs:writeFile':
        this.handleFsWriteFile(ws, data as { path: string; content: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'fs:tree':
        this.handleFsTree(ws, data as { dirPath: string; depth?: number })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'session:compact':
        this.handleSessionCompact(ws, data as { sessionId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'session:rewind':
        this.handleSessionRewind(ws, data as { sessionId: string; keepMessageCount: number })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      // ---- Hosts ----
      case 'host:list':
        this.handleHostList(ws, data as { includeArchived?: boolean })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'host:get':
        this.handleHostGet(ws, data as { hostId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'host:create':
        this.handleHostCreate(ws, data as Omit<HostEntry, 'id' | 'createdAt' | 'updatedAt'>)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'host:update':
        this.handleHostUpdate(ws, data as { hostId: string; updates: Partial<HostEntry> })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'host:delete':
        this.handleHostDelete(ws, data as { hostId: string })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      // ---- Plugins ----
      case 'plugin:list':
        this.handlePluginList(ws)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      // ---- Indexing ----
      case 'indexing:status':
        this.handleIndexingStatus(ws)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      case 'indexing:search':
        this.handleIndexingSearch(ws, data as { query: string; limit?: number })
          .catch((err) => this.sendProtocolError(ws, err))
        break
      // ---- Insights ----
      case 'insights:status':
        this.handleInsightsStatus(ws)
          .catch((err) => this.sendProtocolError(ws, err))
        break
      // ---- Terminal (PTY over Hand) ----
      case 'terminal:spawn':
        this.handleTerminalSpawn(ws, data as { cwd?: string; cols?: number; rows?: number; shell?: string; targetHandId?: string; workspaceId?: string })
          .catch((err) => this.sendTerminalError(ws, 'terminal:spawned', err))
        break
      case 'terminal:write':
        this.handleTerminalWrite(ws, data as { terminalId: string; data: string })
          .catch((err) => this.sendTerminalError(ws, 'terminal:write:ack', err))
        break
      case 'terminal:resize':
        this.handleTerminalResize(ws, data as { terminalId: string; cols: number; rows: number })
          .catch((err) => this.sendTerminalError(ws, 'terminal:resize:ack', err))
        break
      case 'terminal:kill':
        this.handleTerminalKill(ws, data as { terminalId: string })
          .catch((err) => this.sendTerminalError(ws, 'terminal:killed', err))
        break
      // ---- Preview (desktop-only — WebSocket clients get supported:false) ----
      case 'preview:open':
      case 'preview:reload':
        ws.send(JSON.stringify({
          event: 'preview:ack',
          data: { supported: false, error: 'preview not supported over WebSocket; use desktop client' },
        }))
        break
      default:
        // 未知 event — 忽略
        break
    }
  }


  private handleCapabilitiesGet(ws: WebSocket): void {
    // 从已注册 Hand 工具中动态派生 fs/tools 能力
    const defs = this.toolExecutor.getDefinitions()
    const toolNames = new Set(defs.map(d => d.name))
    const hasFs = toolNames.has('FileRead') || toolNames.has('FileList')
    const hasTerminal = toolNames.has('ShellExecute')
    const hasGrep = toolNames.has('Grep')
    const hasGlob = toolNames.has('Glob')

    ws.send(JSON.stringify({
      event: 'capabilities',
      data: {
        workspace: !!this.workspaceService,
        fs: hasFs,
        terminal: hasTerminal,
        preview: false,
        tools: toolNames.size > 0,
        permission: true,
        mcp: toolNames.size > 0,  // 如果有 mcp_ 前缀工具
        skills: true,
        plugins: true,
        hosts: true,
        indexing: hasGrep && hasGlob,
        insights: true,
        browser: false,
        notifications: false,
      },
    }))
  }

  // ---- Permission Mode ----

  private handlePermissionGet(ws: WebSocket): void {
    const state = this.getState(ws)
    ws.send(JSON.stringify({
      event: 'permission:mode',
      data: { mode: state.permissionMode },
    }))
  }

  private handlePermissionSet(ws: WebSocket, data: { mode: string }): void {
    const validModes = ['always-ask', 'accept-edits', 'plan', 'bypass']
    if (!validModes.includes(data.mode)) {
      this.sendProtocolError(ws, new Error(`Invalid permission mode: ${data.mode}`))
      return
    }
    const state = this.getState(ws)
    state.permissionMode = data.mode
    ws.send(JSON.stringify({
      event: 'permission:mode',
      data: { mode: data.mode },
    }))
  }

  // ---- Ask-User ----

  private readonly pendingQuestions = new Map<string, { resolve: (answer: string) => void; ws: WebSocket }>()

  private handleAskUserAnswer(ws: WebSocket, data: { questionId: string; answer: string }): void {
    const pending = this.pendingQuestions.get(data.questionId)
    if (pending) {
      this.pendingQuestions.delete(data.questionId)
      pending.resolve(data.answer)
    }
  }

  /** 发起 ask-user 请求（由 AgentLoop 调用），返回用户回答 */
  askUser(ws: WebSocket, question: string, options?: { choices?: string[] }): Promise<string> {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { resolve, ws })
      ws.send(JSON.stringify({
        event: 'ask-user:question',
        data: { questionId, question, choices: options?.choices },
      }))
      // 5 分钟超时
      setTimeout(() => {
        if (this.pendingQuestions.has(questionId)) {
          this.pendingQuestions.delete(questionId)
          resolve('')
        }
      }, 300_000)
    })
  }

  // ---- Knowledge (Skills/Commands/Memory) ----

  private handleKnowledgeGet(ws: WebSocket): void {
    const configDir = process.env.WZXCLAW_CONFIG_DIR || '/root/.wzxclaw'
    try {
      const { loadInstructions } = require('./instructions/instruction-loader.js')
      const sections = loadInstructions(configDir)
      ws.send(JSON.stringify({
        event: 'knowledge',
        data: {
          skills: sections.skills,
          commands: sections.commands,
          memory: sections.memory,
        },
      }))
    } catch {
      ws.send(JSON.stringify({
        event: 'knowledge',
        data: { skills: '', commands: '', memory: '' },
      }))
    }
  }

  // ---- MCP ----

  private handleMcpList(ws: WebSocket): void {
    // 从已注册 Hand 工具中筛选 MCP 工具（mcp_ 前缀）
    const defs = this.toolExecutor.getDefinitions()
    const mcpTools = defs.filter(d => d.name.startsWith('mcp_'))
    ws.send(JSON.stringify({
      event: 'mcp:list',
      data: { servers: [], tools: mcpTools },
    }))
  }

  // ---- Settings ----

  private handleSettingsGet(ws: WebSocket): void {
    const configDir = process.env.WZXCLAW_CONFIG_DIR || '/root/.wzxclaw'
    const state = this.getState(ws)
    ws.send(JSON.stringify({
      event: 'settings',
      data: {
        configDir,
        apiProviders: ['openai', 'anthropic'],
        defaultModel: this.agentConfigDefaults.model ?? 'deepseek-chat',
        defaultProvider: this.agentConfigDefaults.provider ?? 'openai',
        permissionMode: state.permissionMode,
      },
    }))
  }

  // ---- FS Channel — 委托 Hand 工具 ----

  /** 校验路径是否在 /data 目录内 */
  private isPathWithinData(targetPath: string): boolean {
    const resolved = path.resolve(targetPath)
    return resolved.startsWith('/data/') || resolved === '/data'
  }

  private async handleFsReadFile(ws: WebSocket, data: { path: string }): Promise<void> {
    if (!this.isPathWithinData(data.path)) {
      ws.send(JSON.stringify({ event: 'fs:readFile:result', data: { content: '', error: 'Path must be within /data' } }))
      return
    }
    const ctx = { workingDirectory: '/data', projectRoots: ['/data'], abortSignal: undefined as unknown as AbortSignal }
    const result = await this.toolExecutor.execute('FileRead', { path: data.path }, ctx)
    ws.send(JSON.stringify({
      event: 'fs:readFile:result',
      data: result.isError ? { content: '', error: result.output } : { content: result.output },
    }))
  }

  private async handleFsWriteFile(ws: WebSocket, data: { path: string; content: string }): Promise<void> {
    if (!this.isPathWithinData(data.path)) {
      ws.send(JSON.stringify({ event: 'fs:writeFile:result', data: { error: 'Path must be within /data' } }))
      return
    }
    const ctx = { workingDirectory: '/data', projectRoots: ['/data'], abortSignal: undefined as unknown as AbortSignal }
    const result = await this.toolExecutor.execute('FileWrite', { path: data.path, content: data.content }, ctx)
    ws.send(JSON.stringify({
      event: 'fs:writeFile:result',
      data: result.isError ? { error: result.output } : {},
    }))
  }

  private async handleFsTree(ws: WebSocket, data: { dirPath: string; depth?: number }): Promise<void> {
    if (!this.isPathWithinData(data.dirPath)) {
      ws.send(JSON.stringify({ event: 'fs:tree:result', data: { nodes: [], error: 'Path must be within /data' } }))
      return
    }
    const ctx = { workingDirectory: '/data', projectRoots: ['/data'], abortSignal: undefined as unknown as AbortSignal }
    const result = await this.toolExecutor.execute('FileList', { path: data.dirPath, recursive: true }, ctx)
    if (result.isError) {
      ws.send(JSON.stringify({ event: 'fs:tree:result', data: { nodes: [], error: result.output } }))
      return
    }
    // 将 FileList JSON 输出转为 FileTreeNode[]
    try {
      const entries = JSON.parse(result.output) as Array<{ name: string; path: string; isDir: boolean; size?: number; modified?: string }>
      const nodes = entries.map(entry => ({
        name: entry.name,
        path: entry.path,
        type: entry.isDir ? 'directory' as const : 'file' as const,
        size: entry.size,
        modified: entry.modified,
      }))
      ws.send(JSON.stringify({ event: 'fs:tree:result', data: { nodes } }))
    } catch {
      ws.send(JSON.stringify({ event: 'fs:tree:result', data: { nodes: [], error: 'Failed to parse file list' } }))
    }
  }

  // ---- Session Export / Duplicate ----

  private async handleSessionExport(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    const messages = await this.sessionStore.loadSession(data.sessionId)
    const config = await this.sessionStore.getSessionConfig?.(data.sessionId) ?? null
    ws.send(JSON.stringify({
      event: 'session:exported',
      data: { sessionId: data.sessionId, messages, config },
    }))
  }

  private async handleSessionDuplicate(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    const messages = await this.sessionStore.loadSession(data.sessionId)
    const config = await this.sessionStore.getSessionConfig?.(data.sessionId) ?? null
    const newId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 复制消息到新会话
    for (const msg of messages) {
      await this.sessionStore.appendMessage(newId, msg)
    }
    if (config && this.sessionStore.updateSessionConfig) {
      await this.sessionStore.updateSessionConfig(newId, config)
    }
    ws.send(JSON.stringify({
      event: 'session:duplicated',
      data: { originalSessionId: data.sessionId, newSessionId: newId },
    }))
  }

  private async handleSessionCompact(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    // 触发 compaction 通知 — 实际 compaction 由 AgentLoop 在下次 turn 中执行
    ws.send(JSON.stringify({
      event: 'session:compacted',
      data: { sessionId: data.sessionId },
    }))
  }

  private async handleSessionRewind(ws: WebSocket, data: { sessionId: string; keepMessageCount: number }): Promise<void> {
    const messages = await this.sessionStore.loadSession(data.sessionId)
    const arr = Array.isArray(messages) ? messages : []
    if (data.keepMessageCount >= arr.length) {
      ws.send(JSON.stringify({ event: 'session:rewound', data: { sessionId: data.sessionId, keptCount: arr.length } }))
      return
    }
    const kept = arr.slice(-data.keepMessageCount)
    if (this.sessionStore.replaceMessages) {
      await this.sessionStore.replaceMessages(data.sessionId, kept)
    } else {
      // 降级：delete + rebuild（旧版 store 实现）
      await this.sessionStore.deleteSession(data.sessionId)
      for (const msg of kept) {
        await this.sessionStore.appendMessage(data.sessionId, msg)
      }
    }
    ws.send(JSON.stringify({ event: 'session:rewound', data: { sessionId: data.sessionId, keptCount: kept.length } }))
  }

  // ---- Host CRUD ----

  private async handleHostList(ws: WebSocket, data: { includeArchived?: boolean }): Promise<void> {
    const hosts = await this.hostStore.listHosts(data.includeArchived)
    ws.send(JSON.stringify({ event: 'host:list', data: { hosts } }))
  }

  private async handleHostGet(ws: WebSocket, data: { hostId: string }): Promise<void> {
    const host = await this.hostStore.getHost(data.hostId)
    ws.send(JSON.stringify({ event: 'host:get', data: { host } }))
  }

  private async handleHostCreate(ws: WebSocket, data: Omit<HostEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
    const host = await this.hostStore.createHost(data)
    ws.send(JSON.stringify({ event: 'host:created', data: { host } }))
  }

  private async handleHostUpdate(ws: WebSocket, data: { hostId: string; updates: Partial<HostEntry> }): Promise<void> {
    const host = await this.hostStore.updateHost(data.hostId, data.updates)
    ws.send(JSON.stringify({ event: 'host:updated', data: { host } }))
  }

  private async handleHostDelete(ws: WebSocket, data: { hostId: string }): Promise<void> {
    await this.hostStore.deleteHost(data.hostId)
    ws.send(JSON.stringify({ event: 'host:deleted', data: { hostId: data.hostId } }))
  }

  // ---- Plugins ----

  private async handlePluginList(ws: WebSocket): Promise<void> {
    // 读取 config dir 下的 plugin manifests
    const configDir = process.env.WZXCLAW_CONFIG_DIR || '/root/.wzxclaw'
    const pluginsDir = path.join(configDir, 'plugins')
    const plugins: Array<{ id: string; name: string; description?: string; enabled: boolean; version?: string }> = []
    try {
      const { readdir } = require('fs/promises')
      const entries = await readdir(pluginsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const manifest = require(path.join(pluginsDir, entry.name, 'plugin.json'))
            plugins.push({
              id: entry.name,
              name: manifest.name || entry.name,
              description: manifest.description,
              enabled: manifest.enabled !== false,
              version: manifest.version,
            })
          } catch {
            plugins.push({ id: entry.name, name: entry.name, enabled: true })
          }
        }
      }
    } catch {
      // plugins dir 不存在
    }
    ws.send(JSON.stringify({ event: 'plugin:list', data: { plugins } }))
  }

  // ---- Indexing ----

  private async handleIndexingStatus(ws: WebSocket): Promise<void> {
    // agent-server 的索引用 Hand Grep/Glob 工具模拟
    const defs = this.toolExecutor.getDefinitions()
    const toolNames = new Set(defs.map(d => d.name))
    ws.send(JSON.stringify({
      event: 'indexing:status',
      data: {
        available: toolNames.has('Grep') && toolNames.has('Glob'),
        backend: 'hand-tools',
        indexedFiles: 0,
        lastIndexed: null,
      },
    }))
  }

  private async handleIndexingSearch(ws: WebSocket, data: { query: string; limit?: number }): Promise<void> {
    // 通过 Hand Grep 工具搜索文件内容
    const ctx = { workingDirectory: '/data', projectRoots: ['/data'], abortSignal: undefined as unknown as AbortSignal }
    const result = await this.toolExecutor.execute('Grep', {
      pattern: data.query,
      path: '/data',
      maxResults: data.limit ?? 20,
    }, ctx)
    ws.send(JSON.stringify({
      event: 'indexing:search',
      data: result.isError ? { results: [], error: result.output } : { results: result.output },
    }))
  }

  // ---- Insights ----

  private async handleInsightsStatus(ws: WebSocket): Promise<void> {
    const configDir = process.env.WZXCLAW_CONFIG_DIR || '/root/.wzxclaw'
    let reportExists = false
    let lastGenerated: number | null = null
    try {
      const { stat } = require('fs/promises')
      const statResult = await stat(path.join(configDir, 'insights', 'report.html'))
      reportExists = true
      lastGenerated = statResult.mtimeMs
    } catch {
      // report 不存在
    }
    ws.send(JSON.stringify({
      event: 'insights:status',
      data: { available: true, reportExists, lastGenerated },
    }))
  }
  private sendStreamError(ws: WebSocket, err: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        event: 'stream:error',
        data: { error: err instanceof Error ? err.message : String(err), recoverable: false },
      }))
    }
    const state = this.getState(ws)
    state.activeLoop = null
    state.consuming = false
  }

  private sendProtocolError(ws: WebSocket, err: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  /**
   * 处理 chat:send — 启动 AgentLoop 流式推理
   *
   * 1. 如果已有活跃 AgentLoop，先 cancel
   * 2. 创建新 AgentLoop
   * 3. 消费 AsyncGenerator，每个 event 转换为 Client 协议发送
   * 4. 完成后将消息追加到 session store
   */
  private async handleChatSend(ws: WebSocket, data: ChatSendData): Promise<void> {
    const { sessionId, message } = data
    const state = this.getState(ws)

    // 取消旧的 AgentLoop
    if (state.activeLoop) {
      state.activeLoop.cancel()
      state.activeLoop = null
      state.consuming = false
    }

    // 创建新 AgentLoop
    const loop = this.createLoop()
    state.activeLoop = loop
    state.consuming = true

    // 构建 AgentConfig
    const sessionConfig = await this.sessionService.getSessionConfig(sessionId).catch(() => null)
    const effectiveWorkspaceId = data.workspaceId ?? sessionConfig?.workspaceId
    const workspaceDefaults = await this.workspaceService?.getSessionDefaults(effectiveWorkspaceId) ?? {}
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      ...this.agentConfigDefaults,
      ...workspaceDefaults,
      conversationId: sessionId,
      ...(await this.sessionService.buildAgentConfig(sessionId, this.agentConfigDefaults, {
        targetHandId: data.targetHandId,
        model: data.model,
        provider: data.provider,
        workingDirectory: data.workingDirectory ?? workspaceDefaults.workingDirectory,
        projectRoots: data.projectRoots ?? workspaceDefaults.projectRoots,
      })),
    }

    let historyLength = 0
    // 如果有历史消息，先加载
    try {
      const history = await this.sessionStore.loadSession(sessionId)
      historyLength = history.length
      if (history.length > 0) {
        loop.replaceMessages(history as Parameters<typeof loop.replaceMessages>[0])
      }
    } catch {
      // 加载历史失败 — 继续空对话
    }

    this.sessionService.startRun(sessionId, historyLength)

    // 创建事件发送器
    const sender = new WebSocketEventSender(ws)

    try {
      // 消费 AgentLoop generator
      for await (const event of loop.run(message, config, sender, this.toolExecutor)) {
        // 如果被新的请求中断，停止消费
        if (!state.consuming || state.activeLoop !== loop) break

        // 将 AgentEvent 转换为 Client 协议消息（共享 brain wire-codec）
        const clientMsg = encodeAgentEvent(event)
        if (clientMsg && ws.readyState === 1) {
          ws.send(JSON.stringify(clientMsg))
        }
      }
    } catch (err) {
      // AgentLoop 运行错误 — 发送错误事件
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          event: 'stream:error',
          data: { error: err instanceof Error ? err.message : String(err), recoverable: false },
        }))
      }
    }

    // 完成后保存消息（如果仍是当前 loop）
    if (state.activeLoop === loop) {
      try {
        // 只保存本轮新增消息，避免把已加载历史重复写入 SQLite
        const messages = loop.getMessages()
        for (const msg of messages.slice(historyLength)) {
          await this.sessionService.appendMessage(sessionId, msg)
        }
        this.sessionService.finishRun(sessionId, 0, messages.length)
      } catch {
        // 持久化失败 — 不影响客户端
      }
      state.activeLoop = null
      state.consuming = false
    }
  }

  /**
   * 处理 session:list — 获取会话列表
   */
  private async handleSessionList(ws: WebSocket, data?: { workspaceId?: string }): Promise<void> {
    try {
      const sessions = await this.sessionService.listSessions(data?.workspaceId)
      ws.send(JSON.stringify({ event: 'session:list', data: { sessions } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  /**
   * 处理 session:load — 加载会话历史消息
   */
  private async handleSessionLoad(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    try {
      const messages = await this.sessionService.loadMessages(data.sessionId)
      ws.send(JSON.stringify({ event: 'session:loaded', data: { messages } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  /**
   * 处理 session:create — 创建新会话
   */
  private async handleSessionCreate(ws: WebSocket, data?: SessionConfigPatch): Promise<void> {
    const workspaceDefaults = await this.workspaceService?.getSessionDefaults(data?.workspaceId) ?? {}
    const session = await this.sessionService.createSession({ ...workspaceDefaults, ...(data ?? {}) })
    ws.send(JSON.stringify({ event: 'session:created', data: { sessionId: session.id, session } }))
  }

  private getWorkspaceService(): WorkspaceService {
    if (!this.workspaceService) throw new Error('Workspace service not configured')
    return this.workspaceService
  }

  private async handleWorkspaceList(ws: WebSocket, data?: { includeArchived?: boolean }): Promise<void> {
    const workspaces = await this.getWorkspaceService().listWorkspaces(data?.includeArchived ?? false)
    ws.send(JSON.stringify({ event: 'workspace:list', data: { workspaces } }))
  }

  private async handleWorkspaceGet(ws: WebSocket, data: { workspaceId: string }): Promise<void> {
    const workspace = await this.getWorkspaceService().getWorkspace(data.workspaceId)
    ws.send(JSON.stringify({ event: 'workspace:loaded', data: { workspace } }))
  }

  private async handleWorkspaceCreate(ws: WebSocket, data: { title: string; description?: string }): Promise<void> {
    const workspace = await this.getWorkspaceService().createWorkspace(data)
    ws.send(JSON.stringify({ event: 'workspace:created', data: { workspace } }))
  }

  private async handleWorkspaceUpdate(ws: WebSocket, data: { workspaceId: string; updates: WorkspaceUpdate }): Promise<void> {
    const workspace = await this.getWorkspaceService().updateWorkspace(data.workspaceId, data.updates ?? {})
    ws.send(JSON.stringify({ event: 'workspace:updated', data: { workspace } }))
  }

  private async handleWorkspaceDelete(ws: WebSocket, data: { workspaceId: string }): Promise<void> {
    await this.getWorkspaceService().deleteWorkspace(data.workspaceId)
    ws.send(JSON.stringify({ event: 'workspace:deleted', data: { workspaceId: data.workspaceId } }))
  }

  private async handleWorkspaceAddProject(ws: WebSocket, data: { workspaceId: string; folderPath: string }): Promise<void> {
    const workspace = await this.getWorkspaceService().addProject(data.workspaceId, data.folderPath)
    ws.send(JSON.stringify({ event: 'workspace:updated', data: { workspace } }))
  }

  private async handleWorkspaceRemoveProject(ws: WebSocket, data: { workspaceId: string; projectId: string }): Promise<void> {
    const workspace = await this.getWorkspaceService().removeProject(data.workspaceId, data.projectId)
    ws.send(JSON.stringify({ event: 'workspace:updated', data: { workspace } }))
  }

  /**
   * 处理 session:delete — 删除会话
   */
  private async handleSessionDelete(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    try {
      await this.sessionService.deleteSession(data.sessionId)
      ws.send(JSON.stringify({ event: 'session:deleted', data: { sessionId: data.sessionId } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  /**
   * 处理 session:rename — 重命名会话
   */
  private async handleSessionRename(ws: WebSocket, data: { sessionId: string; title: string }): Promise<void> {
    try {
      await this.sessionService.renameSession(data.sessionId, data.title)
      ws.send(JSON.stringify({ event: 'session:renamed', data: { sessionId: data.sessionId, title: data.title } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  private async handleSessionConfigGet(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    const config = await this.sessionService.getSessionConfig(data.sessionId)
    ws.send(JSON.stringify({ event: 'session:config', data: { sessionId: data.sessionId, config } }))
  }

  private async handleSessionConfigUpdate(ws: WebSocket, data: { sessionId: string; patch: SessionConfigPatch }): Promise<void> {
    const config = await this.sessionService.updateSessionConfig(data.sessionId, data.patch ?? {})
    ws.send(JSON.stringify({ event: 'session:config:updated', data: { sessionId: data.sessionId, config } }))
  }

  /**
   * 处理 chat:stop — 停止当前生成
   */
  private handleStopGeneration(ws: WebSocket, _data?: { sessionId?: string }): void {
    const state = this.getState(ws)
    if (state.activeLoop) {
      state.activeLoop.cancel()
      state.activeLoop = null
      state.consuming = false
      ws.send(JSON.stringify({ event: 'stream:stopped', data: {} }))
    } else {
      ws.send(JSON.stringify({ event: 'stream:stopped', data: { warning: 'no active generation' } }))
    }
  }

  /**
   * 处理 tool:execute — 直接调用 Hand 工具（绕过 AgentLoop，用于测试和调试）
   */
  private async handleToolExecute(ws: WebSocket, data: { name: string; input: Record<string, unknown> }): Promise<void> {
    if (!data.name) {
      ws.send(JSON.stringify({ event: 'tool:result', data: { error: '缺少 name 参数', isError: true } }))
      return
    }
    try {
      const result = await this.toolExecutor.execute(data.name, data.input ?? {}, {
        workingDirectory: process.cwd(),
        projectRoots: [],
        abortSignal: AbortSignal.timeout(30_000),
      })
      ws.send(JSON.stringify({ event: 'tool:result', data: { output: result.output, isError: result.isError } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'tool:result',
        data: { output: err instanceof Error ? err.message : String(err), isError: true },
      }))
    }
  }

  /**
   * 处理 tool:list — 返回所有在线 Hand 的工具定义
   */
  private handleToolList(ws: WebSocket): void {
    const definitions = this.toolExecutor.getDefinitions()
    ws.send(JSON.stringify({ event: 'tool:list', data: { definitions } }))
  }

  /**
   * 处理 WebSocket 关闭
   * 取消活跃的 AgentLoop，清理状态
   */
  private handleClose(ws: WebSocket): void {
    const state = this.connectionStates.get(ws)
    if (state?.activeLoop) {
      state.activeLoop.cancel()
    }
    if (state?.heartbeatTimer) {
      clearInterval(state.heartbeatTimer)
    }
    // 清理该连接的 pending ask-user 问题
    for (const [questionId, pending] of this.pendingQuestions) {
      if (pending.ws === ws) {
        this.pendingQuestions.delete(questionId)
        pending.resolve('')
      }
    }
    // 清理该 client 的所有 terminal（异步 kill — 不等待结果）
    for (const tid of this.terminalRouter.getTerminalsForClient(ws)) {
      const handId = this.terminalRouter.getHandId(tid)
      this.terminalRouter.unregister(tid)
      if (handId) {
        // 尝试通知 Hand 关闭 PTY（best-effort）
        const abort = new AbortController()
        this.toolExecutor.execute('TerminalKill', { terminalId: tid }, {
          workingDirectory: process.cwd(),
          projectRoots: [],
          targetHandId: handId,
          abortSignal: abort.signal,
        }).catch(() => { /* swallow */ })
      }
    }
    this.connectionStates.delete(ws)
  }

  private getState(ws: WebSocket): ConnectionState {
    let state = this.connectionStates.get(ws)
    if (!state) {
      state = { activeLoop: null, consuming: false, permissionMode: DEFAULT_PERMISSION_MODE, heartbeatTimer: null, lastAliveAt: Date.now() }
      this.connectionStates.set(ws, state)
    }
    return state
  }

  /**
   * Terminal:spawn — 选取在线 Hand，调用 TerminalSpawn 工具，
   * 解析 terminalId 并注册到 TerminalSessionRouter
   */
  private async handleTerminalSpawn(
    ws: WebSocket,
    data: { cwd?: string; cols?: number; rows?: number; shell?: string; targetHandId?: string; workspaceId?: string },
  ): Promise<void> {
    // 选择 Hand：优先使用客户端指定的 targetHandId，否则按工具名查找
    let handId: string | null = data.targetHandId ?? null
    if (!handId && this.handsRouter) {
      const hand = this.handsRouter.findHand('TerminalSpawn')
      handId = hand?.id ?? null
    }
    if (!handId) {
      ws.send(JSON.stringify({
        event: 'terminal:spawned',
        data: { error: 'No Hand online provides TerminalSpawn' },
      }))
      return
    }

    const cwd = data.cwd ?? process.cwd()
    const abort = new AbortController()
    const result = await this.toolExecutor.execute('TerminalSpawn', {
      cwd,
      cols: data.cols ?? 80,
      rows: data.rows ?? 24,
      ...(data.shell ? { shell: data.shell } : {}),
    }, {
      workingDirectory: cwd,
      projectRoots: [],
      targetHandId: handId,
      workspaceId: data.workspaceId,
      abortSignal: abort.signal,
    })

    if (result.isError) {
      ws.send(JSON.stringify({ event: 'terminal:spawned', data: { error: result.output } }))
      return
    }

    let terminalId: string | null = null
    try {
      const parsed = JSON.parse(result.output) as { terminalId?: string }
      terminalId = parsed.terminalId ?? null
    } catch {
      ws.send(JSON.stringify({
        event: 'terminal:spawned',
        data: { error: `Failed to parse TerminalSpawn output: ${result.output}` },
      }))
      return
    }

    if (!terminalId) {
      ws.send(JSON.stringify({
        event: 'terminal:spawned',
        data: { error: 'TerminalSpawn did not return terminalId' },
      }))
      return
    }

    this.terminalRouter.register(terminalId, ws, handId)
    ws.send(JSON.stringify({
      event: 'terminal:spawned',
      data: { terminalId, handId },
    }))
  }

  private async handleTerminalWrite(
    ws: WebSocket,
    data: { terminalId: string; data: string },
  ): Promise<void> {
    const handId = this.terminalRouter.getHandId(data.terminalId)
    if (!handId) {
      ws.send(JSON.stringify({
        event: 'terminal:write:ack',
        data: { success: false, terminalId: data.terminalId, error: 'unknown terminalId' },
      }))
      return
    }
    const abort = new AbortController()
    const result = await this.toolExecutor.execute('TerminalWrite', {
      terminalId: data.terminalId,
      data: data.data,
    }, {
      workingDirectory: process.cwd(),
      projectRoots: [],
      targetHandId: handId,
      abortSignal: abort.signal,
    })
    ws.send(JSON.stringify({
      event: 'terminal:write:ack',
      data: { success: !result.isError, terminalId: data.terminalId, ...(result.isError ? { error: result.output } : {}) },
    }))
  }

  private async handleTerminalResize(
    ws: WebSocket,
    data: { terminalId: string; cols: number; rows: number },
  ): Promise<void> {
    const handId = this.terminalRouter.getHandId(data.terminalId)
    if (!handId) {
      ws.send(JSON.stringify({
        event: 'terminal:resize:ack',
        data: { success: false, terminalId: data.terminalId, error: 'unknown terminalId' },
      }))
      return
    }
    const abort = new AbortController()
    const result = await this.toolExecutor.execute('TerminalResize', {
      terminalId: data.terminalId,
      cols: data.cols,
      rows: data.rows,
    }, {
      workingDirectory: process.cwd(),
      projectRoots: [],
      targetHandId: handId,
      abortSignal: abort.signal,
    })
    ws.send(JSON.stringify({
      event: 'terminal:resize:ack',
      data: { success: !result.isError, terminalId: data.terminalId, ...(result.isError ? { error: result.output } : {}) },
    }))
  }

  private async handleTerminalKill(
    ws: WebSocket,
    data: { terminalId: string },
  ): Promise<void> {
    const handId = this.terminalRouter.getHandId(data.terminalId)
    if (!handId) {
      // 已经清理 — 幂等返回
      ws.send(JSON.stringify({
        event: 'terminal:killed',
        data: { terminalId: data.terminalId },
      }))
      return
    }
    const abort = new AbortController()
    const result = await this.toolExecutor.execute('TerminalKill', {
      terminalId: data.terminalId,
    }, {
      workingDirectory: process.cwd(),
      projectRoots: [],
      targetHandId: handId,
      abortSignal: abort.signal,
    })
    this.terminalRouter.unregister(data.terminalId)
    ws.send(JSON.stringify({
      event: 'terminal:killed',
      data: { terminalId: data.terminalId, ...(result.isError ? { error: result.output } : {}) },
    }))
  }

  /** 统一封装 terminal 错误回包 */
  private sendTerminalError(ws: WebSocket, ackEvent: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    try {
      ws.send(JSON.stringify({ event: ackEvent, data: { success: false, error: message } }))
    } catch {
      // ignore
    }
  }
}
