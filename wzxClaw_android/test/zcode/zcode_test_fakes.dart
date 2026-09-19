// ============================================================
// zcode_test_fakes — zcode 测试公共夹具
//
// 从 zcode_chat_store_test.dart 抽出，供 store 单测与
// 换芯后的页面级 widget 测试共用（构造注入 + 假服务端）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';

import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_session_cache.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

/// 合法 hash：43 字符 base64 + '='
final String fakeHash = '${'A' * 43}=';

/// 合法配对 URL
String get pairingUrl =>
    'https://zcode.5945.top/pair?sid=device-sid-1&hash=$fakeHash';

/// relay 客户端替身：同公共 API，request 走注册的 handler
class FakeZcodeRelayClient implements ZcodeRelayClient {
  FakeZcodeRelayClient({this.initiallyPaired = true});

  /// 是否模拟已配对
  bool initiallyPaired;

  bool closed = false;
  int connectCount = 0;

  @override
  bool get paired => initiallyPaired && !closed;

  @override
  ZcodeRelayState get currentState =>
      closed ? ZcodeRelayState.closed : ZcodeRelayState.matched;

  /// 请求记录（method, params）
  final List<MapEntry<String, Map<String, dynamic>?>> requests = [];

  /// method → 响应产生器（返回值即 request 的 result；抛错即请求失败）
  final Map<String, dynamic Function(Map<String, dynamic>?)> handlers = {};

  @override
  void connect() => connectCount++;

  @override
  void close() => closed = true;

  @override
  Future<dynamic> request(
    String method, [
    Map<String, dynamic>? params,
  ]) async {
    requests.add(MapEntry(method, params));
    final handler = handlers[method];
    if (handler == null) throw Exception('测试未注册 $method 的处理器');
    return handler(params);
  }

  /// 契约后续新增成员的兜底（测试不触达）
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// 通知器替身：记录 showTaskDone / showReverseRequest 调用
class FakeZcodeNotifier extends ZcodeNotifier {
  final List<Map<String, dynamic>> shown = [];
  final List<Map<String, dynamic>> reverseRequests = [];

  @override
  void showTaskDone({
    required String status,
    int? tokens,
    String? sessionId,
    String? desktopId,
    String? desktopName,
  }) {
    shown.add({'status': status, 'tokens': tokens, 'sessionId': sessionId});
  }

  @override
  void showReverseRequest({required bool isAskUser, String? summary}) {
    reverseRequests.add({'isAskUser': isAskUser, 'summary': summary});
  }
}

/// 构造 app-server 消息（info + parts）
Map<String, dynamic> fakeMsg(
  String role,
  List<Map<String, dynamic>> parts, {
  String? id,
  int created = 0,
  String? modelId,
}) {
  return {
    'info': {
      'role': role,
      if (id != null) 'id': id,
      'time': {'created': created},
      if (modelId != null) 'modelID': modelId,
    },
    'parts': parts,
  };
}

/// 构造已配对的 store（注入替身）。cache 默认内存缓存替身：
/// store / widget 测试都不应触碰真 SQLite（缺插件环境只会吞错），
/// 需要回放持久化行为的用例自行构造 FakeZcodeSessionCache 传入。
ZcodeChatStore pairedStore(
  FakeZcodeRelayClient fake, {
  ZcodeSessionCache? cache,
}) {
  final store = ZcodeChatStore(
    cache: cache ?? FakeZcodeSessionCache(),
  );
  store.attach(
    fake,
    desktopId: 'device-sid-1',
    desktopName: '测试桌面',
  );
  return store;
}

/// 给 fake 注册空会话 resume（idle + 无消息）
void stubResumeEmpty(FakeZcodeRelayClient fake) {
  fake.handlers['session/resume'] = (_) => {
        'projection': {'status': 'idle'},
        'messages': [],
      };
}

/// 状态化 app-server 会话替身（多会话）：维护服务端消息列表，
/// messages 按 afterMessageId 增量返回（真实分页语义）
class FakeServerSession {
  FakeServerSession(this.id);

  final String id;
  String status = 'idle';
  int subscribeCalls = 0;
  int closeCalls = 0;
  final List<Map<String, dynamic>> messages = [];

  /// send 落库 user 消息（返回分配的消息 id）
  String addSend(Map<String, dynamic>? params) {
    final id = 'srv-u-${messages.length}';
    messages.add(
      fakeMsg(
        'user',
        [
          {'type': 'text', 'text': params?['content']?.toString() ?? ''},
        ],
        id: id,
        created: 100 + messages.length,
      ),
    );
    return id;
  }

