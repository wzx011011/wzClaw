// ============================================================
// DebugLogger — 每会话调试日志写入 ~/.wzxclaw/debug/{sessionId}.txt
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import { getDebugDir, getMediaDir } from '../paths'

const MAX_DEBUG_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7天

/**
 * 启动时清理超过 7 天的 debug 文件（异步，静默失败）。
 */
export async function cleanOldDebugFiles(): Promise<void> {
  const debugDir = getDebugDir()
  try {
    const entries = await fs.promises.readdir(debugDir)
    const now = Date.now()
    await Promise.all(
      entries
        .filter(f => f.endsWith('.txt'))
        .map(async f => {
          const filePath = path.join(debugDir, f)
          try {
            const stat = await fs.promises.stat(filePath)
            if (now - stat.mtimeMs > MAX_DEBUG_AGE_MS) {
              await fs.promises.unlink(filePath)
            }
          } catch { /* ignore */ }
        })
    )
  } catch { /* dir might not exist yet */ }
}

/**
 * 启动时清理超过 7 天的 media 截图文件（异步，静默失败）。
 */
export async function cleanOldMediaFiles(): Promise<void> {
  const mediaDir = getMediaDir()
  try {
    const entries = await fs.promises.readdir(mediaDir)
    const now = Date.now()
    await Promise.all(
      entries
        .filter(f => f.endsWith('.jpg'))
        .map(async f => {
          const filePath = path.join(mediaDir, f)
          try {
            const stat = await fs.promises.stat(filePath)
            if (now - stat.mtimeMs > MAX_DEBUG_AGE_MS) {
              await fs.promises.unlink(filePath)
            }
          } catch { /* ignore */ }
        })
    )
  } catch { /* dir might not exist yet */ }
}

/**
 * 每会话调试日志记录器。
 * 写入 ~/.wzxclaw/debug/{sessionId}.txt。
 * 所有写入都是追加模式，静默失败不影响主流程。
 */
export class DebugLogger {
  private logPath: string
  private stream: fs.WriteStream | null = null

  constructor(sessionId: string) {
    this.logPath = path.join(getDebugDir(), `${sessionId}.txt`)
    try {
      fs.mkdirSync(getDebugDir(), { recursive: true })
      this.stream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf-8' })
      this.write('SESSION', 'start', { sessionId, time: new Date().toISOString() })
    } catch { /* ignore */ }
  }

  /** 写入一条日志记录 */
  log(category: string, message: string, data?: unknown): void {
    this.write(category, message, data)
  }

  /** 会话结束时调用（flush + close） */
  close(): void {
    try {
      this.write('SESSION', 'end', { time: new Date().toISOString() })
      this.stream?.end()
      this.stream = null
    } catch { /* ignore */ }
  }

  private write(category: string, message: string, data?: unknown): void {
    if (!this.stream) return
    try {
      const ts = new Date().toISOString()
      const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : ''
      this.stream.write(`[${ts}] [${category}] ${message}${dataStr}\n`)
    } catch { /* ignore */ }
  }
}
