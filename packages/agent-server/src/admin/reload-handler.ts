// ============================================================
// Admin Reload Handler — POST /admin/reload 端点
// 触发重新加载配置文件并通知所有已连接的 Hands
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticate } from '../auth.js'
import { reloadInstructions, buildSystemPrompt } from '../instructions/system-prompt-builder.js'
import type { HandsRouter } from '../hands-router.js'

/** reload 结果 */
interface ReloadResult {
  ok: boolean
  reloadedHands: number
  newCapabilities: string[]
  errors?: string[]
}

/**
 * 处理 POST /admin/reload 请求
 *
 * 1. 验证 token
 * 2. 重新加载指令文件
 * 3. 向所有已连接 Hands 发送 hand:reload 控制帧
 * 4. 返回结果
 */
export function handleReload(
  req: IncomingMessage,
  res: ServerResponse,
  handsRouter: HandsRouter,
): void {
  // 认证检查
  const token = extractToken(req)
  const authResult = authenticate(token)
  if (!authResult.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: authResult.reason }))
    return
  }

  // 重新加载指令
  const errors: string[] = []
  let sections
  try {
    sections = reloadInstructions()
  } catch (err) {
    errors.push(`Instruction reload failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 向所有 Hands 发送 hand:reload 控制帧
  const hands = handsRouter.getAllHands()
  let reloadedHands = 0
  for (const hand of hands) {
    try {
      hand.ws.send(JSON.stringify({ event: 'hand:reload', data: {} }))
      reloadedHands++
    } catch (err) {
      errors.push(`Hand ${hand.id} reload send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 收集所有 Hand 的工具能力
  const capabilities = handsRouter.getAllDefinitions().map(d => d.name)

  const result: ReloadResult = {
    ok: errors.length === 0,
    reloadedHands,
    newCapabilities: capabilities,
    ...(errors.length > 0 && { errors }),
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

/**
 * 从请求中提取认证 token
 */
function extractToken(req: IncomingMessage): string {
  // 从 Authorization header 提取
  const authHeader = req.headers['authorization']
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length)
    }
    return authHeader
  }
  return ''
}
