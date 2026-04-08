import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'

// ============================================================
// SessionStore — JSONL-based session persistence (per PERSIST-01 through PERSIST-06)
// ============================================================

/**
 * Lightweight message type for persistence.
 * Stores enough data to reconstruct ChatMessage in the renderer.
 */
export interface ChatMessageLike {
  role: string
  content: string
  timestamp: number
  id?: string
  toolCalls?: unknown[]
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

  constructor(workspaceRoot: string) {
    const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 16)
    this.sessionsDir = path.join(app.getPath('userData'), 'sessions', projectHash)
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  /**
   * Append a single message to a session's JSONL file.
   * Uses fs.appendFileSync for safe, atomic append operations.
   */
  appendMessage(sessionId: string, message: ChatMessageLike): void {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const line = JSON.stringify(message) + '\n'
    fs.appendFileSync(filePath, line, 'utf-8')
  }

  /**
   * Append multiple messages to a session's JSONL file.
   * Used after agent:done to persist all messages from the completed turn.
   */
  appendMessages(sessionId: string, messages: ChatMessageLike[]): void {
    for (const msg of messages) {
      this.appendMessage(sessionId, msg)
    }
  }

  /**
   * Load all messages from a session's JSONL file.
   * Corrupted/malformed lines are skipped with a console warning (PERSIST-05).
   * Returns empty array if the session file does not exist.
   */
  loadSession(sessionId: string): ChatMessageLike[] {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) {
      return []
    }
    const content = fs.readFileSync(filePath, 'utf-8')
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
  }

  /**
   * List all sessions for the current project, sorted by most recently updated first.
   * Returns metadata including id, title, timestamps, and message count.
   *
   * Title is derived from the first user message: content.substring(0, 50) + "..." if longer.
   * Falls back to "Untitled" if no user message is found.
   */
  listSessions(): SessionMeta[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return []
    }
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl'))
    const sessions: SessionMeta[] = []

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      const filePath = path.join(this.sessionsDir, file)
      const content = fs.readFileSync(filePath, 'utf-8')
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

      const stats = fs.statSync(filePath)
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
  }

  /**
   * Delete a session's JSONL file.
   * Returns true if the file existed and was deleted, false otherwise.
   */
  deleteSession(sessionId: string): boolean {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return true
    }
    return false
  }

  /**
   * Rename a session by adding/updating a meta line at the top of the JSONL file.
   * The meta line format: {"type":"meta","title":"..."}
   * listSessions() checks for this meta line before falling back to first user message.
   * Returns true if the session file existed and was updated, false otherwise.
   */
  renameSession(sessionId: string, title: string): boolean {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) {
      return false
    }

    const content = fs.readFileSync(filePath, 'utf-8')
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

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
    return true
  }
}
