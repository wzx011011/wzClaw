// ============================================================
// mobile-app-server-bridge — M3 大脑模式桥（v3）
//
// 当启用（WZXCLAW_BRAIN_ENGINE=1）时，手机遥控路径由 ZCode 官方
// app-server 引擎供数：会话与聊天事件不再走桌面本地 Brain/SessionStore，
// 而是经 AppServerEngine（stdio）由 app-server 引擎提供。
//
// 职责：
// - 引擎生命周期（懒启动，随 workspace；崩溃自动重启由引擎内部处理）
// - session:list/load/create → app-server 对应方法，映射回旧响应形状
// - command:send/stop → session/send + subscribe，通知经翻译表转
//   stream:agent:* 广播给手机
// - 未支持事件返回 false（回落旧处理器）
//
// 默认关闭：未设 WZXCLAW_BRAIN_ENGINE=1 时 enabled() === false，
// 全部事件回落旧路径（现有测试/E2E 零影响）。
// ============================================================

import type { MobileRelayContext } from './mobile-relay-context'
import path from 'node:path'

import { AppServerEngine } from '../agent/app-server-engine'
import { translateEnginePayload } from '../agent/app-server-translate'

const ENGINE_ENV_FLAG = 'WZXCLAW_BRAIN_ENGINE'

export function brainEngineEnabled(): boolean {
  return process.env[ENGINE_ENV_FLAG] === '1'
}

let sharedBridge: MobileAppServerBridge | null = null

/**
 * 获取大脑模式桥（单例；未启用返回 null）。
 * 引擎命令：WZXCLAW_BRAIN_NODE（默认 process.execPath）+
 * WZXCLAW_BRAIN_CJS（zcode.cjs 路径，可选）。
 */
export function getBrainBridge(ctx: MobileRelayContext): MobileAppServerBridge | null {
  if (!brainEngineEnabled()) return null
  if (sharedBridge) return sharedBridge
  const root = ctx.workspaceManager.getWorkspaceRoot() || ctx.getWorkingDirectory()
  sharedBridge = new MobileAppServerBridge({
    cwd: root,
    brainName: path.basename(root),
    apiKey: ctx.settingsManager.getCurrentConfig().apiKey,
    broadcast: ctx.broadcastToMobile,
    engineCommand: process.env.WZXCLAW_BRAIN_NODE || process.execPath,
    engineArgs: process.env.WZXCLAW_BRAIN_CJS ? [process.env.WZXCLAW_BRAIN_CJS] : undefined,
    logger: (event, detail) => console.log('[brain-bridge]', event, detail ?? ''),
  })
  return sharedBridge
}

/** 仅测试使用：重置共享单例 */
export function resetBrainBridgeForTest(): void {
  sharedBridge = null
}

/** 引擎子进程句柄（最小接口，测试可注入替身） */
export interface EngineLike {
  start(): void
  stop(): Promise<void>
  request(method: string, params?: unknown, timeoutMs?: number): Promise<EngineFrame>
  on(event: 'notification', listener: (frame: EngineFrame) => void): unknown
  running: boolean
}

export interface EngineFrame {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number | string; message?: string }
}

/** 手机端响应帧（旧 WsEvents 信封） */
interface Broadcast {
  (event: string, data: unknown): void
}

export interface BrainBridgeOptions {
  /** 引擎可执行文件（默认 node） */
  engineCommand?: string
  /** 引擎附加参数（zcode.cjs 路径等） */
  engineArgs?: string[]
  cwd: string
  /** 模型凭据（注入引擎环境，编码计划 key） */
  apiKey?: string
  brainName?: string
  broadcast: Broadcast
  /** 测试注入引擎替身 */
  engine?: EngineLike
  logger?: (event: string, detail?: string) => void
}

interface PendingRequest {
  resolve: (frame: EngineFrame) => void
  timer: NodeJS.Timeout
}

/** 大脑模式桥：管理引擎并翻译手机事件 */
export class MobileAppServerBridge {
  private engine: EngineLike | null = null
  private readonly broadcast: Broadcast
  private readonly cwd: string
  private readonly brainName: string
  private readonly engineCommand?: string
  private readonly engineArgs?: string[]
  private readonly apiKey?: string
  private readonly logger: (event: string, detail?: string) => void
  private activeSessionId: string | null = null

