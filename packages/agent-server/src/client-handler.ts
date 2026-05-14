// ============================================================
// ClientHandler — 客户端 WebSocket 连接处理 + AgentLoop 桥接
// 管理 client 类型 WebSocket 连接，处理 Client 协议消息
// 将 AgentLoop 的 AgentEvent 转换为 Client 协议格式推送给客户端
// ============================================================

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type {
  AgentLoop,
  AgentEvent,
  AgentConfig,
  ISessionStore,
  IToolExecutor,
  IEventSender,
} from '@wzxclaw/brain'
import type { ServerMessage } from './types.js'

/** AgentEvent 到 Client 协议的映射结果 */
interface ClientMessage {
  event: string
  data: unknown
}

/**
 * 将 AgentEvent 转换为 Client 协议消息
 *
 * 映射规则:
 * - agent:text → stream:text { delta }
 * - agent:thinking → stream:thinking { content }
 * - agent:tool_call → stream:tool_call { toolCallId, name, input }
 * - agent:tool_result → stream:tool_result { toolCallId, name, output, isError }
 * - agent:error → stream:error { error, recoverable }
 * - agent:done → stream:done { usage, turnCount }
 * - agent:compacted → stream:compacted { beforeTokens, afterTokens }
 */
function agentEventToClientMessage(event: AgentEvent): ClientMessage | null {
  switch (event.type) {
    case 'agent:text':
      return { event: 'stream:text', data: { delta: event.content } }
    case 'agent:thinking':
      return { event: 'stream:thinking', data: { content: event.content } }
    case 'agent:tool_call':
      return {
        event: 'stream:tool_call',
        data: { toolCallId: event.toolCallId, name: event.toolName, input: event.input },
      }
    case 'agent:tool_result':
      return {
        event: 'stream:tool_result',
        data: { toolCallId: event.toolCallId, name: event.toolName, output: event.output, isError: event.isError },
      }
    case 'agent:error':
      return { event: 'stream:error', data: { error: event.error, recoverable: event.recoverable } }
    case 'agent:done':
      return { event: 'stream:done', data: { usage: event.usage, turnCount: event.turnCount } }
    case 'agent:compacted':
      return { event: 'stream:compacted', data: { beforeTokens: event.beforeTokens, afterTokens: event.afterTokens } }
    // agent:turn_end / agent:tool_call_preview / agent:tool_progress — 不发送给客户端
    default:
      return null
  }
}

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

  /** 工具执行器（Hand 感知） */
  private readonly toolExecutor: IToolExecutor

  /** AgentLoop 工厂函数 */
  private createLoop: AgentLoopFactory

  /** 当前活跃的 AgentLoop（每个 WebSocket 连接独享） */
  private activeLoop: AgentLoop | null = null

  /** 当前 WebSocket 连接 */
  private activeWs: WebSocket | null = null

  /** 标记是否正在消费 AgentLoop generator */
  private consuming = false

  constructor(
    sessionStore: ISessionStore,
    toolExecutor: IToolExecutor,
    createLoop?: AgentLoopFactory,
  ) {
    this.sessionStore = sessionStore
    this.toolExecutor = toolExecutor
    // 默认工厂函数 — 实际使用时由 server.ts 注入
    this.createLoop = createLoop ?? (() => {
      throw new Error('AgentLoop factory not configured')
    })
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
    this.activeWs = ws

    ws.on('message', (raw: unknown) => {
      this.handleMessage(ws, raw)
    })

    ws.on('close', () => {
      this.handleClose()
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
      case 'chat:send':
        this.handleChatSend(ws, data as { sessionId: string; message: string })
        break
      case 'session:list':
        this.handleSessionList(ws)
        break
      case 'session:load':
        this.handleSessionLoad(ws, data as { sessionId: string })
        break
      case 'session:create':
        this.handleSessionCreate(ws)
        break
      case 'session:delete':
        this.handleSessionDelete(ws, data as { sessionId: string })
        break
      default:
        // 未知 event — 忽略
        break
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
  private async handleChatSend(ws: WebSocket, data: { sessionId: string; message: string }): Promise<void> {
    const { sessionId, message } = data

    // 取消旧的 AgentLoop
    if (this.activeLoop) {
      this.activeLoop.cancel()
      this.activeLoop = null
      this.consuming = false
    }

    // 创建新 AgentLoop
    const loop = this.createLoop()
    this.activeLoop = loop
    this.consuming = true

    // 构建 AgentConfig
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      conversationId: sessionId,
    }

    // 如果有历史消息，先加载
    try {
      const history = await this.sessionStore.loadSession(sessionId)
      if (history.length > 0) {
        loop.replaceMessages(history as Parameters<typeof loop.replaceMessages>[0])
      }
    } catch {
      // 加载历史失败 — 继续空对话
    }

    // 创建事件发送器
    const sender = new WebSocketEventSender(ws)

    try {
      // 消费 AgentLoop generator
      for await (const event of loop.run(message, config, sender, this.toolExecutor)) {
        // 如果被新的请求中断，停止消费
        if (!this.consuming || this.activeLoop !== loop) break

        // 将 AgentEvent 转换为 Client 协议消息
        const clientMsg = agentEventToClientMessage(event)
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
    if (this.activeLoop === loop) {
      try {
        // 保存用户消息
        await this.sessionStore.appendMessage(sessionId, {
          role: 'user',
          content: message,
        })
        // 保存 AgentLoop 产生的消息
        const messages = loop.getMessages()
        for (const msg of messages) {
          await this.sessionStore.appendMessage(sessionId, msg)
        }
      } catch {
        // 持久化失败 — 不影响客户端
      }
      this.activeLoop = null
      this.consuming = false
    }
  }

  /**
   * 处理 session:list — 获取会话列表
   */
  private async handleSessionList(ws: WebSocket): Promise<void> {
    try {
      const sessions = await this.sessionStore.listSessions()
      ws.send(JSON.stringify({ event: 'session:list', data: sessions }))
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
      const messages = await this.sessionStore.loadSession(data.sessionId)
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
  private handleSessionCreate(ws: WebSocket): void {
    const sessionId = randomUUID()
    ws.send(JSON.stringify({ event: 'session:created', data: { sessionId } }))
  }

  /**
   * 处理 session:delete — 删除会话
   */
  private async handleSessionDelete(ws: WebSocket, data: { sessionId: string }): Promise<void> {
    try {
      await this.sessionStore.deleteSession(data.sessionId)
      ws.send(JSON.stringify({ event: 'session:deleted', data: { sessionId: data.sessionId } }))
    } catch (err) {
      ws.send(JSON.stringify({
        event: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  /**
   * 处理 WebSocket 关闭
   * 取消活跃的 AgentLoop，清理状态
   */
  private handleClose(): void {
    if (this.activeLoop) {
      this.activeLoop.cancel()
      this.activeLoop = null
    }
    this.consuming = false
    this.activeWs = null
  }
}
