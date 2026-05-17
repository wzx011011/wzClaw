// ============================================================
// HandBridge — 桌面端 Hand Bridge 服务
// 管理桌面端作为 Hand 注册到 NAS Agent Server 的完整生命周期
//
// 职责:
// - WebSocket 连接建立 + token 认证
// - 发送包含完整工具定义的 hand:register 消息
// - 心跳定时器保持连接活性
// - 指数退避重连
// - hand:execute 消息处理 → 路由到 LocalToolExecutor
// - hand:result 发送
//
// 注意: 不使用 HandConnection 类（其 handleOpen 发送空注册消息），
// 而是直接复用 @wzxclaw/hand 的协议函数和类型定义。
// ============================================================

import type { HandConfig, HandToolDefinition, IncomingMessage } from '@wzxclaw/hand'
import { HandStatus } from '@wzxclaw/hand'
import {
  createRegisterMessage,
  createResultMessage,
  createHeartbeatMessage,
  parseIncomingMessage,
} from '@wzxclaw/hand'
import { LocalToolExecutor } from '@wzxclaw/hand'
import type { HandTool } from '@wzxclaw/hand'
import { adaptAllTools } from './tool-hand-adapter'
import type { ToolRegistry } from './tools/tool-registry'

// ---- 依赖接口 ----

/** SettingsManager 接口（仅暴露 HandBridge 需要的方法） */
export interface ISettingsManager {
  getRelayToken(): string | undefined
  /** NAS Agent Server URL（如 wss://5945.top/agent/ 或 ws://localhost:8082/） */
  _agentUrl?: string
}

/** WebSocket 工厂函数类型（用于依赖注入和测试） */
export type WebSocketFactory = (url: string, protocols?: string | string[]) => IWebSocket

