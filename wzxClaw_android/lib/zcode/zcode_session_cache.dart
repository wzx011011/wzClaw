// ============================================================
// zcode_session_cache — ZCode 会话本地持久缓存（SQLite）
//
// 只持久化 canonical timeline：每条已确认消息一行，有序过程行整体
// 存 process_parts_json。不迁移、不翻译旧结构——建库时发现旧版本
// 直接删表重建（权威历史在桌面节点，重新打开会话即重拉）。
//
// 约定：
// - 只持久化 synced 且 protoId 非空的消息（实时投影不落盘）；
// - upsert 按 (session_id, proto_id) 幂等；
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

  // ============================================================
  // 硬切换（2026-09-18）：唯一用户 = 作者本人，无任何版本兼容。
  // 直接换新文件名 → 旧 schema 文件永远打不开；旧文件顺手删除
  // （尽力而为）。数据库不做迁移、不做降级、不跑 onUpgrade。
  // ============================================================
  static const _dbName = 'wzxclaw_zcode_cache_canonical_v2.db';

  /// 被硬切换作废的旧文件名（启动首次建库时删掉，避免残留）。
  /// v2：zcode_messages 增加 truncated 列（审查 P2-10 截断标记持久化）。
  static const _legacyDbNames = [
    'wzxclaw_zcode_cache_canonical.db',
    'wzxclaw_zcode_cache.db',
  ];

  /// 单条过程行/单条消息的本地缓存上限。运行时和引擎历史保留完整值；
  /// 这里只约束 SQLite 副本，避免一次命令输出撑爆整个会话缓存。
  static const _kMaxCachedDetailChars = 24000;
  static const _kMaxCachedMessageChars = 120000;

  Database? _db;

  Future<Database> _ensureDb() async {
    if (_db != null) return _db!;
    // web 无 sqflite 实现（flutter web 支持，2026-09-22）：显式禁用缓存，
    // 全部方法经调用方 try/catch 降级为空——纯网络拉取，绝不假装有缓存
    if (kIsWeb) {
      throw UnsupportedError('web 无本地 SQLite 缓存（缓存禁用）');
    }
    // 旧 schema 文件作废：首次建库前尽力删除（失败不影响任何功能）。
    for (final legacy in _legacyDbNames) {
      try {
        await deleteDatabase(legacy);
      } catch (_) {}
    }
    _db = await openDatabase(
      _dbName,
      version: 1,
      onCreate: _createTables,
    );
    return _db!;
  }

  static Future<void> _createTables(Database db, int version) async {
    await db.execute('''
      CREATE TABLE zcode_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        proto_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        model TEXT,
        agent TEXT,
        turn_id TEXT,
        process_parts_json TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        duration_ms INTEGER
      )
    ''');
    await db.execute(
      'CREATE UNIQUE INDEX idx_zcode_msg_proto ON zcode_messages(session_id, proto_id)',
    );
    await db.execute(
      'CREATE INDEX idx_zcode_msg_session ON zcode_messages(session_id, id)',
    );
    await db.execute('''
      CREATE TABLE zcode_cursors (
        session_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT 0,
        watermark TEXT,
        updated_at INTEGER NOT NULL
      )
    ''');
  }

  // ---- 消息 ----

  /// 幂等写入一批已确认消息：流式占位即使已经拿到 assistantMessageId，
  /// 在 session/messages 返回前仍不是历史权威版本，不能写入缓存或水位。
  Future<void> upsertMessages(
    String sessionId,
    Iterable<ZcodeSessionItem> items,
  ) async {
    final db = await _ensureDb();
    await db.transaction((txn) async {
      for (final it in items) {
        final pid = it.protoId;
        if (pid == null || !it.synced) continue;
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
  Future<List<ZcodeSessionItem>> loadTail(
    String sessionId, {
    int limit = 80,
  }) async {
    final db = await _ensureDb();
    final rows = await db.query(
      'zcode_messages',
      where: 'session_id = ?',
      whereArgs: [sessionId],
      // 服务端历史数组是权威顺序；同一 created_at 的本地 tie-break 采用
      // 插入顺序，避免同一毫秒的消息在重启后反向跳动。
      orderBy: 'created_at DESC, id DESC',
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

  Future<void> clearAll() async {
    final db = await _ensureDb();
    await db.delete('zcode_messages');
    await db.delete('zcode_cursors');
  }

  // ---- 行映射 ----

  Map<String, dynamic> _toRow(String sessionId, ZcodeSessionItem it) {
    final m = it.message;
    final (encodedParts, truncated) = _encodeProcessParts(m.processParts);
    return {
      'session_id': sessionId,
      'proto_id': it.protoId,
      'role': m.role.name,
      'created_at': m.createdAt.millisecondsSinceEpoch,
      'model': m.model,
      'agent': m.agent,
      'turn_id': it.turnId,
      'process_parts_json': encodedParts,
      'truncated': truncated ? 1 : 0,
      'input_tokens': m.usage?.inputTokens,
      'output_tokens': m.usage?.outputTokens,
      'duration_ms': m.durationMs,
    };
  }

  /// 返回 (编码 JSON, 是否发生截断)。截断标记随行持久化（审查 P2-10）：
  /// 读回时区分「服务端确认过」与「本地保存了完整内容」，联网后按窗口补齐。
  (String, bool) _encodeProcessParts(List<ChatProcessPart> parts) {
    var truncated = false;
    var cached = parts.map((part) {
      final capped = _cacheProcessPart(part);
      if (_partContentChanged(part, capped)) truncated = true;
      return capped;
    }).toList(growable: false);
    var encoded = jsonEncode(cached.map((part) => part.toJson()).toList());
    if (encoded.length <= _kMaxCachedMessageChars) return (encoded, truncated);

    // 第二档保留全部顺序和类型，压缩文本/工具详情；超限则只保留前 128 行
    // 并追加诊断标记。运行时与服务端权威历史不受此限制。
    // 内容一旦被压缩改变就必须置 truncated：否则该行永远不会再被
    // 权威补齐（标记是「内容不完整」的唯一事实源）。
    final compressed = cached
        .map(
          (part) => switch (part.kind) {
            ChatProcessPartKind.text ||
            ChatProcessPartKind.reasoning =>
              part.copyWith(text: _capText(part.text, 8000)),
            ChatProcessPartKind.tool => part.copyWith(
                toolCall: _cacheTool(part.toolCall!, detailLimit: 4000),
              ),
            ChatProcessPartKind.marker => part,
          },
        )
        .toList(growable: false);
    for (var i = 0; i < compressed.length; i++) {
      if (_partContentChanged(cached[i], compressed[i])) {
        truncated = true;
        break;
      }
    }
    cached = compressed;
    encoded = jsonEncode(cached.map((part) => part.toJson()).toList());
    if (encoded.length <= _kMaxCachedMessageChars) return (encoded, truncated);

    final reduced = cached.take(128).toList(growable: true)
      ..add(const ChatProcessPart.marker('cache-truncated'));
    truncated = true;
    return (jsonEncode(reduced.map((part) => part.toJson()).toList()), truncated);
  }

  /// 截断判定：限流前后文本/工具详情是否发生变化
  bool _partContentChanged(ChatProcessPart before, ChatProcessPart after) {
    if (before.text != after.text) return true;
    final bt = before.toolCall;
    final at = after.toolCall;
    if (bt == null || at == null) return false;
    return bt.inputFull != at.inputFull || bt.outputFull != at.outputFull;
  }

  ChatProcessPart _cacheProcessPart(ChatProcessPart part) {
    return switch (part.kind) {
      ChatProcessPartKind.text ||
      ChatProcessPartKind.reasoning =>
        part.copyWith(text: _capText(part.text, _kMaxCachedDetailChars)),
      ChatProcessPartKind.tool =>
        part.copyWith(toolCall: _cacheTool(part.toolCall!)),
      ChatProcessPartKind.marker => part,
    };
  }

  ToolCallInfo _cacheTool(ToolCallInfo tool, {int? detailLimit}) {
    final limit = detailLimit ?? _kMaxCachedDetailChars;
    return tool.copyWith(
      inputFull: _capText(tool.inputFull, limit),
      outputFull: _capText(tool.outputFull, limit),
    );
  }

  String? _capText(String? text, int limit) {
    if (text == null || text.length <= limit) return text;
    return '${text.substring(0, limit)}…（缓存已截断）';
  }

  ZcodeSessionItem _fromRow(Map<String, dynamic> row) {
    List<ChatProcessPart>? processParts;
    final processPartsJson = row['process_parts_json'] as String?;
    if (processPartsJson != null && processPartsJson.isNotEmpty) {
      try {
        final list = jsonDecode(processPartsJson) as List;
        processParts = list
            .whereType<Map>()
            .map((e) => ChatProcessPart.fromJson(Map<String, dynamic>.from(e)))
            .toList();
      } catch (_) {
        processParts = null; // 损坏行降级为空消息，下次权威刷新覆盖
      }
    }
    final input = row['input_tokens'] as int?;
    final output = row['output_tokens'] as int?;
    return ZcodeSessionItem(
      protoId: row['proto_id'] as String?,
      turnId: row['turn_id'] as String?,
      synced: true, // 缓存里的消息均已获服务端确认
      // 截断标记（审查 P2-10）：synced=身份确认，truncated=内容不完整，
      // 两者独立——联网后按窗口补齐截断项
      truncated: row['truncated'] == 1,
      dirty: false, // 已持久化，无需重写
      message: ChatMessage(
        id: row['id'] as int?,
        // 未知 role 值容错回退 user：一行坏数据不能炸掉整页加载
        role: row['role'] == 'assistant'
            ? MessageRole.assistant
            : MessageRole.user,
        processParts: processParts ?? const [],
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          row['created_at'] as int? ?? 0,
        ),
        usage: input != null && output != null
            ? TokenUsage(inputTokens: input, outputTokens: output)
            : null,
        model: row['model'] as String?,
        // 视图身份镜像：块身份键用 protoId，重启恢复后身份不变
        protoId: row['proto_id'] as String?,
        agent: row['agent'] as String?,
        durationMs: row['duration_ms'] as int?,
      ),
    );
  }
}
