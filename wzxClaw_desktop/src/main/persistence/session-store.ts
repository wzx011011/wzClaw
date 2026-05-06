import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getSessionsDir } from '../paths'

// ============================================================
// SessionStore — JSONL-based session persistence (per PERSIST-01 through PERSIST-06)
// ============================================================

/**
 * Lightweight message type for persistence.
 * Stores enough data to reconstruct ChatMessage in the renderer.
 * 字段需覆盖 UserMessage / AssistantMessage / ToolResultMessage 的全部属性。
 */
export interface ChatMessageLike {
  type?: string           // 'meta' 元数据行（非消息）
  role: string
  content: string
  timestamp: number
  id?: string
  // AssistantMessage 字段
  toolCalls?: unknown[]
  contentBlocks?: unknown[]
  // ToolResultMessage 字段
  toolCallId?: string
  isError?: boolean
  // 其他
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Session metadata returned by listSessions().
 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview?: string
}

// ============================================================
// 会话元数据缓存 — 避免 listSessions 每次全量解析 JSONL
// ============================================================

interface CachedMeta {
  title: string
  preview?: string
  messageCount: number
  createdAt: number
  updatedAt: number
  mtimeMs: number
  fileSize: number
}

type MetadataCache = Record<string, CachedMeta>

/**
 * Manages session persistence using JSONL files stored in Electron's userData directory.
 *
 * Sessions are isolated per-project using SHA-256 hash of workspace root.
 * Each session is stored as a .jsonl file where each line is a JSON-serialized message.
 * Append-only writes ensure fast, safe persistence after each agent turn.
 *
 * Directory structure: %APPDATA%/wzxclaw/sessions/{project-hash}/{session-id}.jsonl
 */
export class SessionStore {
  private sessionsDir: string
  get sessionDir(): string { return this.sessionsDir }

  // Per-session 写锁：串行化同一 JSONL 文件的并发 append，防止写入交错损坏
  private _writeLocks = new Map<string, Promise<void>>()
  // 内存中的元数据缓存
  private _metaCache: MetadataCache | null = null
  private get cachePath(): string { return path.join(this.sessionsDir, '_metadata_cache.json') }

  constructor(workspaceRoot: string) {
    const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 16)
    this.sessionsDir = getSessionsDir(projectHash)
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  private async readMetaCache(): Promise<MetadataCache> {
    if (this._metaCache) return this._metaCache
    try {
      const raw = await fsp.readFile(this.cachePath, 'utf-8')
      this._metaCache = JSON.parse(raw)
    } catch {
      this._metaCache = {}
    }
    return this._metaCache
  }

  private async writeMetaCache(cache: MetadataCache): Promise<void> {
    this._metaCache = cache
    try {
      const tmpPath = this.cachePath + '.tmp'
      await fsp.writeFile(tmpPath, JSON.stringify(cache), 'utf-8')
      await fsp.rename(tmpPath, this.cachePath)
    } catch {
      // 缓存写入失败不影响功能
    }
  }

  /** 使指定会话的缓存条目失效 */
  invalidateCacheEntry(sessionId: string): void {
    if (this._metaCache && this._metaCache[sessionId]) {
      delete this._metaCache[sessionId]
    }
  }

