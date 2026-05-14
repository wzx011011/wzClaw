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

// Session 存储
export { SessionStoreSqlite } from './session-sqlite.js'
