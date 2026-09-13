// ============================================================
// zcode_session_cache — ZCode 会话本地持久缓存（SQLite，P1.2）
//
// 每会话消息（带协议消息 id）+ seq 水位持久化，App 重启秒开：
// 打开会话先出缓存（0ms）再走网络增量校正。参考
// services/chat_database.dart 的既有模式与依赖（sqflite + 惰性建表 +
// @visibleForTesting 注入替身）。
//
// 约定：
// - 只持久化 protoId 非空的消息（本地乐观消息由权威数据消解后再落盘）；
// - upsert 按 (session_id, proto_id) 幂等，更新保留原行位置（展示
//   顺序即写入顺序）；
// - 缓存尽力而为：任何失败由调用方（store）静默吞掉，网络路径兜底。
// ============================================================

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';

import '../models/chat_message.dart';
import 'zcode_session_state.dart' show ZcodeSessionItem;

/// 每会话同步游标（断线补放与消息水位）
class ZcodeSessionCursor {
  final int lastSeq;
  final String? watermark;

  const ZcodeSessionCursor({required this.lastSeq, this.watermark});
}

/// ZCode 会话缓存（消息尾窗 + 游标）
class ZcodeSessionCache {
  /// 生产构造器（真机路径；实际建库推迟到首次访问）
  ZcodeSessionCache();

  /// 仅测试使用：子类（内存伪实现）继承时使用的可见构造器。
  /// 产品代码不应调用。
  @visibleForTesting
  ZcodeSessionCache.forTest();

  static const _dbName = 'wzxclaw_zcode_cache.db';
  static const _dbVersion = 1;

  Database? _db;

  Future<Database> _ensureDb() async {
    _db ??= await openDatabase(
      _dbName,
      version: _dbVersion,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE zcode_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            proto_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            model TEXT,
            tool_calls_json TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER
          )
        ''');
        await db.execute(
            'CREATE UNIQUE INDEX idx_zcode_msg_proto ON zcode_messages(session_id, proto_id)',);
        await db.execute(
            'CREATE INDEX idx_zcode_msg_session ON zcode_messages(session_id, id)',);
        await db.execute('''
          CREATE TABLE zcode_cursors (
            session_id TEXT PRIMARY KEY,
            last_seq INTEGER NOT NULL DEFAULT 0,
            watermark TEXT,
            updated_at INTEGER NOT NULL
          )
        ''');
      },
    );
    return _db!;
  }

  // ---- 消息 ----

  /// 幂等写入一批消息（跳过 protoId 为空的本地乐观条目）：
  /// 已有 (session_id, proto_id) 则原位更新，否则插入（追加到尾部）
  Future<void> upsertMessages(
      String sessionId, Iterable<ZcodeSessionItem> items,) async {
    final db = await _ensureDb();
    await db.transaction((txn) async {
      for (final it in items) {
        final pid = it.protoId;
        if (pid == null) continue; // 本地乐观消息不落盘
        final map = _toRow(sessionId, it);
        final updated = await txn.update(
          'zcode_messages',
          map,
          where: 'session_id = ? AND proto_id = ?',
          whereArgs: [sessionId, pid],
        );
        if (updated == 0) await txn.insert('zcode_messages', map);
      }
    });
  }

  /// 读取会话消息尾窗（时间序，最新 limit 条）
  Future<List<ZcodeSessionItem>> loadTail(String sessionId,
      {int limit = 80,}) async {
    final db = await _ensureDb();
    final rows = await db.query(
      'zcode_messages',
      where: 'session_id = ?',
      whereArgs: [sessionId],
      orderBy: 'id DESC',
      limit: limit,
    );
    return rows.reversed.map(_fromRow).toList();
  }

  // ---- 游标 ----

  Future<ZcodeSessionCursor?> loadCursor(String sessionId) async {
    final db = await _ensureDb();
    final rows = await db.query(
      'zcode_cursors',
      where: 'session_id = ?',
      whereArgs: [sessionId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return ZcodeSessionCursor(
      lastSeq: row['last_seq'] as int? ?? 0,
      watermark: row['watermark'] as String?,
    );
  }

  Future<void> saveCursor(
    String sessionId, {
    required int lastSeq,
    String? watermark,
  }) async {
    final db = await _ensureDb();
    await db.insert(
      'zcode_cursors',
      {
        'session_id': sessionId,
        'last_seq': lastSeq,
        'watermark': watermark,
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  // ---- 清理 ----

  Future<void> deleteSession(String sessionId) async {
    final db = await _ensureDb();
    await db.transaction((txn) async {
      await txn.delete('zcode_messages',
          where: 'session_id = ?', whereArgs: [sessionId],);
      await txn.delete('zcode_cursors',
          where: 'session_id = ?', whereArgs: [sessionId],);
    });
  }

  Future<void> clearAll() async {
    final db = await _ensureDb();
    await db.delete('zcode_messages');
    await db.delete('zcode_cursors');
  }

  // ---- 行映射 ----

  Map<String, dynamic> _toRow(String sessionId, ZcodeSessionItem it) {
    final m = it.message;
    return {
      'session_id': sessionId,
      'proto_id': it.protoId,
      'role': m.role.name,
      'content': m.content,
      'created_at': m.createdAt.millisecondsSinceEpoch,
      'model': m.model,
      'tool_calls_json': m.toolCalls != null
          ? jsonEncode(m.toolCalls!.map((t) => t.toJson()).toList())
          : null,
      'input_tokens': m.usage?.inputTokens,
      'output_tokens': m.usage?.outputTokens,
    };
  }

  ZcodeSessionItem _fromRow(Map<String, dynamic> row) {
    List<ToolCallInfo>? toolCalls;
    final toolCallsJson = row['tool_calls_json'] as String?;
    if (toolCallsJson != null && toolCallsJson.isNotEmpty) {
      try {
        final list = jsonDecode(toolCallsJson) as List;
        toolCalls = list
            .map((e) => ToolCallInfo.fromJson(Map<String, dynamic>.from(e)))
            .toList();
      } catch (_) {
        toolCalls = null; // 损坏数据降级为纯文本
      }
    }
    final input = row['input_tokens'] as int?;
    final output = row['output_tokens'] as int?;
    return ZcodeSessionItem(
      protoId: row['proto_id'] as String?,
      synced: true, // 缓存里的消息均已获服务端确认
      dirty: false, // 已持久化，无需重写
      message: ChatMessage(
        id: row['id'] as int?,
        role: MessageRole.values.byName(row['role'] as String? ?? 'user'),
        content: row['content'] as String? ?? '',
        createdAt: DateTime.fromMillisecondsSinceEpoch(
            row['created_at'] as int? ?? 0,),
        toolCalls: toolCalls,
        usage: input != null && output != null
            ? TokenUsage(inputTokens: input, outputTokens: output)
            : null,
        model: row['model'] as String?,
      ),
    );
  }
}