  constructor(options: BrainBridgeOptions) {
    this.broadcast = options.broadcast
    this.cwd = options.cwd
    this.brainName = options.brainName ?? 'brain'
    this.engineCommand = options.engineCommand
    this.engineArgs = options.engineArgs
    this.apiKey = options.apiKey
    this.logger = options.logger ?? (() => {})
    if (options.engine) {
      this.engine = options.engine
      // 注入引擎（测试）同样接收通知：翻译表与广播路径一致
      this.engine.on('notification', (frame) => this._onEngineNotification(frame))
    }
  }

  /** 引擎懒启动（幂等）；返回可用引擎或 null（无法启动） */
  private ensureEngine(): EngineLike | null {
    if (this.engine) return this.engine
    if (!this.engineCommand) {
      this.logger('brain-no-engine', '')
      return null
    }
    const created = new AppServerEngine({
      command: this.engineCommand,
      args: this.engineArgs ?? [],
      cwd: this.cwd,
      env: {
        ...process.env,
        ...(this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : {}),
      },
      logger: this.logger,
    })
    created.on('notification', (frame: { method?: string; params?: unknown }) => {
      this._onEngineNotification(frame)
    })
    created.on('dead', (why: string) => this.logger('brain-engine-dead', why))
    created.start()
    this.engine = created as unknown as EngineLike
    return this.engine
  }

  /**
   * 处理一条手机消息（引擎模式）。
   * 返回 true=已处理；false=本桥不处理该事件（交回旧处理器）。
   */
  async handleMessage(event: string, data: unknown): Promise<boolean> {
    const engine = this.ensureEngine()
    if (!engine) return false
    const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    switch (event) {
      case 'session:list:request':
        await this._onSessionList(d, engine)
        return true
      case 'session:load:request':
        await this._onSessionLoad(d, engine)
        return true
      case 'session:create:request':
        await this._onSessionCreate(d, engine)
        return true
      case 'command:send':
        await this._onCommandSend(d, engine)
        return true
      case 'command:stop':
        this._onCommandStop(d, engine)
        return true
      default:
        return false
    }
  }

  private async _request(
    engine: EngineLike,
    method: string,
    params?: unknown,
    timeoutMs = 30000,
  ): Promise<EngineFrame> {
    return engine.request(method, params, timeoutMs)
  }

  private async _onSessionList(d: Record<string, unknown>, engine: EngineLike): Promise<void> {
    const requestId = str(d.requestId)
    const resp = await this._request(engine, 'session/list')
    if (resp.error) {
      this.broadcast('session:error', { requestId, error: str(resp.error.message), code: 'INTERNAL_ERROR' })
      return
    }
    const result = asRecord(resp.result)
    const sessions = (result?.sessions as Array<Record<string, unknown>> ?? []).map((s) => ({
      id: str(s.sessionId),
      title: str(s.title) || str(s.sessionId),
      createdAt: num(s.createdAt),
      updatedAt: num(s.updatedAt),
      messageCount: 0,
      preview: '',
      isRunning: s.status === 'running',
    }))
    this.broadcast('session:list:response', {
      requestId,
      workspaceName: this.brainName,
      workspacePath: this.cwd,
      sessions,
      runningSessionIds: sessions.filter((s) => s.isRunning).map((s) => s.id),
      taskStatuses: {},
      activeSessionId: this.activeSessionId,
    })
  }