/** WebSocket-like 接口（与 @wzxclaw/hand 一致） */
export interface IWebSocket {
  readyState: number
  on(event: string, handler: (...args: unknown[]) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** HandBridge 构造参数 */
export interface HandBridgeOptions {
  /** 桌面端工具注册表 */
  toolRegistry: ToolRegistry
  /** 设置管理器（读取 relay token 等） */
  settingsManager: ISettingsManager
  /** 默认工作目录 */
  workingDirectory: string
  /** WebSocket 工厂（用于测试注入，默认使用 ws 模块） */
  wsFactory?: WebSocketFactory
  /** 额外配置覆盖 */
  configOverrides?: Partial<HandConfig>
}

// ---- 常量 ----

/** 默认心跳间隔（15s） */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/** 默认重连基础间隔（1s） */
const DEFAULT_RECONNECT_BASE_MS = 1_000

/** 默认最大重连次数 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10

/** 默认最大重连间隔（30s） */
const DEFAULT_RECONNECT_MAX_MS = 30_000

/**
 * HandBridge — 管理桌面端作为 Hand 的完整生命周期
 *
 * 工作流:
 * 1. connect() 从 settingsManager 读取配置
 * 2. 建立 WebSocket 连接到 NAS Agent Server
 * 3. 连接建立后发送 hand:register 消息（包含完整工具定义）
 * 4. 定期发送心跳
 * 5. 收到 hand:execute 时路由到 LocalToolExecutor 执行
 * 6. 将执行结果通过 hand:result 返回
 * 7. 连接断开时自动指数退避重连
 */
export class HandBridge {
  private readonly toolRegistry: ToolRegistry
  private readonly settingsManager: ISettingsManager
  private readonly workingDirectory: string
  private readonly wsFactory: WebSocketFactory
  private readonly configOverrides: Partial<HandConfig>

  /** 本地工具执行器 */
  private executor: LocalToolExecutor | null = null

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

  /** Hand 唯一标识符 */
  private readonly handId: string

  /** 外部状态变化监听器 */
  private statusListeners: ((status: HandStatus) => void)[] = []

  constructor(options: HandBridgeOptions) {
    this.toolRegistry = options.toolRegistry
    this.settingsManager = options.settingsManager
    this.workingDirectory = options.workingDirectory
    this.wsFactory = options.wsFactory ?? this.defaultWebSocketFactory
    this.configOverrides = options.configOverrides ?? {}
    this.handId = this.configOverrides.handId ?? this.generateHandId()
  }

  /**
   * 建立 Hand 连接
   *
   * 1. 从 settingsManager 读取配置
   * 2. 注册所有桌面端工具到 LocalToolExecutor
   * 3. 建立 WebSocket 连接
   */
  connect(): void {
    if (this.status === HandStatus.Connecting || this.status === HandStatus.Connected) {
      return // 避免重复连接
    }

    // 读取配置（支持 E2E 测试 env var 注入）
    const serverUrl =
      this.configOverrides.serverUrl ??
      this.settingsManager._agentUrl ??
      process.env.WZXCLAW_AGENT_URL ??
      'ws://localhost:8082'
    const authToken =
      this.configOverrides.authToken ??
      this.settingsManager.getRelayToken() ??
      process.env.WZXCLAW_AGENT_TOKEN ??
      ''

    if (!authToken) {
      console.warn('[HandBridge] 未配置 token，跳过连接')
      return
    }

    this.intentionalClose = false
    this.setStatus(HandStatus.Connecting)

    // 注册所有桌面端工具到 LocalToolExecutor
    this.executor = new LocalToolExecutor()
    const adapters = adaptAllTools(this.toolRegistry, this.workingDirectory)
    for (const adapter of adapters) {
      this.executor.register(adapter)
    }

    // 建立 WebSocket 连接
    const baseUrl = serverUrl.replace(/\/+$/, '')
    const separator = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${separator}type=hand`
    const protocol = `wzxclaw-${authToken}`

    this.ws = this.wsFactory(url, protocol)

    // 注册事件处理
    this.ws.on('open', () => this.handleOpen())
    this.ws.on('message', (data: unknown) => this.handleMessage(data))
    this.ws.on('close', (code: unknown, reason: unknown) =>
      this.handleClose(Number(code), String(reason)),
    )
    this.ws.on('error', (_err: unknown) => {
      // 错误事件后通常会紧跟 close 事件，不需要额外处理
    })
  }

  /**
   * 主动断开连接（不触发重连）
   */
  disconnect(): void {
    this.intentionalClose = true
    this.stopHeartbeat()
    this.clearReconnectTimer()

    if (this.ws) {
      this.ws.close(1000, 'hand bridge disconnect')
    }

    this.ws = null
    this.executor = null
    this.setStatus(HandStatus.Disconnected)
  }

  /**
   * 重新连接（断开后重连，用于配置变更）
   */
  reconnect(): void {
    this.disconnect()
    // 重置重连计数
    this.reconnectAttempts = 0
    this.connect()
  }

  /**
   * 获取当前连接状态
   */
  getStatus(): HandStatus {
    return this.status
  }

  /**
   * 获取 Hand 唯一标识符
   */
  getHandId(): string {
    return this.handId
  }

  /**
   * 注册状态变化监听器
   */
  onStatusChange(listener: (status: HandStatus) => void): void {
    this.statusListeners.push(listener)
  }

  // ---- 内部方法 ----

  /**
   * 连接建立处理：发送包含完整工具定义的注册消息，启动心跳
   */
  private handleOpen(): void {
    if (!this.executor) return

    // 发送注册消息（包含完整工具定义和 capabilities）
    const capabilities = this.executor.getCapabilities()
    const definitions = this.executor.getDefinitions()
    const registerMsg = createRegisterMessage(this.handId, capabilities, definitions)
    this.ws!.send(registerMsg)

    this.setStatus(HandStatus.Connected)
    this.startHeartbeat()

    // 连接成功，重置重连计数
    this.reconnectAttempts = 0

    console.log(`[HandBridge] 已连接到 NAS Agent Server，注册 ${capabilities.length} 个工具`)
  }

  /**
   * 消息处理：解析并路由到对应处理逻辑
   */
  private handleMessage(raw: unknown): void {
    const str = typeof raw === 'string' ? raw : String(raw)
    const message = parseIncomingMessage(str)
    if (!message) return

    if (message.event === 'hand:execute') {
      this.handleExecute(message)
    } else if (message.event === 'hand:heartbeat_ack') {
      // 心跳确认，连接正常
    }
  }

  /**
   * 处理工具执行请求
   */
  private async handleExecute(message: IncomingMessage): Promise<void> {
    if (!this.executor || !this.ws) return

    if (message.event !== 'hand:execute') return

    const { callId, name, input, context } = message.data as {
      callId: string
      name: string
      input: Record<string, unknown>
      context: { workingDirectory: string; projectRoots: string[] }
    }

    try {
      const result = await this.executor.execute(name, input, context)
      this.ws.send(createResultMessage(callId, result.output, result.isError))
    } catch (err) {
      // 执行器异常兜底
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.ws.send(createResultMessage(callId, errorMsg, true))
    }
  }

  /**
   * 连接关闭处理：停止心跳，触发重连
   */
  private handleClose(_code: number, _reason: string): void {
    this.stopHeartbeat()
    this.ws = null
    this.setStatus(HandStatus.Disconnected)

    if (!this.intentionalClose) {
      console.warn('[HandBridge] 连接断开，将尝试重连...')
      this.scheduleReconnect()
    }
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.configOverrides.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
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
    const maxAttempts = this.configOverrides.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    if (this.reconnectAttempts >= maxAttempts) {
      console.warn(`[HandBridge] 超过最大重连次数 (${maxAttempts})，停止重连`)
      return
    }

    const baseMs = this.configOverrides.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    const maxMs = this.configOverrides.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    const delay = Math.min(baseMs * Math.pow(2, this.reconnectAttempts), maxMs)

    this.setStatus(HandStatus.Reconnecting)
    this.reconnectAttempts++

    console.log(`[HandBridge] 将在 ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连`)

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
   * 设置状态并通知监听器
   */
  private setStatus(status: HandStatus): void {
    this.status = status
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch (err) {
        console.error('[HandBridge] 状态监听器异常:', err)
      }
    }
  }

  /**
   * 生成唯一 Hand ID
   */
  private generateHandId(): string {
    const os = require('os') as typeof import('os')
    const hostname = os.hostname()
    const pid = process.pid
    const random = Math.random().toString(36).substring(2, 8)
    return `desktop-${hostname}-${pid}-${random}`
  }

  /**
   * 默认 WebSocket 工厂（使用 ws 模块）
   */
  private defaultWebSocketFactory: WebSocketFactory = (
    url: string,
    protocols?: string | string[],
  ) => {
    const WS = require('ws')
    return new WS(url, protocols) as unknown as IWebSocket
  }
}
