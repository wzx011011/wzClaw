// ============================================================
// SQLite 会话持久化存储
// 实现 brain 包的 ISessionStore 接口
// 使用 better-sqlite3（同步 API），WAL 模式保证并发性能
// ============================================================

import BetterSqlite3 from 'better-sqlite3'
import type { ISessionStore } from '@wzxclaw/brain'

/**
 * SQLite 会话存储
 *
 * 表结构:
 * - sessions: id TEXT PK, title TEXT DEFAULT '', updated_at INTEGER
 * - messages: session_id TEXT, seq INTEGER, message TEXT (JSON)
 *   联合主键 (session_id, seq)
 */
export class SessionStoreSqlite implements ISessionStore {
  private db: BetterSqlite3.Database

  // 预编译语句（性能优化）
  private stmtInsertSession!: BetterSqlite3.Statement
  private stmtUpdateSession!: BetterSqlite3.Statement
  private stmtInsertMessage!: BetterSqlite3.Statement
  private stmtLoadMessages!: BetterSqlite3.Statement
  private stmtListSessions!: BetterSqlite3.Statement
  private stmtDeleteMessages!: BetterSqlite3.Statement
  private stmtDeleteSession!: BetterSqlite3.Statement
  private stmtGetMaxSeq!: BetterSqlite3.Statement
  private stmtGetSession!: BetterSqlite3.Statement

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath)

    // 启用 WAL 模式 — 并发读写不阻塞
    this.db.pragma('journal_mode = WAL')

    // 创建表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
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
    this.stmtInsertMessage = this.db.prepare(
      'INSERT INTO messages (session_id, seq, message) VALUES (?, ?, ?)'
    )
    this.stmtLoadMessages = this.db.prepare(
      'SELECT message FROM messages WHERE session_id = ? ORDER BY seq ASC'
    )
    this.stmtListSessions = this.db.prepare(
      'SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC, id DESC'
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
        // 更新会话时间戳
        this.stmtUpdateSession.run(title, now, sessionId)
      }

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
  async listSessions(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    const rows = this.stmtListSessions.all() as Array<{ id: string; title: string; updated_at: number }>
    return Promise.resolve(rows.map(row => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
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
   * 关闭数据库连接
   */
  close(): void {
    this.db.close()
  }
}
