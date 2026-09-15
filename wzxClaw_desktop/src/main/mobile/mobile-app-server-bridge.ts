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
// - command:send/stop → session/subscribe + session/send，通知经翻译表转
//   stream:agent:* 广播给手机
// - app-server 反向请求（runtimePreferences 代答 / interaction/requestPermission
//   转推手机 permission:response 应答 / 未知安全拒绝）
// - 未支持事件返回 false（回落旧处理器）
//
// 协议事实源：relay/zcode/APP-SERVER.md（实测记录）。
// 默认关闭：未设 WZXCLAW_BRAIN_ENGINE=1 时 enabled() === false，
// 全部事件回落旧路径（现有测试/E2E 零影响）。
// ============================================================

import type { MobileRelayContext } from './mobile-relay-context'
import path from 'node:path'

import { AppServerEngine } from '../agent/app-server-engine'
import { translateEngineEvent, toolCallIdOfPart } from '../agent/app-server-translate'

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

/** 应用退出时停桥（before-quit 调用；幂等） */
export function stopBrainBridge(): void {
  const bridge = sharedBridge
  sharedBridge = null
  if (bridge) void bridge.stop()
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
  on(event: 'reverseRequest', listener: (frame: EngineFrame) => void): unknown
  /** 反向请求应答（字符串 id 原样回传） */
  respond?(id: string | number, result: unknown): void
  respondError?(id: string | number, code: number, message: string): void
  /** 成功回合后重置引擎重启预算（与 companion 同口径，在桥层调用） */
  resetRestartBudget?(): void
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
  /** 等待手机应答的反向请求：engine 帧 id（server-N）-> 原帧。id 会从头复用，须及时清理 */
  private readonly pendingPermission = new Map<string | number, EngineFrame>()
  private stopped = false

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
      // 注入引擎（测试）同样接收事件：翻译表与广播路径一致
      this.engine.on('notification', (frame) => this._onEngineNotification(frame))
      this.engine.on('reverseRequest', (frame) => this._onEngineReverseRequest(frame))
    }
  }

  /** 引擎懒启动（幂等）；返回可用引擎或 null（无法启动） */
  private ensureEngine(): EngineLike | null {
    if (this.engine) return this.engine
    if (this.stopped || !this.engineCommand) {
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
        // Electron 主进程里 process.execPath 是 Electron 二进制：不加此开关
        // 会拉起第二个 GUI 实例而非 node；对真 node 该变量无副作用
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      logger: this.logger,
    })
    created.on('notification', (frame: { method?: string; params?: unknown }) => {
      this._onEngineNotification(frame)
    })
    created.on('reverseRequest', (frame: { id?: number | string; method?: string; params?: unknown }) => {
      this._onEngineReverseRequest(frame)
    })
    created.on('dead', (why: string) => this.logger('brain-engine-dead', why))
    created.start()
    this.engine = created as unknown as EngineLike
    return this.engine
  }

  /** 停桥：杀引擎并作废待答反向请求（幂等） */
  async stop(): Promise<void> {
    if (this.stopped && !this.engine) return
    this.stopped = true
    this.pendingPermission.clear()
    const engine = this.engine
    this.engine = null
    if (engine) await engine.stop()
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
      case 'permission:response':
        this._onPermissionResponse(d)
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
    const frame = await engine.request(method, params, timeoutMs)
    // 与 companion 同口径：一次健康往返（引擎给了非超时/非停机应答）证明
    // 链路存活，重置崩溃重启预算——长会话不应累积重启计数
    if (!frame.error || frame.error.code !== -32000) engine.resetRestartBudget?.()
    return frame
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
      // -32004：会话正被另一进程（桌面本地引擎）运行——不可读是设计而非故障
      const isBusy = resume.error.code === -32004
      this.broadcast('session:error', {
        requestId,
        error: isBusy ? '该会话正在桌面端运行中，手机端无法查看其流式过程' : str(resume.error.message),
        code: isBusy ? 'SESSION_BUSY' : 'SESSION_NOT_FOUND',
      })
      return
    }
    const sub = await this._request(engine, 'session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' })
    if (sub.error) this.logger('brain-subscribe-failed', `${str(sub.error.code)} ${sessionId}`)
    const messages = await this._request(engine, 'session/messages', { sessionId, limit: 200 })
    if (messages.error) {
      this.broadcast('session:error', { requestId, error: str(messages.error.message) || 'session/messages failed' })
      return
    }
    const rows = asRecord(messages.result)?.messages as Array<Record<string, unknown>> | undefined
    const mapped = (rows ?? []).map((row) => this._mapEngineMessage(row, sessionId)).filter(Boolean)
    // 分页诚实：拉满一页说明可能还有更早消息，不谎报 hasMore:false
    this.broadcast('session:load:response', {
      requestId,
      sessionId,
      messages: mapped,
      total: mapped.length,
      offset: 0,
      hasMore: (rows?.length ?? 0) >= 200,
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
    // 先订阅后发送：send 落地到引擎产生首帧事件的窗口极短，后订阅会丢开头事件
    const sub = await this._request(engine, 'session/subscribe', {
      sessionId,
      deliveryKind: 'web-remote-replayable',
    })
    if (sub.error) this.logger('brain-subscribe-failed', `${str(sub.error.code)} ${sessionId}`)
    const resp = await this._request(engine, 'session/send', { sessionId, content })
    if (resp.error) {
      this.broadcast('stream:agent:error', { sessionId, error: str(resp.error.message) })
      return
    }
    if (typeof resp.result === 'string') {
      this.broadcast('stream:agent:error', { sessionId, error: resp.result })
      return
    }
  }

  private _onCommandStop(d: Record<string, unknown>, engine: EngineLike): void {
    const sessionId = str(d.sessionId) || this.activeSessionId
    if (sessionId) void engine.request('session/stop', { sessionId })
  }

  /** 引擎通知 → 翻译表 → stream:agent:* 广播 */
  private _onEngineNotification(frame: EngineFrame): void {
    const params = asRecord(frame.params)
    if (!params) return
    if (frame.method !== 'session/event') {
      // state.updated / v4/telemetry 等：无旧协议对应，留观测
      this.logger('brain-notify-unhandled', frame.method || '(no method)')
      return
    }
    const sessionId = str(params.sessionId) || this.activeSessionId || ''
    const events = params.events
    if (Array.isArray(events)) {
      // subscribe 应答快照：事件数组，sessionId 在事件内
      for (const ev of events) {
        const rec = asRecord(ev)
        if (!rec) continue
        const type = str(rec.type)
        for (const out of translateEngineEvent(str(rec.sessionId) || sessionId, type, rec.payload !== undefined ? rec.payload : rec)) {
          this.broadcast(out.event, out.data)
        }
      }
      return
    }
    // 实测推送形状：单事件 type/payload 在 params 顶层
    const type = str(params.type)
    // permission.resolved：服务端已裁决 → 清待答反向请求（防 server-N 复用串台）
    if (type === 'permission.resolved') {
      const payload = asRecord(params.payload) ?? {}
      const key = str(payload.requestId) || str(payload.toolCallId)
      for (const [id, frame] of this.pendingPermission) {
        const p = asRecord(frame.params) ?? {}
        if (str(p.requestId) === key || str(p.toolCallId) === key) this.pendingPermission.delete(id)
      }
    }
    for (const out of translateEngineEvent(sessionId, type, params.payload)) {
      this.broadcast(out.event, out.data)
    }
  }

  // ---- app-server 反向请求 → 手机应答 ----

  private _onEngineReverseRequest(frame: EngineFrame): void {
    const id = frame.id
    if (id === undefined || id === null) return
    const params = asRecord(frame.params) ?? {}
    if (frame.method === 'session/requestRuntimePreferences') {
      // 实测契约（APP-SERVER.md）：必须应答 {nativeSearchEnhancementsEnabled: false}
      if (this.engine?.respond) this.engine.respond(id, { nativeSearchEnhancementsEnabled: false })
      return
    }
    if (frame.method === 'interaction/requestPermission') {
      const toolCallId = str(params.toolCallId) || str(params.requestId) || String(id)
      this.pendingPermission.set(id, frame)
      this.broadcast('stream:agent:permission_request', {
        requestId: str(params.requestId) || toolCallId,
        toolCallId,
        toolName: str(params.toolName),
        input: params.input ?? {},
        reason: str(params.reason),
        riskLevel: str(params.riskLevel),
        options: Array.isArray(params.options) ? params.options : [],
        sessionId: str(params.sessionId) || this.activeSessionId || '',
      })
      return
    }
    // 未知反向请求：安全拒绝（error 帧），不假成功；留观测
    this.logger('brain-reverse-request-deny', frame.method || '(no method)')
    if (this.engine?.respondError) this.engine.respondError(id, -32000, `手机端未处理该反向请求: ${frame.method}`)
  }

  /** 手机权限应答 {requestId?, toolCallId?, approved, remember?} → 回放 option.response 原文 */
  private _onPermissionResponse(d: Record<string, unknown>): void {
    const key = str(d.toolCallId) || str(d.requestId)
    let frameId: string | number | null = null
    for (const [id, frame] of this.pendingPermission) {
      const p = asRecord(frame.params) ?? {}
      if (str(p.toolCallId) === key || str(p.requestId) === key) { frameId = id; break }
    }
    if (frameId === null) {
      // 迟到/未知应答：丢弃但留观测
      this.logger('brain-permission-response-late', key.slice(0, 40))
      return
    }
    const frame = this.pendingPermission.get(frameId)!
    this.pendingPermission.delete(frameId)
    const approved = d.approved === true
    // 语义映射（手机旧 UI 档位 → app-server optionId）：批准且 remember →
    // allow_project（服务端 kind=allow_always，语义近似）；批准 → allow_once；
    // 拒绝 → deny。实测 result 必须是 option.response 原文，畸形 result 被
    // 服务端静默判为 deny（APP-SERVER.md「畸形应答实验」）。
    const wanted = approved ? (d.remember === true ? 'allow_project' : 'allow_once') : 'deny'
    const params = asRecord(frame.params) ?? {}
    const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : []
    let result: Record<string, unknown> | null = null
    for (const option of options) {
      if (option && (str(option.optionId) === wanted || str(option.kind) === wanted) && asRecord(option.response)) {
        result = asRecord(option.response)!
        break
      }
    }
    if (!result) {
      // 请求未带 options（异常）时按实测 schema 兜底构造
      result = { decision: approved ? 'allow' : 'deny', reason: approved ? 'Approved once' : 'Denied' }
    }
    if (this.engine?.respond) this.engine.respond(frameId, result)
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
    // 不伪造当前时刻：info 缺时间戳用部件时间兜底，再缺则 0
    const time = asRecord(info.time)
    let createdAt = time && typeof time.created === 'number' ? time.created : 0
    for (const raw of parts) {
      const part = asRecord(raw)
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string') content += part.text
      else if (part.type === 'tool') {
        const state = asRecord(part.state) ?? {}
        toolCalls.push({
          // 实测字段为 callID（大写 D）；callId 只作旧版本兼容回退
          toolCallId: toolCallIdOfPart(part, state),
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
      } else if (!createdAt && asRecord(part.time) && typeof asRecord(part.time)!.created === 'number') {
        createdAt = asRecord(part.time)!.created as number
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