  /**
   * Append a single message to a session's JSONL file.
   * Uses async file I/O to avoid blocking the main process event loop.
   */
  private validateSessionId(sessionId: string): void {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      throw new Error('Invalid session ID format')
    }
  }

  async appendMessage(sessionId: string, message: ChatMessageLike): Promise<void> {
    return this.appendMessages(sessionId, [message])
  }

  /**
   * Append multiple messages to a session's JSONL file.
   * Used after agent:done to persist all messages from the completed turn.
   * Batch-writes all messages in a single file append to avoid per-message overhead.
   * Per-session 写锁保证并发调用不会交错写入。
   */
  async appendMessages(sessionId: string, messages: ChatMessageLike[]): Promise<void> {
    if (messages.length === 0) return
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const content = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n'
    // 串行化：等前一次写完再写
    // 锁链中记录错误但不中断后续写入；调用方通过 await next 获取自身写入的错误
    const pending = this._writeLocks.get(sessionId) ?? Promise.resolve()
    let resolveLock!: () => void
    const lockPromise = new Promise<void>(r => { resolveLock = r })
    const next = pending.then(() => fsp.appendFile(filePath, content, 'utf-8')).finally(() => resolveLock())
    this._writeLocks.set(sessionId, lockPromise)
    await next
    // 写入后使缓存失效（mtime 会变，下次 listSessions 自动重解析）
    this.invalidateCacheEntry(sessionId)
  }

  /**
   * Load all messages from a session's JSONL file.
   * Corrupted/malformed lines are skipped with a console warning (PERSIST-05).
   * Returns empty array if the session file does not exist.
   */
  async loadSession(sessionId: string): Promise<ChatMessageLike[]> {
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      const messages: ChatMessageLike[] = []
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          // 跳过 meta 行（不是真实消息），防止手机端收到幽灵空消息
          if (parsed.type === 'meta') continue
          messages.push(parsed)
        } catch {
          console.warn(`Skipping corrupted JSONL line: ${line.substring(0, 50)}`)
        }
      }
      return messages
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  /**
   * 加载会话的最近 N 条消息（tail），用于快速显示。
   * 跳过首行 meta 记录。返回消息数组、总行数及是否还有更多历史。
   * 相比 loadSession 避免全文件解析，切换大会话时首帧极快。
   */
  async loadSessionTail(sessionId: string, tailCount: number): Promise<{
    messages: ChatMessageLike[]
    totalCount: number
    hasMore: boolean
  }> {
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const allLines = content.split('\n')
      // 跳过首行 meta（如存在），用 JSON.parse 检测而非字符串匹配，
      // 防止用户消息内容中包含 "type":"meta" 子串时误判
      let dataStart = 0
      if (allLines.length > 0) {
        try {
          const first = JSON.parse(allLines[0])
          if (first?.type === 'meta') dataStart = 1
        } catch {
          // 首行不是合法 JSON，保持 dataStart = 0
        }
      }
      const dataLines = allLines.slice(dataStart).filter(l => l.trim())
      const totalCount = dataLines.length
      const hasMore = totalCount > tailCount
      const tailLines = hasMore ? dataLines.slice(-tailCount) : dataLines
      const messages: ChatMessageLike[] = []
      for (const line of tailLines) {
        try {
          messages.push(JSON.parse(line))
        } catch {
          // 跳过损坏行
        }
      }
      return { messages, totalCount, hasMore }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { messages: [], totalCount: 0, hasMore: false }
      }
      throw err
    }
  }

  /**
   * List all sessions for the current project, sorted by most recently updated first.
   * Uses metadata cache — only re-parses JSONL files whose mtime has changed.
   */
  async listSessions(): Promise<SessionMeta[]> {
    try {
      const files = await fsp.readdir(this.sessionsDir)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
      const cache = await this.readMetaCache()
      const sessions: SessionMeta[] = []
      let cacheChanged = false

      for (const file of jsonlFiles) {
        const sessionId = path.basename(file, '.jsonl')
        const filePath = path.join(this.sessionsDir, file)
        const stats = await fsp.stat(filePath)
        const cached = cache[sessionId]

        // 缓存命中且 mtime/fileSize 未变 → 直接用缓存
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.fileSize === stats.size) {
          sessions.push({
            id: sessionId,
            title: cached.title,
            createdAt: cached.createdAt,
            updatedAt: cached.updatedAt,
            messageCount: cached.messageCount,
            preview: cached.preview,
          })
          continue
        }

        // 缓存未命中或文件已变 → 解析 JSONL 提取元数据
        const content = await fsp.readFile(filePath, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())

        let title = 'Untitled'
        let preview: string | undefined
        let messageLines = lines
        if (lines.length > 0) {
          try {
            const parsed = JSON.parse(lines[0])
            if (parsed.type === 'meta' && parsed.title) {
              title = parsed.title
              messageLines = lines.slice(1)
            }
          } catch {
            // not a meta line
          }
        }
        if (title === 'Untitled') {
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line)
              if (parsed.role === 'user' && parsed.content) {
                title = parsed.content.length > 50
                  ? parsed.content.substring(0, 50) + '...'
                  : parsed.content
                break
              }
            } catch {
              // skip
            }
          }
        }
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.role === 'user' && parsed.content) {
              const text = typeof parsed.content === 'string'
                ? parsed.content
                : Array.isArray(parsed.content)
                  ? (parsed.content.find((b: { type: string }) => b.type === 'text')?.text ?? '')
                  : ''
              if (text) {
                preview = text.length > 80 ? text.substring(0, 80) + '...' : text
              }
              break
            }
          } catch {
            // skip
          }
        }

        const messageCount = messageLines.length
        // 更新缓存
        cache[sessionId] = {
          title,
          preview,
          messageCount,
          createdAt: stats.birthtimeMs,
          updatedAt: stats.mtimeMs,
          mtimeMs: stats.mtimeMs,
          fileSize: stats.size,
        }
        cacheChanged = true

        sessions.push({
          id: sessionId,
          title,
          createdAt: stats.birthtimeMs,
          updatedAt: stats.mtimeMs,
          messageCount,
          preview,
        })
      }

      // 清理缓存中已不存在的会话
      const activeIds = new Set(jsonlFiles.map(f => path.basename(f, '.jsonl')))
      for (const id of Object.keys(cache)) {
        if (!activeIds.has(id)) {
          delete cache[id]
          cacheChanged = true
        }
      }

      if (cacheChanged) await this.writeMetaCache(cache)

      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      return sessions
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  /**
   * Delete a session's JSONL file.
   * Returns true if the file existed and was deleted, false otherwise.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    try {
      await fsp.unlink(filePath)
      this.invalidateCacheEntry(sessionId)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw err
    }
  }

  /**
   * Rename a session by adding/updating a meta line at the top of the JSONL file.
   * The meta line format: {"type":"meta","title":"..."}
   * listSessions() checks for this meta line before falling back to first user message.
   * Returns true if the session file existed and was updated, false otherwise.
   *
   * Uses atomic write: writes to a temporary file in the same directory,
   * then renames it over the original. This prevents data loss on crash.
   */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      // Check if first line is already a meta line
      const metaLine = JSON.stringify({ type: 'meta', title })

      if (lines.length > 0) {
        try {
          const parsed = JSON.parse(lines[0])
          if (parsed.type === 'meta') {
            // Replace existing meta line
            lines[0] = metaLine
          } else {
            // Insert meta line at top
            lines.unshift(metaLine)
          }
        } catch {
          // First line corrupted, insert meta at top
          lines.unshift(metaLine)
        }
      } else {
        // Empty file, just write meta
        lines.push(metaLine)
      }

      // Atomic write: write to temp file, then rename over original
      const tmpPath = path.join(this.sessionsDir, `${sessionId}.jsonl.tmp.${Date.now()}`)
      await fsp.writeFile(tmpPath, lines.join('\n'), 'utf-8')
      await fsp.rename(tmpPath, filePath)
      this.invalidateCacheEntry(sessionId)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw err
    }
  }
}
