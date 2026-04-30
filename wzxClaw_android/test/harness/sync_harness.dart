/// 同步层测试夹具：提供可注入的 [WsTransport] 与 [ChatDatabase] 伪实现，
/// 让 [ChatStore] / [SessionSyncService] 可以在不依赖真实 WS / sqflite
/// 的情况下被驱动并断言行为。
library;

import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/models/connection_state.dart';
import 'package:wzxclaw_android/models/session_meta.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/chat_database.dart';
import 'package:wzxclaw_android/services/chat_store.dart';
import 'package:wzxclaw_android/services/session_sync_service.dart';
import 'package:wzxclaw_android/services/ws_transport.dart';

/// 内存版 WsTransport：测试中代替真实 WebSocket。
///
/// - `pumpFromDesktop(event, data)`：模拟从桌面收到的事件
/// - `sentMessages`：手机经此 transport 发出的所有消息（按顺序）
/// - `setState(...)` / `setSelectedDesktop(...)`：模拟连接/桌面选择变化
class FakeWsTransport implements WsTransport {
  FakeWsTransport({
    WsConnectionState initialState = WsConnectionState.connected,
    String? selectedDesktopId = 'desktop-fake',
  })  : _state = initialState,
        _selectedDesktopId = selectedDesktopId {
    // 立即把初始值推一次，以模拟实际 ConnectionManager 的"启动 emit"行为。
    Future.microtask(() {
      if (!_stateController.isClosed) _stateController.add(_state);
      if (!_desktopController.isClosed) {
        _desktopController.add(_selectedDesktopId);
      }
    });
  }

  final _incomingController = StreamController<WsMessage>.broadcast();
  final _stateController = StreamController<WsConnectionState>.broadcast();
  final _desktopController = StreamController<String?>.broadcast();

  WsConnectionState _state;
  String? _selectedDesktopId;

  /// 桌面 → 手机的事件，按 `pumpFromDesktop` 调用顺序排队。
  @override
  Stream<WsMessage> get incoming => _incomingController.stream;

  @override
  Stream<WsConnectionState> get stateStream => _stateController.stream;

  @override
  WsConnectionState get state => _state;

  @override
  String? get selectedDesktopId => _selectedDesktopId;

  @override
  Stream<String?> get selectedDesktopIdStream => _desktopController.stream;

  /// 手机 → 桌面发出的所有消息（含 priority），顺序保留。
  final List<({WsMessage message, int priority})> sentMessages = [];

  @override
  void send(WsMessage message, {int priority = 0}) {
    sentMessages.add((message: message, priority: priority));
  }

  /// 测试 API：模拟桌面侧推送一条 WS 事件给手机。
  void pumpFromDesktop(String event, Map<String, dynamic> data) {
    _incomingController.add(WsMessage(event: event, data: data));
  }

  /// 测试 API：模拟连接状态变化。
  void setState(WsConnectionState newState) {
    _state = newState;
    _stateController.add(newState);
  }

  /// 测试 API：模拟用户切换/解绑桌面目标。
  void setSelectedDesktop(String? id) {
    _selectedDesktopId = id;
    _desktopController.add(id);
  }

  /// 清空发送记录，便于在某一段操作后单独断言。
  void clearSent() => sentMessages.clear();

  Future<void> dispose() async {
    await _incomingController.close();
    await _stateController.close();
    await _desktopController.close();
  }
}

/// 内存版 ChatDatabase：完全模拟 sqflite 行为但只用 List/Map 存储。
///
/// 注意：这里只覆盖 [ChatStore] 与 [SessionSyncService] 实际调用的方法子集。
/// 若被测代码新增依赖的方法，请在此补充 override。
class FakeChatDatabase extends ChatDatabase {
  FakeChatDatabase() : super.forTest();

  /// 全局自增主键，模拟 sqflite 的 AUTOINCREMENT。
  int _nextMessageId = 1;

  /// 所有消息（无论是否绑定 session）。
  final List<_StoredMessage> _messages = [];

  /// 所有会话元信息：sessionId → SessionMeta。
  final Map<String, SessionMeta> _sessions = {};

  // ---- Message CRUD ----

  @override
  Future<void> insertMessage(
    ChatMessage msg, {
    String? sessionId,
    String? desktopId,
  }) async {
    _messages.add(_StoredMessage(
      id: _nextMessageId++,
      sessionId: sessionId,
      desktopId: desktopId,
      message: msg,
    ),);
  }

  @override
  Future<List<ChatMessage>> getMessages({
    String? desktopId,
    int limit = 100,
    int offset = 0,
  }) async {
    final filtered = _messages
        .where((m) =>
            m.sessionId == null &&
            (desktopId == null || m.desktopId == desktopId),)
        .toList()
      ..sort((a, b) =>
          a.message.createdAt.compareTo(b.message.createdAt),);
    final sliced = filtered.skip(offset).take(limit).toList();
    return sliced.map((m) => m.message.copyWith(id: m.id)).toList();
  }

  @override
  Future<int> getMessageCount() async =>
      _messages.where((m) => m.sessionId == null).length;

  @override
  Future<void> clearAll() async {
    _messages.clear();
    _sessions.clear();
  }

  @override
  Future<void> updateMessage(ChatMessage msg) async {
    if (msg.id == null) return;
    final idx = _messages.indexWhere((m) => m.id == msg.id);
    if (idx >= 0) {
      _messages[idx] = _messages[idx].copyWithMessage(msg);
    }
  }

