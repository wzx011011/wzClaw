// ============================================================
// Mobile File Handlers — 移动端文件浏览消息处理器
// 处理 file:tree/request 和 file:read/request 事件
// ============================================================

import path from 'path'
import type { MobileRelayContext, MobileRelayMessage } from './mobile-relay-context'

/**
 * 处理文件浏览相关的移动端消息。
 * 返回 true 表示已处理，false 表示不匹配。
 */
export async function handleFileMessage(
  msg: MobileRelayMessage,
  ctx: MobileRelayContext
): Promise<boolean> {
  const { broadcastToMobile } = ctx

  // -- File browsing: get directory tree --
  if (msg.event === 'file:tree:request') {
    const requestId = msg.data?.requestId ?? ''
    const workspaceRoot = ctx.workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
      return true
    }
    try {
      const dirPath = msg.data?.dirPath || workspaceRoot
      const depth = msg.data?.depth || 2
      const nodes = await ctx.workspaceManager.getDirectoryTree(dirPath as string, depth as number)
      broadcastToMobile('file:tree:response', { requestId, nodes })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  // -- File browsing: read file content --
  if (msg.event === 'file:read:request') {
    const requestId = msg.data?.requestId ?? ''
    const filePath = msg.data?.filePath
    const workspaceRoot = ctx.workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot || !filePath) {
      broadcastToMobile('session:error', { requestId, error: 'No workspace or file path', code: 'BAD_REQUEST' })
      return true
    }
    try {
      const resolvedWorkspaceRoot = path.resolve(workspaceRoot)
      const absolutePath = path.isAbsolute(filePath as string) ? path.resolve(filePath as string) : path.resolve(resolvedWorkspaceRoot, filePath as string)

      // Security: verify path is within workspace
      if (!ctx.isPathWithinWorkspace(resolvedWorkspaceRoot, absolutePath)) {
        broadcastToMobile('session:error', { requestId, error: 'Access denied: path outside workspace', code: 'ACCESS_DENIED' })
        return true
      }

      const fsp = await import('fs/promises')
      const stat = await fsp.stat(absolutePath)

      // Limit to 500KB for mobile
      if (stat.size > 512000) {
        broadcastToMobile('file:read:response', {
          requestId,
          error: 'File too large',
          size: stat.size,
          filePath
        })
        return true
      }

      const content = await fsp.readFile(absolutePath, 'utf-8')

      // Detect language from extension
      const ext = path.extname(absolutePath).slice(1).toLowerCase()
      const langMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
        dart: 'dart', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c',
        css: 'css', scss: 'scss', html: 'html', xml: 'xml',
        json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
        md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql',
      }
      const language = langMap[ext] ?? ext

      broadcastToMobile('file:read:response', {
        requestId,
        content,
        language,
        size: stat.size,
        filePath: path.relative(workspaceRoot, absolutePath).replace(/\\\\/g, '/'),
      })
    } catch (err: unknown) {
      broadcastToMobile('session:error', { requestId, error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' })
    }
    return true
  }

  return false
}
