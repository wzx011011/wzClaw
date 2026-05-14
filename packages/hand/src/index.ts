// ============================================================
// @wzxclaw/hand — barrel exports
// 导出所有公共 API：类型、协议函数、连接管理器、工具执行器
// ============================================================

// 类型导出
export type { HandConfig, HandToolDefinition, ExecuteCallbackData, IncomingExecuteMessage, IncomingHeartbeatAck, IncomingMessage } from './types.js'
export { HandStatus } from './types.js'

// 协议函数导出
export { createRegisterMessage, createResultMessage, createHeartbeatMessage, parseIncomingMessage } from './protocol.js'

// 连接管理器导出
export { HandConnection } from './connection.js'
export type { IWebSocket, WebSocketFactory, HandConnectionCallbacks } from './connection.js'

// 工具执行器导出
export { LocalToolExecutor } from './tool-executor.js'
export type { HandTool, ToolExecutionResult } from './tool-executor.js'

// CLI 入口（不自动执行，需显式调用）
export { runCli, parseArgs } from './cli.js'
export type { ParsedArgs } from './cli.js'
