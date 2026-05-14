// ============================================================
// agent-server 包入口 — barrel exports
// ============================================================

// 认证模块
export { initAuth, authenticate } from './auth.js'
export type { AuthResult } from './auth.js'

// 服务器类型
export type {
  ClientConnection,
  HandConnection,
  ServerMessage,
  ServerConfig,
} from './types.js'

// Hand 路由
export { HandsRouter } from './hands-router.js'
export type { HandEntry, ToolDefinition } from './hands-router.js'

// Hand 感知工具执行器
export { HandAwareToolExecutor } from './hand-aware-tool-executor.js'

// Session 存储
export { SessionStoreSqlite } from './session-sqlite.js'
