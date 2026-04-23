import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getSessionsDir, getTaskSessionsDir } from '../paths'

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
}

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

  constructor(workspaceRoot: string) {
    const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 16)
    this.sessionsDir = getSessionsDir(projectHash)
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  /** Create a SessionStore scoped to a Task instead of a workspace root */
  static forTask(taskId: string): SessionStore {
    const store = Object.create(SessionStore.prototype) as SessionStore
    store.sessionsDir = getTaskSessionsDir(taskId)
    fs.mkdirSync(store.sessionsDir, { recursive: true })
    return store
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
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const line = JSON.stringify(message) + '\n'
    await fsp.appendFile(filePath, line, 'utf-8')
  }

  /**
   * Append multiple messages to a session's JSONL file.
   * Used after agent:done to persist all messages from the completed turn.
   * Batch-writes all messages in a single file append to avoid per-message overhead.
   */
  async appendMessages(sessionId: string, messages: ChatMessageLike[]): Promise<void> {
    if (messages.length === 0) return
    this.validateSessionId(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const content = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n'
    await fsp.appendFile(filePath, content, 'utf-8')
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
          messages.push(JSON.parse(line))
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
   * List all sessions for the current project, sorted by most recently updated first.
   * Returns metadata including id, title, timestamps, and message count.
   *
   * Title is derived from the first user message: content.substring(0, 50) + "..." if longer.
   * Falls back to "Untitled" if no user message is found.
   */
  async listSessions(): Promise<SessionMeta[]> {
    try {
      const files = await fsp.readdir(this.sessionsDir)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
      const sessions: SessionMeta[] = []

      for (const file of jsonlFiles) {
        const sessionId = file.replace('.jsonl', '')
        const filePath = path.join(this.sessionsDir, file)
        const content = await fsp.readFile(filePath, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())

        // Extract title: check for meta line first, then fall back to first user message
        let title = 'Untitled'
        let messageLines = lines
        // Check if first line is a meta line
        if (lines.length > 0) {
          try {
            const parsed = JSON.parse(lines[0])
            if (parsed.type === 'meta' && parsed.title) {
              title = parsed.title
              messageLines = lines.slice(1) // exclude meta line from message count
            }
          } catch {
            // not a meta line, proceed normally
          }
        }
        // Fall back to first user message if title still default
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
              // skip corrupted lines when extracting title
            }
          }
        }

        const stats = await fsp.stat(filePath)
        sessions.push({
          id: sessionId,
          title,
          createdAt: stats.birthtimeMs,
          updatedAt: stats.mtimeMs,
          messageCount: messageLines.filter(l => l.trim()).length
        })
      }

      // Sort by updatedAt descending (most recent first)
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
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw err
    }
  }
}