  @override
  Future<void> deleteMessage(int id) async {
    _messages.removeWhere((m) => m.id == id);
  }

  // ---- Session CRUD ----

  @override
  Future<void> upsertSession(SessionMeta session) async {
    _sessions[session.id] = session;
  }

  @override
  Future<void> upsertSessions(List<SessionMeta> sessions) async {
    for (final s in sessions) {
      _sessions[s.id] = s;
    }
  }

  @override
  Future<List<SessionMeta>> getSessions({String? workspacePath}) async {
    final values = _sessions.values
        .where((s) =>
            workspacePath == null || s.workspacePath == workspacePath,)
        .toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return values;
  }

  @override
  Future<void> deleteSessionAndMessages(String sessionId) async {
    _messages.removeWhere((m) => m.sessionId == sessionId);
    _sessions.remove(sessionId);
  }

  @override
  Future<void> clearSessionMessages(String sessionId) async {
    _messages.removeWhere((m) => m.sessionId == sessionId);
    final cur = _sessions[sessionId];
    if (cur != null) {
      _sessions[sessionId] = cur.copyWith(isSynced: false);
    }
  }

  // ---- Session-scoped queries ----

  @override
  Future<List<ChatMessage>> getSessionMessages(
    String sessionId, {
    int limit = 100,
    int offset = 0,
  }) async {
    final filtered = _messages.where((m) => m.sessionId == sessionId).toList()
      ..sort((a, b) =>
          a.message.createdAt.compareTo(b.message.createdAt),);
    final sliced = filtered.skip(offset).take(limit).toList();
    return sliced.map((m) => m.message.copyWith(id: m.id)).toList();
  }

  @override
  Future<void> insertSessionMessage(String sessionId, ChatMessage msg) async {
    _messages.add(_StoredMessage(
      id: _nextMessageId++,
      sessionId: sessionId,
      desktopId: null,
      message: msg,
    ),);
  }

  @override
  Future<void> insertSessionMessages(
    String sessionId,
    List<ChatMessage> messages,
  ) async {
    for (final msg in messages) {
      _messages.add(_StoredMessage(
        id: _nextMessageId++,
        sessionId: sessionId,
        desktopId: null,
        message: msg,
      ),);
    }
  }

  @override
  Future<int> getSessionMessageCount(String sessionId) async =>
      _messages.where((m) => m.sessionId == sessionId).length;

  @override
  Future<void> markSessionSynced(String sessionId) async {
    final cur = _sessions[sessionId];
    if (cur != null) {
      _sessions[sessionId] = cur.copyWith(isSynced: true);
    }
  }

  @override
  Future<void> markSessionUnsynced(String sessionId) async {
    final cur = _sessions[sessionId];
    if (cur != null) {
      _sessions[sessionId] = cur.copyWith(isSynced: false);
    }
  }
}

class _StoredMessage {
  _StoredMessage({
    required this.id,
    required this.sessionId,
    required this.desktopId,
    required this.message,
  });

  final int id;
  final String? sessionId;
  final String? desktopId;
  final ChatMessage message;

  _StoredMessage copyWithMessage(ChatMessage newMsg) => _StoredMessage(
        id: id,
        sessionId: sessionId,
        desktopId: desktopId,
        message: newMsg,
      );
}

/// 一次性装配：FakeWsTransport + FakeChatDatabase + 全新（非单例）的
/// [ChatStore] / [SessionSyncService] 实例。
///
/// 注意：[SessionSyncService] 内部直接调用 `ChatStore.instance` 而非注入实例，
/// 因此 ChatStore 仍以单例形式暴露给 SessionSyncService；harness 通过
/// `ChatStore.forTest()` 创建额外的可注入实例供"独立 ChatStore 行为"用例使用。
class SyncTestHarness {
  SyncTestHarness._({
    required this.transport,
    required this.db,
    required this.chatStore,
    required this.sessionSync,
  });

  factory SyncTestHarness.fresh() {
    // 让 AppRestoreState 等组件使用空内存版的 SharedPreferences。
    SharedPreferences.setMockInitialValues({});

    final transport = FakeWsTransport();
    final db = FakeChatDatabase();
    ChatDatabase.setInstanceForTest(db);

    final chatStore = ChatStore.forTest(transport: transport);
    // 关键：SessionSyncService 内部调用 `ChatStore.instance`，必须让其指向我们注入的实例
    ChatStore.setInstanceForTest(chatStore);

    final sessionSync = SessionSyncService.forTest(transport: transport);
    return SyncTestHarness._(
      transport: transport,
      db: db,
      chatStore: chatStore,
      sessionSync: sessionSync,
    );
  }

  final FakeWsTransport transport;
  final FakeChatDatabase db;
  final ChatStore chatStore;
  final SessionSyncService sessionSync;

  /// 等待事件循环跑完所有挂起的 microtask（以便订阅链路触发完毕）。
  Future<void> settle() async {
    // 多次让出 microtask，覆盖 unawaited(Future(() async { await ... await ... }))
    // 这种链式等待形态。
    for (var i = 0; i < 8; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<void> dispose() async {
    await transport.dispose();
    ChatDatabase.resetInstanceForTest();
    ChatStore.resetInstanceForTest();
  }
}
