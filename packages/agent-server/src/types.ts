// ============================================================
// 服务器专用类型定义
// agent-server 内部使用的连接、消息、配置类型
// ============================================================

import type { WebSocket } from 'ws'

// ---- 客户端连接 ----

/** 桌面/手机客户端 WebSocket 连接 */
export interface ClientConnection {
  /** WebSocket 实例 */
  ws: WebSocket
  /** 当前关联的会话 ID（可选，未关联时为 undefined） */
  sessionId?: string
  /** 连接建立时间戳 */
  connectedAt: number
}

// ---- Hand 连接 ----

/** Hand 工具执行节点连接 */
export interface HandConnection {
  /** WebSocket 实例 */
  ws: WebSocket
  /** Hand 唯一标识符 */
  id: string
  /** Hand 支持的能力列表 */
  capabilities: string[]
  /** Hand 注册的工具定义 */
  definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  /** 最近一次心跳时间戳 */
  lastHeartbeat: number
}

// ---- 消息信封 ----

/** WebSocket 消息通用信封格式 */
export interface ServerMessage {
  /** 事件名称 */
  event: string
  /** 事件负载数据 */
  data?: unknown
}

// ---- 服务器配置 ----

/** agent-server 启动配置 */
export interface ServerConfig {
  /** 监听端口 */
  port: number
  /** 认证 token（未设置则 dev mode） */
  authToken?: string
  /** SQLite 数据库文件路径 */
  dbPath: string
  /** 系统提示词（覆盖默认） */
  systemPrompt?: string
}
