// ============================================================
// SQLite 会话持久化存储
// 实现 brain 包的 ISessionStore 接口
// 使用 better-sqlite3（同步 API），WAL 模式保证并发性能
// ============================================================

import BetterSqlite3 from 'better-sqlite3'
import type { ISessionStore, LLMProvider, SessionConfig, SessionConfigPatch, SessionMeta } from '@wzxclaw/brain'

/**
 * SQLite 会话存储
 *
 * 表结构:
 * - sessions: id TEXT PK, title TEXT DEFAULT '', updated_at INTEGER
 * - session_config: session_id TEXT PK, per-session defaults and ownership metadata
 * - messages: session_id TEXT, seq INTEGER, message TEXT (JSON)
 *   联合主键 (session_id, seq)
 */
export class SessionStoreSqlite implements ISessionStore {
  private db: BetterSqlite3.Database

  // 预编译语句（性能优化）
  private stmtInsertSession!: BetterSqlite3.Statement
  private stmtUpdateSession!: BetterSqlite3.Statement
  private stmtTouchSession!: BetterSqlite3.Statement
  private stmtInsertMessage!: BetterSqlite3.Statement
  private stmtLoadMessages!: BetterSqlite3.Statement
  private stmtListSessions!: BetterSqlite3.Statement
  private stmtDeleteMessages!: BetterSqlite3.Statement
  private stmtDeleteSession!: BetterSqlite3.Statement
  private stmtGetMaxSeq!: BetterSqlite3.Statement
  private stmtGetSession!: BetterSqlite3.Statement
  private stmtInsertSessionConfig!: BetterSqlite3.Statement
  private stmtGetSessionConfig!: BetterSqlite3.Statement
  private stmtUpdateSessionConfig!: BetterSqlite3.Statement

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath)

    // 启用 WAL 模式 — 并发读写不阻塞
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    // 创建表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_config (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        model TEXT,
        provider TEXT,
        target_hand_id TEXT,
        owner TEXT NOT NULL DEFAULT 'nas-remote',
        working_directory TEXT,
        project_roots TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `)

    // 创建索引 — 按 updated_at 排序查询会话列表
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_session_id
        ON messages(session_id);
    `)

    // 预编译语句
    this.stmtInsertSession = this.db.prepare(
      'INSERT INTO sessions (id, title, updated_at) VALUES (?, ?, ?)'
    )
    this.stmtUpdateSession = this.db.prepare(
      'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?'
    )
    this.stmtTouchSession = this.db.prepare(
      'UPDATE sessions SET updated_at = ? WHERE id = ?'
    )
    this.stmtInsertMessage = this.db.prepare(
      'INSERT INTO messages (session_id, seq, message) VALUES (?, ?, ?)'
    )
    this.stmtLoadMessages = this.db.prepare(
      'SELECT message FROM messages WHERE session_id = ? ORDER BY seq ASC'
    )
    this.stmtListSessions = this.db.prepare(
      `SELECT s.id, s.title, s.updated_at, c.created_at, c.workspace_id, c.model, c.provider,
              c.target_hand_id, c.owner, COUNT(m.seq) AS message_count
         FROM sessions s
         LEFT JOIN session_config c ON c.session_id = s.id
         LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id, s.title, s.updated_at, c.created_at, c.workspace_id, c.model, c.provider, c.target_hand_id, c.owner
        ORDER BY s.updated_at DESC, s.id DESC`
    )
    this.stmtDeleteMessages = this.db.prepare(
      'DELETE FROM messages WHERE session_id = ?'
    )
    this.stmtDeleteSession = this.db.prepare(
      'DELETE FROM sessions WHERE id = ?'
    )
    this.stmtGetMaxSeq = this.db.prepare(
      'SELECT MAX(seq) as maxSeq FROM messages WHERE session_id = ?'
    )
    this.stmtGetSession = this.db.prepare(
      'SELECT id FROM sessions WHERE id = ?'
    )
    this.stmtInsertSessionConfig = this.db.prepare(
      `INSERT INTO session_config (
        session_id, workspace_id, model, provider, target_hand_id, owner,
        working_directory, project_roots, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING`
    )
    this.stmtGetSessionConfig = this.db.prepare(
      `SELECT s.id, s.title, s.updated_at, c.workspace_id, c.model, c.provider,
              c.target_hand_id, c.owner, c.working_directory, c.project_roots,
              c.metadata, c.created_at, c.updated_at AS config_updated_at
         FROM sessions s
         LEFT JOIN session_config c ON c.session_id = s.id
        WHERE s.id = ?`
    )
    this.stmtUpdateSessionConfig = this.db.prepare(
      `UPDATE session_config
          SET workspace_id = ?, model = ?, provider = ?, target_hand_id = ?, owner = ?,
              working_directory = ?, project_roots = ?, metadata = ?, updated_at = ?
        WHERE session_id = ?`
    )
  }

  private ensureSessionConfig(sessionId: string, now: number): void {
    this.stmtInsertSessionConfig.run(
      sessionId,
      null,
      null,
      null,
      null,
      'nas-remote',
      null,
      null,
      null,
      now,
      now,
    )
  }

  private parseJsonArray(value: string | null | undefined): string[] | undefined {
    if (!value) return undefined
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined
    } catch {
      return undefined
    }
  }

  private parseJsonObject(value: string | null | undefined): Record<string, unknown> | undefined {
    if (!value) return undefined
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  private normalizeProvider(value: string | null | undefined): LLMProvider | undefined {
    return value === 'openai' || value === 'anthropic' ? value : undefined
  }

  private configFromRow(row: {
    id: string
    title: string
    updated_at: number
    workspace_id?: string | null
    model?: string | null
    provider?: string | null
    target_hand_id?: string | null
    owner?: string | null
    working_directory?: string | null
    project_roots?: string | null
    metadata?: string | null
    created_at?: number | null
    config_updated_at?: number | null
  }): SessionConfig {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at ?? row.updated_at,
      updatedAt: row.config_updated_at ?? row.updated_at,
      workspaceId: row.workspace_id ?? undefined,
      model: row.model ?? undefined,
      provider: this.normalizeProvider(row.provider),
      targetHandId: row.target_hand_id ?? undefined,
      owner: row.owner === 'desktop-local' ? 'desktop-local' : 'nas-remote',
      workingDirectory: row.working_directory ?? undefined,
      projectRoots: this.parseJsonArray(row.project_roots),
      metadata: this.parseJsonObject(row.metadata),
    }
  }

  /**
   * 追加消息到会话
   * 如果会话不存在则自动创建（title 取消息内容前 50 字符）
   */
  async appendMessage(sessionId: string, message: unknown): Promise<void> {
    const messageJson = JSON.stringify(message)
    const now = Date.now()

    // 提取 title：如果是带 content 字段的对象，取前 50 字符
    let title = ''
    if (message && typeof message === 'object' && 'content' in message) {
      const content = String((message as { content: unknown }).content)
      title = content.slice(0, 50)
    }

    // 获取当前最大 seq
    const row = this.stmtGetMaxSeq.get(sessionId) as { maxSeq: number | null }
    const nextSeq = (row?.maxSeq ?? -1) + 1

    // 使用事务保证原子性
    const insertAll = this.db.transaction(() => {
      // 检查会话是否存在
      const existing = this.stmtGetSession.get(sessionId) as { id: string } | undefined

      if (!existing) {
        // 创建新会话
        this.stmtInsertSession.run(sessionId, title, now)
      } else {
        // 更新会话时间戳，避免每条消息覆盖用户重命名的标题
        this.stmtTouchSession.run(now, sessionId)
      }

      this.ensureSessionConfig(sessionId, now)

      // 插入消息
      this.stmtInsertMessage.run(sessionId, nextSeq, messageJson)
    })

    insertAll()

    return Promise.resolve()
  }

  /**
   * 加载会话消息列表
   * 会话不存在时返回空数组（不报错）
   */
  async loadSession(sessionId: string): Promise<unknown[]> {
    const rows = this.stmtLoadMessages.all(sessionId) as Array<{ message: string }>
    return Promise.resolve(rows.map(row => JSON.parse(row.message)))
  }

  /**
   * 列出所有会话（按最后更新时间倒序）
   */
  async listSessions(): Promise<SessionMeta[]> {
    const rows = this.stmtListSessions.all() as Array<{
      id: string
      title: string
      updated_at: number
      created_at: number | null
      workspace_id: string | null
      model: string | null
      provider: string | null
      target_hand_id: string | null
      owner: string | null
      message_count: number
    }>
    return Promise.resolve(rows.map(row => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      createdAt: row.created_at ?? row.updated_at,
      workspaceId: row.workspace_id ?? undefined,
      model: row.model ?? undefined,
      provider: this.normalizeProvider(row.provider),
      targetHandId: row.target_hand_id ?? undefined,
      owner: row.owner === 'desktop-local' ? 'desktop-local' : 'nas-remote',
      messageCount: Number(row.message_count ?? 0),
    })))
  }

  /**
   * 删除会话及其所有消息（事务保证原子性）
   */
  async deleteSession(sessionId: string): Promise<void> {
    const deleteAll = this.db.transaction(() => {
      this.stmtDeleteMessages.run(sessionId)
      this.stmtDeleteSession.run(sessionId)
    })
    deleteAll()
    return Promise.resolve()
  }

  /**
   * 原子替换会话消息（事务内删除旧消息 + 插入新消息）
   * 用于 session rewind 等需要截断消息的场景，避免 delete+rebuild 的数据丢失风险
   */
  async replaceMessages(sessionId: string, messages: unknown[]): Promise<void> {
    const now = Date.now()
    const replaceAll = this.db.transaction(() => {
      // 确保会话存在
      const existing = this.stmtGetSession.get(sessionId) as { id: string } | undefined
      if (!existing) {
        this.stmtInsertSession.run(sessionId, '', now)
        this.ensureSessionConfig(sessionId, now)
      }
      // 删除旧消息
      this.stmtDeleteMessages.run(sessionId)
      // 插入新消息
      for (let i = 0; i < messages.length; i++) {
        this.stmtInsertMessage.run(sessionId, i, JSON.stringify(messages[i]))
      }
      this.stmtTouchSession.run(now, sessionId)
    })
    replaceAll()
    return Promise.resolve()
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const now = Date.now()
    const existing = this.stmtGetSession.get(sessionId) as { id: string } | undefined
    if (!existing) {
      this.stmtInsertSession.run(sessionId, title, now)
    } else {
      this.stmtUpdateSession.run(title, now, sessionId)
    }
    return Promise.resolve()
  }

  async createSession(config: { id: string } & SessionConfigPatch): Promise<SessionConfig> {
    const now = Date.now()
    const title = config.title ?? 'Untitled'
    const createAll = this.db.transaction(() => {
      const existing = this.stmtGetSession.get(config.id) as { id: string } | undefined
      if (!existing) {
        this.stmtInsertSession.run(config.id, title, now)
      } else if (config.title !== undefined) {
        this.stmtUpdateSession.run(title, now, config.id)
      }
      this.ensureSessionConfig(config.id, now)
    })
    createAll()

    return this.updateSessionConfig(config.id, config)
  }

  async getSessionConfig(sessionId: string): Promise<SessionConfig | null> {
    const row = this.stmtGetSessionConfig.get(sessionId) as Parameters<typeof this.configFromRow>[0] | undefined
    if (!row) return null
    if (!row.created_at) {
      this.ensureSessionConfig(sessionId, row.updated_at)
      const refreshed = this.stmtGetSessionConfig.get(sessionId) as Parameters<typeof this.configFromRow>[0]
      return this.configFromRow(refreshed)
    }
    return this.configFromRow(row)
  }

  async updateSessionConfig(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    const now = Date.now()
    const existing = await this.getSessionConfig(sessionId)
    if (!existing) {
      const title = patch.title ?? 'Untitled'
      this.stmtInsertSession.run(sessionId, title, now)
      this.ensureSessionConfig(sessionId, now)
    }

    const current = (await this.getSessionConfig(sessionId))!
    const next: SessionConfig = {
      ...current,
      ...patch,
      id: sessionId,
      title: patch.title ?? current.title,
      createdAt: current.createdAt,
      updatedAt: now,
      owner: patch.owner ?? current.owner ?? 'nas-remote',
    }

    const updateAll = this.db.transaction(() => {
      if (patch.title !== undefined) {
        this.stmtUpdateSession.run(next.title, now, sessionId)
      } else {
        this.stmtTouchSession.run(now, sessionId)
      }
      this.stmtUpdateSessionConfig.run(
        next.workspaceId ?? null,
        next.model ?? null,
        next.provider ?? null,
        next.targetHandId ?? null,
        next.owner ?? 'nas-remote',
        next.workingDirectory ?? null,
        next.projectRoots ? JSON.stringify(next.projectRoots) : null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        now,
        sessionId,
      )
    })
    updateAll()

    return (await this.getSessionConfig(sessionId))!
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close()
  }
}