  List<Map<String, dynamic>> messagesAfter(String? afterId) {
    if (afterId == null) return List.of(messages);
    final idx = messages.indexWhere((m) => m['info']['id'] == afterId);
    return idx < 0 ? List.of(messages) : messages.sublist(idx + 1);
  }
}

/// 状态化 app-server 替身：把 resume/subscribe/read/messages/send/list
/// 注册到 fake 客户端（按 params.sessionId 分发到各会话）
class FakeSessionServer {
  final Map<String, FakeServerSession> sessions = {};

  FakeServerSession session(String id) =>
      sessions.putIfAbsent(id, () => FakeServerSession(id));

  void bind(FakeZcodeRelayClient fake) {
    fake.handlers['session/resume'] = (params) {
      final s = session(params!['sessionId'] as String);
      return {
        'projection': {'status': s.status},
        // 新路径应忽略 resume 的 messages 数组（实测全量可达 26MB）
        'messages': List.of(s.messages),
        'session': {'sessionId': s.id},
      };
    };
    fake.handlers['session/subscribe'] = (params) {
      final s = session(params!['sessionId'] as String);
      s.subscribeCalls++;
      return {'eventSeq': 0, 'events': [], 'sessionId': s.id};
    };
    fake.handlers['session/read'] = (params) {
      final s = session(params!['sessionId'] as String);
      return {
        'projection': {'status': s.status},
      };
    };
    fake.handlers['session/messages'] = (params) {
      final s = session(params!['sessionId'] as String);
      var rows = s.messagesAfter(params['afterMessageId'] as String?);
      // 实测分页契约（APP-SERVER.md「分页契约实测」）：{limit} 返回最新
      // N 条且升序——替身照此截尾，让依赖该语义的回归在此暴露
      final limit = params['limit'];
      if (limit is int && limit > 0 && rows.length > limit) {
        rows = rows.sublist(rows.length - limit);
      }
      return {'messages': rows};
    };
    fake.handlers['session/send'] = (params) {
      session(params!['sessionId'] as String).addSend(params);
      return {'accepted': true};
    };
    fake.handlers['session/close'] = (params) {
      final s = session(params!['sessionId'] as String);
      s.status = 'idle';
      s.closeCalls++;
      // 实测形状（APP-SERVER.md）：{closed:true}；close ≠ delete
      return {'closed': true};
    };
    fake.handlers['session/list'] = (_) => {'sessions': []};
  }
}

/// 缓存替身：内存实现（与真实实现同 API 语义）
class FakeZcodeSessionCache extends ZcodeSessionCache {
  FakeZcodeSessionCache() : super.forTest();

  final Map<String, List<ZcodeSessionItem>> messages = {};
  final Map<String, ZcodeSessionCursor> cursors = {};
  int upsertCalls = 0;
  int clearAllCalls = 0;

  @override
  Future<void> upsertMessages(
    String sessionId,
    Iterable<ZcodeSessionItem> items,
  ) async {
    upsertCalls++;
    final list = messages.putIfAbsent(sessionId, () => <ZcodeSessionItem>[]);
    for (final it in items) {
      // 与真实缓存同契约：实时占位即使已有 assistantMessageId 也不落盘
      if (it.protoId == null || !it.synced) continue;
      final i = list.indexWhere((e) => e.protoId == it.protoId);
      if (i >= 0) {
        list[i] = it;
      } else {
        list.add(it);
      }
    }
  }

  @override
  Future<List<ZcodeSessionItem>> loadTail(
    String sessionId, {
    int limit = 80,
  }) async {
    final list = messages[sessionId];
    if (list == null) return const <ZcodeSessionItem>[];
    if (list.length <= limit) return List.of(list);
    return List.of(list.sublist(list.length - limit));
  }

  @override
  Future<ZcodeSessionCursor?> loadCursor(String sessionId) async =>
      cursors[sessionId];

  @override
  Future<void> saveCursor(
    String sessionId, {
    required int lastSeq,
    String? watermark,
  }) async {
    cursors[sessionId] =
        ZcodeSessionCursor(lastSeq: lastSeq, watermark: watermark);
  }

  @override
  Future<void> deleteSession(String sessionId) async {
    messages.remove(sessionId);
    cursors.remove(sessionId);
  }

  @override
  Future<void> clearAll() async {
    clearAllCalls++;
    messages.clear();
    cursors.clear();
  }
}

/// 注入一条 session/event 推送帧（等价 relay 推送到客户端 onNotify）
void pushEvent(
  ZcodeChatStore store, {
  required String sessionId,
  required String type,
  required int seq,
  Map<String, dynamic> payload = const {},
  String? turnId,
}) {
  store.debugHandleNotify(
    ZcodeFrame(
      method: 'session/event',
      params: {
        'deliveryKind': 'web-remote-replayable',
        'eventId': 'ev-$sessionId-$seq',
        'seq': seq,
        'sessionId': sessionId,
        if (turnId != null) 'turnId': turnId,
        'type': type,
        'payload': payload,
      },
    ),
  );
}
