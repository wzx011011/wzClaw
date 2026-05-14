// ============================================================
// Token 认证模块
// 从 relay/lib/auth.js 移植为 TypeScript ESM
// 支持生产模式（AUTH_TOKEN）和开发模式（无 token 时接受任意请求）
// ============================================================

import crypto from 'node:crypto'

/** 认证结果 */
export interface AuthResult {
  ok: boolean
  reason: string
}

// 模块内部状态
let _devMode = false
let _devModeWarned = false

/**
 * 初始化认证模块
 * 检查 AUTH_TOKEN 环境变量，未设置则启用开发模式
 * 应在服务器启动时调用一次
 */
export function initAuth(): void {
  if (!process.env.AUTH_TOKEN) {
    _devMode = true
    if (!_devModeWarned) {
      console.warn('[auth] AUTH_TOKEN 未设置 — 接受任意 token（开发模式）')
      _devModeWarned = true
    }
  } else {
    _devMode = false
  }
}

/**
 * 验证连接 token
 * @param token - 来自 WebSocket 查询参数或 Sec-WebSocket-Protocol 头的 token
 * @returns 认证结果
 */
export function authenticate(token: string | null | undefined): AuthResult {
  // Token 必须是非空字符串
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'missing token' }
  }

  // 开发模式：未配置 AUTH_TOKEN 时接受任意非空 token
  if (_devMode) {
    return { ok: true, reason: '' }
  }

  // 生产模式：timing-safe 比较防止时序攻击
  const expected = Buffer.from(process.env.AUTH_TOKEN!, 'utf8')
  const provided = Buffer.from(token, 'utf8')

  if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
    return { ok: true, reason: '' }
  }

  return { ok: false, reason: 'invalid token' }
}

/**
 * 重置内部状态（仅用于测试）
 */
export function _resetAuthState(): void {
  _devMode = false
  _devModeWarned = false
}
