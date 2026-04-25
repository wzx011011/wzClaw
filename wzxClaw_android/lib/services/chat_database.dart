import 'package:sqflite/sqflite.dart';
import '../models/chat_message.dart';
import '../models/session_meta.dart';

class ChatDatabase {
  static final ChatDatabase _instance = ChatDatabase._();
  static ChatDatabase get instance => _instance;
  ChatDatabase._();

  static const _dbName = 'wzxclaw_chat.db';
  static const _dbVersion = 5;

  Database? _db;

  Future<Database> _ensureDb() async {
    _db ??= await openDatabase(
      _dbName,
      version: _dbVersion,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            desktop_id TEXT,
            task_id TEXT,
            role INTEGER NOT NULL,
            content TEXT NOT NULL,
            tool_name TEXT,
            tool_status INTEGER,
            created_at INTEGER NOT NULL,
            tool_call_id TEXT,
            tool_input TEXT,
            tool_output TEXT,
            tool_result_summary TEXT,
            tool_calls_json TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER
          )
        ''');
        await db.execute('''
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            is_synced INTEGER NOT NULL DEFAULT 0
          )
        ''');
        await db.execute(
            'CREATE INDEX idx_messages_session ON messages(session_id)',);
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute('ALTER TABLE messages ADD COLUMN tool_call_id TEXT');
          await db.execute('ALTER TABLE messages ADD COLUMN tool_input TEXT');
          await db.execute('ALTER TABLE messages ADD COLUMN tool_output TEXT');
          await db.execute(
              'ALTER TABLE messages ADD COLUMN tool_calls_json TEXT',);
          await db.execute(
              'ALTER TABLE messages ADD COLUMN input_tokens INTEGER',);
          await db.execute(
              'ALTER TABLE messages ADD COLUMN output_tokens INTEGER',);
        }
        if (oldVersion < 3) {
          await db.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              workspace_path TEXT NOT NULL,
              workspace_name TEXT NOT NULL,
              title TEXT NOT NULL DEFAULT 'Untitled',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              message_count INTEGER NOT NULL DEFAULT 0,
              is_synced INTEGER NOT NULL DEFAULT 0
            )
          ''');
          await db.execute(
              'ALTER TABLE messages ADD COLUMN session_id TEXT',);
          await db.execute(
              'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',);
        }
        if (oldVersion < 4) {
          await db.execute(
              'ALTER TABLE messages ADD COLUMN tool_result_summary TEXT',);
        }
        if (oldVersion < 5) {
          await db.execute('ALTER TABLE messages ADD COLUMN desktop_id TEXT');
          await db.execute('ALTER TABLE messages ADD COLUMN task_id TEXT');
        }
      },
    );
    return _db!;
  }

  // ---- Message CRUD ----

  Future<void> insertMessage(
    ChatMessage msg, {
    String? sessionId,
    String? desktopId,
    String? taskId,
  }) async {
    final db = await _ensureDb();
    final map = msg.toDbMap();
    if (sessionId != null) {
      map['session_id'] = sessionId;
    }
    map['desktop_id'] = desktopId;
    map['task_id'] = taskId;
    await db.insert('messages', map);
  }

  Future<List<ChatMessage>> getMessages({
    String? desktopId,
    String? taskId,
    int limit = 100,
    int offset = 0,
  }) async {
    final db = await _ensureDb();
    final scopeFilter = desktopId != null || taskId != null;
    final rows = await db.query(
      'messages',
      where: scopeFilter
          ? 'session_id IS NULL AND desktop_id = ? AND task_id = ?'
          : 'session_id IS NULL',
      whereArgs: scopeFilter ? [desktopId, taskId] : null,
      orderBy: 'created_at ASC',
      limit: limit,
      offset: offset,
    );
    return rows.map((r) => ChatMessage.fromDbMap(r)).toList();
  }

  Future<int> getMessageCount() async {
    final db = await _ensureDb();
    final result = await db.rawQuery(
        'SELECT COUNT(*) as cnt FROM messages WHERE session_id IS NULL',);
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<void> clearAll() async {
    final db = await _ensureDb();
    await db.delete('messages');
  }

  Future<void> updateMessage(ChatMessage msg) async {
    if (msg.id == null) return;
    final db = await _ensureDb();
    await db.update(
      'messages',
      msg.toDbMap(),
      where: 'id = ?',
      whereArgs: [msg.id],
    );
  }

  Future<void> deleteMessage(int id) async {
    final db = await _ensureDb();
    await db.delete('messages', where: 'id = ?', whereArgs: [id]);
  }

  // ---- Session CRUD ----

  Future<void> upsertSession(SessionMeta session) async {
    final db = await _ensureDb();
    await db.insert(
      'sessions',
      session.toDbMap(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> upsertSessions(List<SessionMeta> sessions) async {
    final db = await _ensureDb();
    final batch = db.batch();
    for (final s in sessions) {
      batch.insert('sessions', s.toDbMap(),
          conflictAlgorithm: ConflictAlgorithm.replace,);
    }
    await batch.commit(noResult: true);
  }

  Future<List<SessionMeta>> getSessions({String? workspacePath}) async {
    final db = await _ensureDb();
    final rows = await db.query(
      'sessions',
      where: workspacePath != null ? 'workspace_path = ?' : null,
      whereArgs: workspacePath != null ? [workspacePath] : null,
      orderBy: 'updated_at DESC',
    );
    return rows.map((r) => SessionMeta.fromDbMap(r)).toList();
  }

  Future<void> deleteSessionAndMessages(String sessionId) async {
    final db = await _ensureDb();
    await db.transaction((txn) async {
      await txn.delete('messages',
          where: 'session_id = ?', whereArgs: [sessionId],);
      await txn.delete('sessions', where: 'id = ?', whereArgs: [sessionId]);
    });
  }

  Future<void> clearSessionMessages(String sessionId) async {
    final db = await _ensureDb();
    await db.delete('messages',
        where: 'session_id = ?', whereArgs: [sessionId],);
    await db.update('sessions', {'is_synced': 0},
        where: 'id = ?', whereArgs: [sessionId],);
  }

  // ---- Session-scoped message queries ----

  Future<List<ChatMessage>> getSessionMessages(String sessionId,
      {int limit = 100, int offset = 0,}) async {
    final db = await _ensureDb();
    final rows = await db.query(
      'messages',
      where: 'session_id = ?',
      whereArgs: [sessionId],
      orderBy: 'created_at ASC',
      limit: limit,
      offset: offset,
    );
    return rows.map((r) => ChatMessage.fromDbMap(r)).toList();
  }

  Future<void> insertSessionMessage(String sessionId, ChatMessage msg) async {
    final db = await _ensureDb();
    final map = msg.toDbMap();
    map['session_id'] = sessionId;
    await db.insert('messages', map);
  }

  Future<void> insertSessionMessages(
      String sessionId, List<ChatMessage> messages,) async {
    final db = await _ensureDb();
    final batch = db.batch();
    for (final msg in messages) {
      final map = msg.toDbMap();
      map['session_id'] = sessionId;
      batch.insert('messages', map);
    }
    await batch.commit(noResult: true);
  }

  Future<int> getSessionMessageCount(String sessionId) async {
    final db = await _ensureDb();
    final result = await db.rawQuery(
        'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?',
        [sessionId],);
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<void> markSessionSynced(String sessionId) async {
    final db = await _ensureDb();
    await db.update('sessions', {'is_synced': 1},
        where: 'id = ?', whereArgs: [sessionId],);
  }
}
