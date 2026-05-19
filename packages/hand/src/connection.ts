// ============================================================
// HandConnection — Hand 与 agent-server 的 WebSocket 连接管理
// 管理完整的连接生命周期：连接、认证、注册、心跳、断连重连
// ============================================================

import { createRequire } from 'node:module'
import type { HandConfig, ExecuteCallbackData, IncomingExecuteMessage, HandToolDefinition } from './types.js'
import { HandStatus } from './types.js'
import {
  createRegisterMessage,
  createResultMessage,
  createHeartbeatMessage,
  parseIncomingMessage,
} from './protocol.js'

const require = createRequire(import.meta.url)

/** WebSocket-like 接口（用于依赖注入和测试） */
export interface IWebSocket {
  readyState: number
  on(event: string, handler: (...args: unknown[]) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** WebSocket 工厂函数类型 */
export type WebSocketFactory = (url: string, protocols?: string | string[]) => IWebSocket

/** HandConnection 回调集合 */
export interface HandConnectionCallbacks {
  /** 收到工具执行请求 */
  onExecute?: (data: ExecuteCallbackData) => void
  /** 收到 reload 控制帧 */
  onReload?: () => void
  /** 连接断开（非主动关闭） */
  onDisconnect?: () => void
  /** 状态变更通知 */
  onStatusChange?: (status: HandStatus) => void
  /** WebSocket 工厂（用于测试注入） */
  wsFactory?: WebSocketFactory
  /** 注册时上报的工具名列表 */
  capabilities?: string[]
  /** 注册时上报的工具定义列表 */
  definitions?: HandToolDefinition[]
}

/** 默认心跳间隔（15s） */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/** 默认重连基础间隔（1s） */
const DEFAULT_RECONNECT_BASE_MS = 1_000

/** 默认最大重连次数 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10

/** 默认最大重连间隔（30s） */
const DEFAULT_RECONNECT_MAX_MS = 30_000

/**
 * HandConnection — 管理 Hand 与 agent-server 的 WebSocket 连接
 *
 * 职责:
 * - 建立 WebSocket 连接并携带 token 认证
 * - 连接建立后自动发送 hand:register 消息
 * - 定期发送心跳保持连接活性
 * - 收到 hand:execute 时触发回调
 * - 连接断开时自动指数退避重连
 */
export class HandConnection {
  private readonly config: HandConfig
  private readonly callbacks: HandConnectionCallbacks

  /** 当前 WebSocket 实例 */
  private ws: IWebSocket | null = null

  /** 当前连接状态 */
  private status: HandStatus = HandStatus.Disconnected

  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /** 重连定时器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** 当前重连尝试次数 */
  private reconnectAttempts = 0

  /** 是否主动关闭（不触发重连） */
  private intentionalClose = false

  /** Hand 唯一标识符（配置提供或自动生成） */
  private readonly handId: string

  constructor(config: HandConfig, callbacks: HandConnectionCallbacks = {}) {
    this.config = config
    this.callbacks = callbacks
    this.handId = config.handId || this.generateHandId()
  }

  /**
   * 建立与 agent-server 的 WebSocket 连接
   *
   * 1. 拼接 URL（附加 ?type=hand）
   * 2. 通过 Sec-WebSocket-Protocol 头携带 token
   * 3. 监听 open/message/close/error 事件
   */
  connect(): void {
    if (this.status === HandStatus.Connecting || this.status === HandStatus.Registering) {
      return // 避免重复连接
    }

    this.intentionalClose = false
    this.setStatus(HandStatus.Connecting)

    // 拼接连接 URL
    const baseUrl = this.config.serverUrl.replace(/\/+$/, '')
    const separator = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${separator}type=hand`

    // 创建 WebSocket（使用注入的工厂或默认的 ws 模块）
    const factory = this.callbacks.wsFactory || this.defaultWebSocketFactory
    this.ws = factory(url, `wzxclaw-${this.config.authToken}`)

    // 注册事件处理
    this.ws.on('open', () => this.handleOpen())
    this.ws.on('message', (data: unknown) => this.handleMessage(data))
    this.ws.on('close', (code: unknown, reason: unknown) =>
      this.handleClose(Number(code), String(reason)),
    )
    this.ws.on('error', (err: unknown) => this.handleError(err as Error),
    )
  }

  /**
   * 发送工具执行结果
   *
   * @param callId - 调用唯一标识符
   * @param output - 执行输出
   * @param isError - 是否为错误结果
   */
  sendResult(callId: string, output: string, isError: boolean): void {
    if (this.status !== HandStatus.Connected || !this.ws) {
      return
    }
    this.ws.send(createResultMessage(callId, output, isError))
  }

  /**
   * 发送任意 JSON 帧（用于 terminal:data / terminal:exit 等推送帧）
   *
   * @param frame 已序列化的 JSON 字符串（由 protocol.ts 的工厂函数构造）
   */
  sendFrame(frame: string): void {
    if (this.status !== HandStatus.Connected || !this.ws) {
      return
    }
    this.ws.send(frame)
  }

  /**
   * 主动断开连接（不触发重连）
   */
  disconnect(): void {
    this.intentionalClose = true
    this.stopHeartbeat()
    this.clearReconnectTimer()

    if (this.ws) {
      this.ws.close(1000, 'hand disconnect')
    }

    this.ws = null
    this.setStatus(HandStatus.Disconnected)
  }

  /**
   * 获取当前连接状态
   */
  getStatus(): HandStatus {
    return this.status
  }

  // ---- 内部方法 ----

  /**
   * 连接建立处理：发送注册消息，启动心跳
   */
  private handleOpen(): void {
    const caps = this.callbacks.capabilities ?? []
    const defs = this.callbacks.definitions ?? []
    const registerMsg = createRegisterMessage(this.handId, caps, defs)
    this.ws!.send(registerMsg)

    this.setStatus(HandStatus.Connected)
    this.startHeartbeat()

    // 连接成功，重置重连计数
    this.reconnectAttempts = 0
  }

  /**
   * 消息处理：解析并分发到对应回调
   */
  private handleMessage(raw: unknown): void {
    const str = typeof raw === 'string' ? raw : String(raw)
    const message = parseIncomingMessage(str)
    if (!message) return

    if (message.event === 'hand:execute') {
      const execMsg = message as IncomingExecuteMessage
      this.callbacks.onExecute?.({
        callId: execMsg.data.callId,
        name: execMsg.data.name,
        input: execMsg.data.input,
        context: execMsg.data.context,
      })
    } else if (message.event === 'hand:heartbeat_ack') {
      // 收到心跳确认，连接正常
    } else if (message.event === 'hand:reload') {
      // 收到 reload 控制帧，触发回调
      this.callbacks.onReload?.()
    }
  }

  /**
   * 连接关闭处理：停止心跳，触发回调，启动重连
   */
  private handleClose(_code: number, _reason: string): void {
    this.stopHeartbeat()
    this.ws = null
    this.setStatus(HandStatus.Disconnected)

    if (!this.intentionalClose) {
      this.callbacks.onDisconnect?.()
      this.scheduleReconnect()
    }
  }

  /**
   * 错误处理：记录错误日志
   */
  private handleError(_err: Error): void {
    // 错误事件后通常会紧跟 close 事件，不需要额外处理
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.status === HandStatus.Connected) {
        this.ws.send(createHeartbeatMessage())
      }
    }, interval)
  }

  /**
   * 停止心跳定时器
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 调度重连（指数退避）
   */
  private scheduleReconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    if (this.reconnectAttempts >= maxAttempts) {
      return // 超过最大重连次数
    }

    const baseMs = this.config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    const maxMs = this.config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    const delay = Math.min(baseMs * Math.pow(2, this.reconnectAttempts), maxMs)

    this.setStatus(HandStatus.Reconnecting)
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  /**
   * 清除重连定时器
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * 设置状态并触发回调
   */
  private setStatus(status: HandStatus): void {
    this.status = status
    this.callbacks.onStatusChange?.(status)
  }

  /**
   * 生成唯一 Hand ID
   */
  private generateHandId(): string {
    const os = require('os') as typeof import('os')
    const hostname = os.hostname()
    const pid = process.pid
    const random = Math.random().toString(36).substring(2, 8)
    return `hand-${hostname}-${pid}-${random}`
  }

  /**
   * 默认 WebSocket 工厂（使用 ws 模块）
   * 延迟加载 ws 模块以避免测试环境依赖
   */
  private defaultWebSocketFactory: WebSocketFactory = (url: string, protocols?: string | string[]) => {
    const WS = require('ws')
    const WsClass = (WS.default && typeof WS.default === 'function' ? WS.default : WS) as new (url: string, protocols?: string | string[]) => IWebSocket
    const ws = new WsClass(url, protocols)
    return ws
  }
}
