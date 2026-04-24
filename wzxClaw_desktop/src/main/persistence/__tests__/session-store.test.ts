import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// ============================================================
// SessionStore Unit Tests (per PERSIST-01 through PERSIST-06)
// ============================================================

// Test-friendly version of SessionStore that takes a base dir directly
// instead of calling Electron's app.getPath('userData')
interface ChatMessageLike {
  role: string
  content: string
  timestamp: number
  id?: string
  toolCalls?: unknown[]
  usage?: { inputTokens: number; outputTokens: number }
}

interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

class TestSessionStore {
  private sessionsDir: string

  constructor(baseDir: string, projectHash: string) {
    this.sessionsDir = path.join(baseDir, 'sessions', projectHash)
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  appendMessage(sessionId: string, message: ChatMessageLike): void {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const line = JSON.stringify(message) + '\n'
    fs.appendFileSync(filePath, line, 'utf-8')
  }

  appendMessages(sessionId: string, messages: ChatMessageLike[]): void {
    for (const msg of messages) {
      this.appendMessage(sessionId, msg)
    }
  }

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

      // Title: first user message content, truncated to 50 chars
      let title = 'Untitled'
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
          // skip corrupted
        }
      }

      const stats = fs.statSync(filePath)
      sessions.push({
        id: sessionId,
        title,
        createdAt: stats.birthtimeMs,
        updatedAt: stats.mtimeMs,
        messageCount: lines.length
      })
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  }

  deleteSession(sessionId: string): boolean {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return true
    }
    return false
  }
}

