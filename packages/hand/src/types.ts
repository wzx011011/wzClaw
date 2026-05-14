// ============================================================
// Hand 客户端类型定义
// Hand 与 agent-server 通信所需的配置、状态、消息类型
// ============================================================

// ---- 配置 ----

/** Hand 连接配置 */
export interface HandConfig {
  /** agent-server WebSocket 地址（如 wss://5945.top/agent/ 或 ws://localhost:8082/） */
  serverUrl: string
  /** 认证 token */
  authToken: string
  /** Hand 唯一标识符（可选，默认自动生成） */
  handId?: string
  /** 心跳间隔（毫秒，默认 15000） */
  heartbeatIntervalMs?: number
  /** 重连基础间隔（毫秒，默认 1000） */
  reconnectBaseMs?: number
  /** 最大重连次数（默认 10） */
  maxReconnectAttempts?: number
  /** 最大重连间隔（毫秒，默认 30000） */
  reconnectMaxMs?: number
}

// ---- 状态枚举 ----

/** Hand 连接状态 */
export enum HandStatus {
  /** 未连接 */
  Disconnected = 'disconnected',
  /** 正在建立连接 */
  Connecting = 'connecting',
  /** 已连接，正在注册 */
  Registering = 'registering',
  /** 已注册，正常工作 */
  Connected = 'connected',
  /** 正在重连 */
  Reconnecting = 'reconnecting',
}

// ---- 工具定义 ----

/** Hand 注册的工具定义（与 agent-server ToolDefinition 一致） */
export interface HandToolDefinition {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** 工具输入 JSON Schema */
  inputSchema: Record<string, unknown>
  /** 是否只读工具（不修改文件系统） */
  isReadOnly?: boolean
}

// ---- 入站消息类型 ----

/** 工具执行请求消息（服务器 → Hand） */
export interface IncomingExecuteMessage {
  event: 'hand:execute'
  data: {
    /** 调用唯一标识符 */
    callId: string
    /** 工具名称 */
    name: string
    /** 工具输入参数 */
    input: Record<string, unknown>
    /** 执行上下文 */
    context: {
      workingDirectory: string
      projectRoots: string[]
    }
  }
}

/** 心跳确认消息（服务器 → Hand） */
export interface IncomingHeartbeatAck {
  event: 'hand:heartbeat_ack'
}

/** 通用入站消息类型（所有服务器消息的联合） */
export type IncomingMessage =
  | IncomingExecuteMessage
  | IncomingHeartbeatAck
  | { event: string; data?: unknown }

// ---- 回调类型 ----

/** 工具执行回调参数 */
export interface ExecuteCallbackData {
  callId: string
  name: string
  input: Record<string, unknown>
  context: {
    workingDirectory: string
    projectRoots: string[]
  }
}