  private async _onSessionLoad(d: Record<string, unknown>, engine: EngineLike): Promise<void> {
    const requestId = str(d.requestId)
    const sessionId = str(d.sessionId)
    const resume = await this._request(engine, 'session/resume', { sessionId })
    if (resume.error) {
      this.broadcast('session:error', {
        requestId,
        error: str(resume.error.message),
        code: 'SESSION_NOT_FOUND',
      })
      return
    }
    await this._request(engine, 'session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' })
    const messages = await this._request(engine, 'session/messages', { sessionId, limit: 200 })
    const rows = asRecord(messages.result)?.messages as Array<Record<string, unknown>> | undefined
    const mapped = (rows ?? []).map((row) => this._mapEngineMessage(row, sessionId)).filter(Boolean)
    this.broadcast('session:load:response', {
      requestId,
      sessionId,
      messages: mapped,
      total: mapped.length,
      offset: 0,
      hasMore: false,
    })
    this.activeSessionId = sessionId
  }

  private async _onSessionCreate(d: Record<string, unknown>, engine: EngineLike): Promise<void> {
    const requestId = str(d.requestId)
    const resp = await this._request(engine, 'session/create', {
      workspace: { workspaceKey: this.cwd, workspacePath: this.cwd },
    })
    if (resp.error) {
      this.broadcast('session:create:response', { requestId, error: str(resp.error.message) })
      return
    }
    const session = asRecord(resp.result)?.session as Record<string, unknown> | undefined
    const sessionId = str(session?.sessionId)
    this.broadcast('session:create:response', {
      requestId,
      session: {
        id: sessionId,
        title: str(d.title) || 'New Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      },
    })
    if (sessionId) this.activeSessionId = sessionId
  }

  private async _onCommandSend(d: Record<string, unknown>, engine: EngineLike): Promise<void> {
    const content = str(d.content)
    const messageId = str(d.messageId)
    const sessionId = str(d.sessionId) || this.activeSessionId || ''
    if (messageId) this.broadcast('command:ack', { messageId, status: 'received' })
    if (!sessionId || !content) {
      this.broadcast('stream:agent:error', { sessionId, error: '缺少会话或内容' })
      return
    }
    this.activeSessionId = sessionId
    const resp = await this._request(engine, 'session/send', { sessionId, content })
    if (resp.error) {
      this.broadcast('stream:agent:error', { sessionId, error: str(resp.error.message) })
      return
    }
    if (typeof resp.result === 'string') {
      this.broadcast('stream:agent:error', { sessionId, error: resp.result })
      return
    }
    await this._request(engine, 'session/subscribe', {
      sessionId,
      deliveryKind: 'web-remote-replayable',
    })
  }

  private _onCommandStop(d: Record<string, unknown>, engine: EngineLike): void {
    const sessionId = str(d.sessionId) || this.activeSessionId
    if (sessionId) void engine.request('session/stop', { sessionId })
  }

  /** 引擎通知 → 翻译表 → stream:agent:* 广播 */
  private _onEngineNotification(frame: EngineFrame): void {
    const params = asRecord(frame.params)
    if (!params) return
    const sessionId = str(params.sessionId) || this.activeSessionId
    const events = params.events
    if (Array.isArray(events)) {
      for (const ev of events) {
        const payload = asRecord(ev) ? (asRecord(ev)!.payload ?? ev) : ev
        for (const frameOut of translateEnginePayload(sessionId, payload)) {
          this.broadcast(frameOut.event, frameOut.data)
        }
      }
      return
    }
    for (const frameOut of translateEnginePayload(sessionId, params)) {
      this.broadcast(frameOut.event, frameOut.data)
    }
  }

  /** app-server 消息行（info+parts）→ 旧 ChatMessage JSON（snake_case） */
  private _mapEngineMessage(row: Record<string, unknown>, sessionId: string): Record<string, unknown> | null {
    const info = asRecord(row.info)
    if (!info) return null
    const role = str(info.role) === 'user' ? 'user' : 'assistant'
    const parts = Array.isArray(row.parts) ? row.parts : []
    let content = ''
    const toolCalls: Array<Record<string, unknown>> = []
    let usage: Record<string, unknown> | null = null
    let createdAt = Date.now()
    const time = asRecord(info.time)
    if (time && typeof time.created === 'number') createdAt = time.created
    for (const raw of parts) {
      const part = asRecord(raw)
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string') content += part.text
      else if (part.type === 'tool') {
        const state = asRecord(part.state) ?? {}
        toolCalls.push({
          toolCallId: str(part.callId ?? state.callId),
          toolName: str(part.tool ?? state.tool),
          inputSummary: typeof state.input === 'string' ? state.input.slice(0, 200) : undefined,
          outputSummary: typeof state.output === 'string' ? state.output.slice(0, 200) : undefined,
          status: state.status === 'completed' ? 'done' : state.status === 'error' ? 'error' : 'running',
          isError: state.status === 'error',
        })
      } else if (part.type === 'step-finish') {
        const tokens = asRecord(part.tokens)
        if (tokens) {
          usage = { input_tokens: tokens.total ?? 0, output_tokens: tokens.output ?? 0 }
        }
      }
    }
    if (!content && toolCalls.length === 0) return null
    return {
      role,
      content,
      created_at: createdAt,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
      session_id: sessionId,
    }
  }
}

// ── 小工具 ──

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