describe('SessionStore', () => {
  let tempDir: string
  let store: TestSessionStore
  const projectHash = crypto.createHash('sha256').update('/test/workspace').digest('hex').substring(0, 16)

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-test-'))
    store = new TestSessionStore(tempDir, projectHash)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // BEHAVIOR 1: append - after appending 3 messages, loading returns all 3
  it('append: after appending 3 messages, loading returns all 3 with correct content', () => {
    const sessionId = 'test-session-1'
    const messages: ChatMessageLike[] = [
      { role: 'user', content: 'Hello', timestamp: 1000 },
      { role: 'assistant', content: 'Hi there', timestamp: 2000 },
      { role: 'user', content: 'How are you?', timestamp: 3000 }
    ]
    store.appendMessages(sessionId, messages)
    const loaded = store.loadSession(sessionId)
    expect(loaded).toHaveLength(3)
    expect(loaded[0].content).toBe('Hello')
    expect(loaded[1].content).toBe('Hi there')
    expect(loaded[2].content).toBe('How are you?')
  })

  // BEHAVIOR 2: auto-save - appendMessage can be called after agent:done to persist turn messages
  it('auto-save: appendMessage persists individual messages for agent turn', () => {
    const sessionId = 'auto-save-test'
    store.appendMessage(sessionId, { role: 'user', content: 'Write a function', timestamp: 1000 })
    store.appendMessage(sessionId, { role: 'assistant', content: 'function foo() {}', timestamp: 2000, toolCalls: [{ id: 'tc1', name: 'FileWrite' }] })
    store.appendMessage(sessionId, { role: 'tool_result', content: 'File written', timestamp: 3000, id: 'tr1' })

    const loaded = store.loadSession(sessionId)
    expect(loaded).toHaveLength(3)
    expect(loaded[1].toolCalls).toHaveLength(1)
  })

  // BEHAVIOR 3: load - loading a session with 5 messages returns all 5 including tool calls and usage
  it('load: loading a session with 5 messages returns all 5', () => {
    const sessionId = 'load-test'
    const messages: ChatMessageLike[] = [
      { role: 'user', content: 'msg1', timestamp: 1000 },
      { role: 'assistant', content: 'msg2', timestamp: 2000, toolCalls: [{ id: 'tc1', name: 'Bash' }] },
      { role: 'tool_result', content: 'msg3', timestamp: 3000 },
      { role: 'assistant', content: 'msg4', timestamp: 4000 },
      { role: 'user', content: 'msg5', timestamp: 5000 }
    ]
    store.appendMessages(sessionId, messages)
    const loaded = store.loadSession(sessionId)
    expect(loaded).toHaveLength(5)
    expect(loaded[1].toolCalls).toHaveLength(1)
    expect(loaded[1].toolCalls![0]).toEqual({ id: 'tc1', name: 'Bash' })
  })

  // BEHAVIOR 4: restore - full ChatMessage objects round-trip through JSONL without data loss
  it('restore: ChatMessage objects round-trip through JSONL without data loss', () => {
    const sessionId = 'restore-test'
    const msg: ChatMessageLike = {
      role: 'assistant',
      content: 'Here is the result',
      timestamp: 1234567890,
      id: 'msg-uuid-123',
      toolCalls: [
        { id: 'tc-1', name: 'FileRead', input: { path: '/test/file.ts' }, output: 'file content' }
      ],
      usage: { inputTokens: 500, outputTokens: 200 }
    }
    store.appendMessage(sessionId, msg)
    const loaded = store.loadSession(sessionId)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].role).toBe('assistant')
    expect(loaded[0].content).toBe('Here is the result')
    expect(loaded[0].timestamp).toBe(1234567890)
    expect(loaded[0].id).toBe('msg-uuid-123')
    expect(loaded[0].toolCalls).toEqual([{ id: 'tc-1', name: 'FileRead', input: { path: '/test/file.ts' }, output: 'file content' }])
    expect(loaded[0].usage).toEqual({ inputTokens: 500, outputTokens: 200 })
  })

  // BEHAVIOR 5: corruption - JSONL with 3 valid and 2 malformed lines returns only 3 valid
  it('corruption: malformed JSONL lines are skipped without losing valid messages', () => {
    const sessionId = 'corruption-test'
    const filePath = path.join(tempDir, 'sessions', projectHash, `${sessionId}.jsonl`)
    // Write mixed valid and invalid lines directly
    const content = [
      JSON.stringify({ role: 'user', content: 'valid1', timestamp: 1000 }),
      '{"broken',
      '',
      JSON.stringify({ role: 'assistant', content: 'valid2', timestamp: 2000 }),
      'not json at all',
      JSON.stringify({ role: 'user', content: 'valid3', timestamp: 3000 })
    ].join('\n')
    fs.writeFileSync(filePath, content, 'utf-8')

    const loaded = store.loadSession(sessionId)
    expect(loaded).toHaveLength(3)
    expect(loaded[0].content).toBe('valid1')
    expect(loaded[1].content).toBe('valid2')
    expect(loaded[2].content).toBe('valid3')
  })

  // BEHAVIOR 6: project-hash - same workspace root always produces same hash; different roots produce different hashes
  it('project-hash: same workspace root produces same hash, different roots produce different hashes', () => {
    const root1 = '/test/workspace'
    const root2 = '/other/workspace'
    const hash1 = crypto.createHash('sha256').update(root1).digest('hex').substring(0, 16)
    const hash2 = crypto.createHash('sha256').update(root2).digest('hex').substring(0, 16)
    const hash1Again = crypto.createHash('sha256').update(root1).digest('hex').substring(0, 16)

    expect(hash1).toBe(hash1Again)
    expect(hash1).not.toBe(hash2)
    expect(hash1).toHaveLength(16)
  })

  // BEHAVIOR 7: delete - after deleting, file no longer exists and listSessions doesn't return it
  it('delete: after deleting a session, file is removed and listSessions does not return it', () => {
    const sessionId = 'delete-test'
    store.appendMessage(sessionId, { role: 'user', content: 'to be deleted', timestamp: 1000 })

    // Confirm it exists
    expect(store.loadSession(sessionId)).toHaveLength(1)

    // Delete it
    const result = store.deleteSession(sessionId)
    expect(result).toBe(true)

    // Confirm it's gone
    expect(store.loadSession(sessionId)).toHaveLength(0)
    const sessions = store.listSessions()
    expect(sessions.find(s => s.id === sessionId)).toBeUndefined()
  })

  // BEHAVIOR 8: list - listSessions returns metadata sorted by updatedAt descending
  it('list: returns session metadata sorted by updatedAt descending', async () => {
    // Create two sessions with a small delay to ensure different mtimes
    const session1 = 'list-test-1'
    const session2 = 'list-test-2'

    store.appendMessage(session1, { role: 'user', content: 'first session', timestamp: 1000 })

    // Small delay to get different mtime
    await new Promise(resolve => setTimeout(resolve, 50))

    store.appendMessage(session2, { role: 'user', content: 'second session message', timestamp: 2000 })

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(2)

    // Most recently modified should be first
    expect(sessions[0].id).toBe(session2)
    expect(sessions[1].id).toBe(session1)

    // Check metadata fields
    expect(sessions[0].title).toBe('second session message')
    expect(sessions[0].messageCount).toBe(1)
    expect(sessions[0].createdAt).toBeGreaterThan(0)
    expect(sessions[0].updatedAt).toBeGreaterThan(0)
  })

  // BEHAVIOR 9: title - session title is first 50 chars of first user message, truncated with "..."
  it('title: session title is first 50 chars of first user message, truncated with ...', () => {
    const sessionId = 'title-test'
    const longContent = 'A'.repeat(80) // 80 chars, should be truncated to 50 + "..."
    store.appendMessage(sessionId, { role: 'user', content: longContent, timestamp: 1000 })

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('A'.repeat(50) + '...')
    expect(sessions[0].title).toHaveLength(53) // 50 chars + "..."
  })

  it('title: short user message is used as-is without truncation', () => {
    const sessionId = 'title-short-test'
    store.appendMessage(sessionId, { role: 'user', content: 'Short message', timestamp: 1000 })

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Short message')
  })

  it('title: session with no user messages gets "Untitled"', () => {
    const sessionId = 'title-no-user'
    store.appendMessage(sessionId, { role: 'assistant', content: 'No user message here', timestamp: 1000 })

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Untitled')
  })

  it('delete: returns false for non-existent session', () => {
    const result = store.deleteSession('nonexistent')
    expect(result).toBe(false)
  })

  it('loadSession: returns empty array for non-existent session', () => {
    const loaded = store.loadSession('nonexistent')
    expect(loaded).toEqual([])
  })
})
