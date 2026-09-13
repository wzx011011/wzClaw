// ============================================================
// zcode_chat_store_test — 状态层单元测试
//
// 用 FakeZcodeRelayClient（implements 公共 API）+ FakeZcodeNotifier
// 通过构造注入驱动；通知帧 / 反向请求用 @visibleForTesting 钩子注入。
//
// P1.2 同步层重构用例：推送渲染（subscribe + model.streaming +
// turn.completed 本地收尾）、工具回合增量权威刷新、epoch 乱串杜绝
// （A 流式中途切 B）、断线重订阅补放去重、SQLite 缓存重建恢复、
// 多会话并发（后台收尾）、模型不可用 setModel 兜底、resume messages
// 数组忽略。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/services/chat_store.dart'
    show AskUserQuestion, PermissionRequest;
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_pairing.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_session_cache.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

/// 合法 hash：43 字符 base64 + '='
final String _fakeHash = '${'A' * 43}=';

/// 合法配对 URL
String get _pairingUrl =>
    'https://zcode.5945.top/pair?sid=device-sid-1&hash=$_fakeHash';

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
  Future<dynamic> request(String method, [Map<String, dynamic>? params]) async {
    requests.add(MapEntry(method, params));
    final handler = handlers[method];
    if (handler == null) throw Exception('测试未注册 $method 的处理器');
    return handler(params);
  }

  /// 契约后续新增成员的兜底（测试不触达）
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// 通知器替身：记录 showTaskDone 调用
class FakeZcodeNotifier extends ZcodeNotifier {
  final List<Map<String, dynamic>> shown = [];

  @override
  void showTaskDone({
    required String status,
    int? tokens,
    String? sessionId,
  }) {
    shown.add({'status': status, 'tokens': tokens, 'sessionId': sessionId});
  }
}

/// 构造 app-server 消息（info + parts）
Map<String, dynamic> _msg(
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

/// 构造已配对的 store（注入替身）
ZcodeChatStore _pairedStore(FakeZcodeRelayClient fake) {
  final store = ZcodeChatStore(client: fake);
  expect(store.pair(_pairingUrl), isTrue);
  return store;
}

/// 给 fake 注册空会话 resume（idle + 无消息）
void _stubResumeEmpty(FakeZcodeRelayClient fake) {
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
  final List<Map<String, dynamic>> messages = [];

  /// send 落库 user 消息（返回分配的消息 id）
  String addSend(Map<String, dynamic>? params) {
    final id = 'srv-u-${messages.length}';
    messages.add(_msg('user', [
      {'type': 'text', 'text': params?['content']?.toString() ?? ''},
    ], id: id, created: 100 + messages.length,),);
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
      return {
        'messages': s.messagesAfter(params['afterMessageId'] as String?),
      };
    };
    fake.handlers['session/send'] = (params) {
      session(params!['sessionId'] as String).addSend(params);
      return {'accepted': true};
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

  @override
  Future<void> upsertMessages(
      String sessionId, Iterable<ZcodeSessionItem> items,) async {
    upsertCalls++;
    final list = messages.putIfAbsent(sessionId, () => <ZcodeSessionItem>[]);
    for (final it in items) {
      if (it.protoId == null) continue;
      final i = list.indexWhere((e) => e.protoId == it.protoId);
      if (i >= 0) {
        list[i] = it;
      } else {
        list.add(it);
      }
    }
  }

  @override
  Future<List<ZcodeSessionItem>> loadTail(String sessionId,
      {int limit = 80,}) async {
    final list = messages[sessionId];
    if (list == null) return const <ZcodeSessionItem>[];
    if (list.length <= limit) return List.of(list);
    return List.of(list.sublist(list.length - limit));
  }

  @override
  Future<ZcodeSessionCursor?> loadCursor(String sessionId) async =>
      cursors[sessionId];

  @override
  Future<void> saveCursor(String sessionId,
      {required int lastSeq, String? watermark,}) async {
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
    messages.clear();
    cursors.clear();
  }
}

/// 注入一条 session/event 推送帧（等价 relay 推送到客户端 onNotify）
void _pushEvent(
  ZcodeChatStore store, {
  required String sessionId,
  required String type,
  required int seq,
  Map<String, dynamic> payload = const {},
  String? turnId,
}) {
  store.debugHandleNotify(ZcodeFrame(
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
  ),);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  tearDown(() {
    ZcodeNotifier.resetInstanceForTest();
  });

  group('配对', () {
    test('pair：解析失败返回 false 并设置 error', () {
      final fake = FakeZcodeRelayClient();
      final store = ZcodeChatStore(client: fake);

      expect(store.pair('https://zcode.5945.top/pair?sid=x&hash=bad'), isFalse);
      expect(store.pair('not a url'), isFalse);
      expect(store.error, isNotNull);
      expect(store.pairing, isNull);
      expect(store.connState, ZcodeConnState.idle);
    });

    test('pair：成功解析、连接并持久化', () async {
      final fake = FakeZcodeRelayClient();
      final store = ZcodeChatStore(client: fake);

      expect(store.pair(_pairingUrl), isTrue);
      expect(store.pairing?.sid, 'device-sid-1');
      expect(store.pairing?.relayWsUrl, 'wss://zcode.5945.top/ws');
      expect(store.error, isNull);
      expect(store.connState, ZcodeConnState.matched);
      expect(fake.connectCount, 1);

      // 异步落盘
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString('wzxclaw-zcode-pairing');
      expect(saved, isNotNull);
      final info =
          ZcodePairingInfo.fromJson(jsonDecode(saved!) as Map<String, dynamic>);
      expect(info?.sid, 'device-sid-1');
    });

    test('restore：读取持久化并恢复连接 + 拉会话列表', () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'wzxclaw-zcode-pairing',
        jsonEncode({
          'relayWsUrl': 'wss://zcode.5945.top/ws',
          'sid': 'sid-9',
          'hash': _fakeHash,
        }),
      );
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {'sessions': []};
      final store = ZcodeChatStore(client: fake);

      await store.restore();
      expect(store.pairing?.sid, 'sid-9');
      expect(store.connState, ZcodeConnState.matched);
      expect(fake.requests.map((e) => e.key), contains('session/list'));
    });

    test('unpair：断开客户端、清状态与持久化', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);
      await Future<void>.delayed(Duration.zero);

      store.unpair();
      expect(store.pairing, isNull);
      expect(fake.closed, isTrue);
      expect(store.sessions, isEmpty);
      expect(store.activeSessionId, isNull);
      expect(store.isStreaming, isFalse);

      await Future<void>.delayed(Duration.zero);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('wzxclaw-zcode-pairing'), isNull);
    });
  });

  group('会话', () {
    test('openSession：resume parts → ChatMessage 映射（tool 状态 + 截断提示）', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'session': {
              'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
            },
            'projection': {'status': 'idle'},
            'messagesTruncated': true,
            'messages': [
              _msg('user', [
                {'type': 'text', 'text': '你好'},
              ], id: 'm1', created: 1000,),
              _msg('assistant', [
                {'type': 'text', 'text': '回答'},
                {'type': 'reasoning', 'text': '思考过程'},
                {'type': 'tool', 'callId': 'tc-running', 'state': 'running', 'tool': {'name': 'FileRead'}},
                {'type': 'tool', 'callId': 'tc-done', 'state': 'completed', 'tool': {'name': 'ShellExecute'}},
                {'type': 'tool', 'callId': 'tc-failed', 'state': 'failed', 'tool': 'Echo'},
              ], id: 'm2', created: 2000, modelId: 'glm-5.3',),
              _msg('assistant', [], id: 'm3'), // 空 assistant → 过滤
            ],
          };
      final store = _pairedStore(fake);

      await store.openSession('sess-1');
      expect(store.activeSessionId, 'sess-1');
      expect(store.messages.length, 3); // 截断提示 + user + assistant

      // 头部截断提示
      expect(store.messages.first.role, MessageRole.assistant);
      expect(store.messages.first.content, contains('已截断'));

      // user 消息
      expect(store.messages[1].role, MessageRole.user);
      expect(store.messages[1].content, '你好');

      // assistant 消息：content 拼接 + toolCalls 状态映射
      final a = store.messages[2];
      expect(a.content, '回答');
      expect(a.model, 'glm-5.3');
      final calls = a.toolCalls!;
      expect(calls.length, 3);
      expect(calls[0].toolName, 'FileRead');
      expect(calls[0].status, ToolCallStatus.running);
      expect(calls[1].toolName, 'ShellExecute');
      expect(calls[1].status, ToolCallStatus.done);
      expect(calls[2].toolName, 'Echo'); // tool 为字符串的形态
      expect(calls[2].status, ToolCallStatus.error);
      expect(calls[2].isError, isTrue);

      expect(store.isStreaming, isFalse);
      final resume = fake.requests.firstWhere((e) => e.key == 'session/resume');
      expect(resume.value, {'sessionId': 'sess-1'});
    });

    test('openSession：projection running → isStreaming 并启动轮询', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'running'},
            'messages': [],
          };
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = _pairedStore(fake);

      await store.openSession('sess-r');
      expect(store.isStreaming, isTrue);

      // 清理轮询计时器
      store.closeSessionView();
      expect(store.activeSessionId, isNull);
      expect(store.isStreaming, isFalse);
    });
  });

  group('聊天', () {
    test('sendMessage：本地 user 消息 + 流式 assistant 占位 + 请求参数', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = _pairedStore(fake);
      await store.openSession('sess-1');

      await store.sendMessage('你好，帮我看看');
      final msgs = store.messages;
      expect(msgs.length, 2);
      expect(msgs[0].role, MessageRole.user);
      expect(msgs[0].content, '你好，帮我看看');
      expect(msgs[1].role, MessageRole.assistant);
      expect(msgs[1].isStreaming, isTrue);
      expect(store.isStreaming, isTrue);
      expect(store.isWaitingForResponse, isTrue);
      expect(store.error, isNull);

      final send = fake.requests.firstWhere((e) => e.key == 'session/send');
      expect(send.value, {'sessionId': 'sess-1', 'content': '你好，帮我看看'});

      store.unpair(); // 清理轮询计时器
    });

    test('sendMessage：请求异常 → error 状态且不启动轮询', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) =>
          throw const ZcodeRequestException(-32004, 'Session is not active');
      final store = _pairedStore(fake);
      await store.openSession('sess-1');

      await store.sendMessage('hi');
      expect(store.error, contains('发送失败'));
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);
      // 占位被终结（isStreaming=false）
      expect(store.messages.last.isStreaming, isFalse);
      // 未启动轮询：没有 session/events 请求
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);
    });

    test('流式轮询：text_delta/reasoning_delta 追加，按 eventId 去重', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e1',
                'payload': {'kind': 'reasoning_delta', 'delta': '想想'},
              },
              {
                'eventId': 'e2',
                'payload': {'kind': 'text_delta', 'delta': 'Hel'},
              },
            ],
          };
      final store = _pairedStore(fake);
      await store.openSession('sess-s');

      await store.sendMessage('hi');
      // sendMessage 成功后的首个 tick 立即应用
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.content, 'Hel');
      expect(store.messages.last.isStreaming, isTrue);
      expect(store.thinkingContent, '想想');
      expect(store.isWaitingForResponse, isFalse); // 首个增量已到达

      // 第二拍：重复的 e2 应被去重，新增 e3 追加
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e2',
                'payload': {'kind': 'text_delta', 'delta': 'Hel'},
              },
              {
                'eventId': 'e3',
                'payload': {'kind': 'text_delta', 'delta': 'lo'},
              },
            ],
          };
      await store.debugPollOnce();
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.content, 'Hello'); // 'Hel' 只计一次 + 'lo'

      store.unpair(); // 清理轮询计时器
    });

    test('state.updated：running/idle 切换 isStreaming', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-1');

      store.debugHandleNotify(const ZcodeFrame(
        method: 'state.updated',
        params: {'patch': {'status': 'running'}},
      ),);
      expect(store.isStreaming, isTrue);

      store.debugHandleNotify(const ZcodeFrame(
        method: 'state.updated',
        params: {'patch': {'status': 'idle'}},
      ),);
      expect(store.isStreaming, isFalse);
    });

    test('turn.terminal：停轮询 + 任务完成通知 + 权威刷新（含工具结果）', () async {
      final fake = FakeZcodeRelayClient();
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      _stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e1',
                'payload': {'kind': 'text_delta', 'delta': '部分回答'},
              },
            ],
          };
      final store = _pairedStore(fake);
      await store.openSession('sess-t');
      await store.sendMessage('go');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.content, '部分回答');

      // token 用量通知
      store.debugHandleNotify(const ZcodeFrame(
        method: 'v4/telemetry/event',
        params: {'kind': 'usage.delta', 'inputTokens': 12, 'outputTokens': 34},
      ),);

      // 权威消息（含工具调用结果，只有权威列表才有）
      fake.handlers['session/messages'] = (_) => {
            'messages': [
              _msg('user', [
                {'type': 'text', 'text': 'go'},
              ], id: 'a1', created: 1,),
              _msg('assistant', [
                {'type': 'text', 'text': '最终回答'},
                {'type': 'tool', 'callId': 'tc9', 'state': 'completed', 'tool': {'name': 'FileWrite'}, 'output': '写入 3 行'},
              ], id: 'a2', created: 2,),
            ],
          };

      store.debugHandleNotify(const ZcodeFrame(
        method: 'v4/telemetry/event',
        params: {'kind': 'turn.terminal', 'status': 'success', 'tokenCount': 34},
      ),);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 通知回调
      expect(notifier.shown.length, 1);
      expect(notifier.shown.first['status'], 'success');
      expect(notifier.shown.first['tokens'], 34);
      expect(notifier.shown.first['sessionId'], 'sess-t');

      // 权威刷新重建消息
      expect(store.messages.length, 2);
      expect(store.messages.last.content, '最终回答');
      final tc = store.messages.last.toolCalls!.single;
      expect(tc.toolCallId, 'tc9');
      expect(tc.toolName, 'FileWrite');
      expect(tc.status, ToolCallStatus.done);
      expect(tc.outputSummary, '写入 3 行');
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);

      // turn.terminal 已停轮询：不再产生 session/events 请求
      final eventsCount =
          fake.requests.where((e) => e.key == 'session/events').length;
      expect(eventsCount, greaterThanOrEqualTo(1));
      await Future<void>.delayed(Duration.zero);
      expect(fake.requests.where((e) => e.key == 'session/events').length,
          eventsCount,);
    });

    test('stopGeneration：session/stop + 增量权威刷新', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      fake.handlers['session/events'] = (_) => {'events': []};
      // 状态化服务端：send 落库新消息；messages 按 afterMessageId 增量返回
      final serverMessages = <Map<String, dynamic>>[
        _msg('user', [
          {'type': 'text', 'text': '旧问题'},
        ], id: 'b0', created: 1,),
        _msg('assistant', [
          {'type': 'text', 'text': '旧回答'},
        ], id: 'b1', created: 2,),
      ];
      fake.handlers['session/send'] = (_) {
        serverMessages.add(_msg('user', [
          {'type': 'text', 'text': 'go'},
        ], id: 'u1', created: 3,),);
        return {'accepted': true};
      };
      fake.handlers['session/stop'] = (_) {
        // 停止时服务端持久化被中止的 assistant 回复
        serverMessages.add(_msg('assistant', [
          {'type': 'text', 'text': '被中止的回答'},
        ], id: 'a1', created: 4,),);
        return {};
      };
      fake.handlers['session/messages'] = (params) {
        final after = params?['afterMessageId'] as String?;
        if (after == null) return {'messages': List.of(serverMessages)};
        final idx =
            serverMessages.indexWhere((m) => m['info']['id'] == after);
        return {
          'messages':
              idx < 0 ? List.of(serverMessages) : serverMessages.sublist(idx + 1),
        };
      };
      final store = _pairedStore(fake);
      await store.openSession('sess-stop');
      expect(store.messages.length, 2); // 打开时拉到最近窗口
      await store.sendMessage('go');

      await store.stopGeneration();
      expect(fake.requests.any((e) => e.key == 'session/stop'), isTrue);
      final stop = fake.requests.firstWhere((e) => e.key == 'session/stop');
      expect(stop.value, {'sessionId': 'sess-stop'});
      // 增量刷新只拉新增（afterMessageId = b1），乐观 user 消息被原位消解
      final refresh = fake.requests
          .lastWhere((e) => e.key == 'session/messages')
          .value;
      expect(refresh!['afterMessageId'], 'b1');
      expect(store.messages.length, 4); // 旧窗口 2 条 + 本回合 2 条
      expect(store.messages.where((m) => m.content == 'go'), hasLength(1));
      expect(store.messages.last.content, '被中止的回答');
      expect(store.isStreaming, isFalse);
    });
  });

  group('newSession', () {
    test('复用 sessions 里第一个有 workspace 的条目并打开新会话', () async {
      final fake = FakeZcodeRelayClient();
      final sessions = <Map<String, dynamic>>[
        {'sessionId': 's2', 'title': '', 'updatedAt': 9}, // 无 workspace → 跳过
        {
          'sessionId': 's1',
          'title': '最近的会话',
          'updatedAt': 5,
          'workspace': {'workspaceKey': 'wk1', 'workspacePath': 'E:/ai/wzxClaw'},
        },
      ];
      fake.handlers['session/list'] = (_) => {'sessions': sessions};
      fake.handlers['session/create'] = (_) {
        sessions.insert(0, {
          'sessionId': 's-new',
          'title': '新会话',
          'updatedAt': 99,
          'workspace': {'workspaceKey': 'wk1', 'workspacePath': 'E:/ai/wzxClaw'},
        });
        return {
          'session': {'sessionId': 's-new'},
        };
      };
      _stubResumeEmpty(fake);
      final store = _pairedStore(fake);

      await store.refreshSessions();
      expect(store.sessions.length, 2);
      expect(store.sessions.first.sessionId, 's2'); // 列表顺序保持
      expect(store.sessions[1].workspaceKey, 'wk1');
      expect(store.sessions[1].title, '最近的会话');

      await store.newSession();
      final create = fake.requests.firstWhere((e) => e.key == 'session/create');
      expect(create.value, {
        'workspace': {'workspaceKey': 'wk1', 'workspacePath': 'E:/ai/wzxClaw'},
      });
      expect(store.activeSessionId, 's-new');
      final resume = fake.requests.lastWhere((e) => e.key == 'session/resume');
      expect(resume.value, {'sessionId': 's-new'});
      // create 后刷新过列表：新会话出现在列表里
      expect(store.sessions.any((s) => s.sessionId == 's-new'), isTrue);
    });

    test('无可用工作区 → error 提示', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {
            'sessions': [
              {'sessionId': 's0', 'title': 'x', 'updatedAt': 1},
            ],
          };
      final store = _pairedStore(fake);

      await store.newSession();
      expect(store.error, contains('工作区'));
      expect(store.activeSessionId, isNull);
    });
  });

  group('权限确认 / AskUser（反向请求）', () {
    test('权限反向请求 → 流事件 + 应答回传结果（含 snake_case 兜底）', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);

      final events = <PermissionRequest?>[];
      final sub = store.permissionStream.listen(events.add);

      final future = store.debugHandleReverseRequest(const ZcodeFrame(
        id: 'server-1',
        method: 'session/requestPermission',
        params: {'toolCallId': 'tc-1', 'toolName': 'FileWrite', 'input': {'path': 'a.txt'}},
      ),);
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolCallId, 'tc-1');
      expect(store.activePermission?.toolName, 'FileWrite');
      expect(store.activePermission?.input, {'path': 'a.txt'});
      expect(events, hasLength(1));
      expect(events.first?.toolCallId, 'tc-1');

      // 应答：结果作为反向请求响应回传（客户端带原请求 id 发送）
      store.respondToPermission('tc-1', approved: true, remember: true);
      expect(await future, {
        'toolCallId': 'tc-1',
        'approved': true,
        'remember': true,
      });
      expect(store.activePermission, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(events, hasLength(2)); // 清空事件
      expect(events.last, isNull);

      // snake_case 字段兜底
      final future2 = store.debugHandleReverseRequest(const ZcodeFrame(
        id: 'server-2',
        method: 'session/requestPermission',
        params: {'tool_call_id': 'tc-2', 'tool_name': 'ShellExecute'},
      ),);
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolName, 'ShellExecute');
      store.respondToPermission('tc-2', approved: false);
      expect(await future2, {'toolCallId': 'tc-2', 'approved': false});

      // 重复应答（已清除）静默忽略
      store.respondToPermission('tc-2', approved: true);
      sub.cancel();
    });

    test('AskUser 反向请求 → 流事件 + 应答回传选项', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);

      final events = <AskUserQuestion?>[];
      final sub = store.askUserStream.listen(events.add);

      final future = store.debugHandleReverseRequest(const ZcodeFrame(
        id: 'server-3',
        method: 'interaction/askUser',
        params: {
          'questionId': 'q-1',
          'question': '选哪个？',
          'options': [
            {'label': 'A', 'description': '选项A'},
            {'label': 'B', 'description': '选项B'},
          ],
          'multiSelect': false,
        },
      ),);
      await Future<void>.delayed(Duration.zero);
      expect(store.activeAskUser?.questionId, 'q-1');
      expect(store.activeAskUser?.question, '选哪个？');
      expect(store.activeAskUser!.options.length, 2);
      expect(store.activeAskUser!.options.first['label'], 'A');
      expect(events, hasLength(1));

      store.respondToAskUser('q-1', ['A'], customText: '备注');
      expect(await future, {
        'questionId': 'q-1',
        'selectedLabels': ['A'],
        'customText': '备注',
      });
      expect(store.activeAskUser, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(events.last, isNull);
      sub.cancel();
    });

    test('解析失败 / 未知 method → 抛错（默认安全拒绝）', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);

      // method 含 interaction 但形状不符（缺 question/options）
      expect(
        () => store.debugHandleReverseRequest(const ZcodeFrame(
          id: 'server-4',
          method: 'interaction/prompt',
          params: {'foo': 1},
        ),),
        throwsA(isA<Exception>()),
      );
      // 权限请求缺关键字段
      expect(
        () => store.debugHandleReverseRequest(const ZcodeFrame(
          id: 'server-5',
          method: 'session/requestPermission',
          params: {'input': {}},
        ),),
        throwsA(isA<Exception>()),
      );
      // 完全未知的反向请求
      expect(
        () => store.debugHandleReverseRequest(const ZcodeFrame(
          id: 'server-6',
          method: 'workspace/open',
          params: {},
        ),),
        throwsA(isA<Exception>()),
      );
      expect(store.activePermission, isNull);
      expect(store.activeAskUser, isNull);
    });

    test('unpair：挂起的反向请求以 error 帧拒绝收尾（安全拒绝）', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);

      final future = store.debugHandleReverseRequest(const ZcodeFrame(
        id: 'server-7',
        method: 'session/requestPermission',
        params: {'toolCallId': 'tc-x', 'toolName': 'FileRead'},
      ),);
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission, isNotNull);

      // 先挂错误断言再触发拒绝，避免 unhandled async error
      final done = expectLater(
        future,
        throwsA(isA<ZcodeReverseRejectException>()),
      );
      store.unpair();
      await done;
      expect(store.activePermission, isNull);
    });
  });

  group('同步层重构（P1.2）', () {
    test('单例：无注入构造返回 app 作用域实例，注入构造全新实例', () {
      final a = ZcodeChatStore();
      final b = ZcodeChatStore();
      expect(a, same(ZcodeChatStore.instance));
      expect(b, same(a));
      final fake = FakeZcodeRelayClient();
      expect(
        ZcodeChatStore(client: fake),
        isNot(same(ZcodeChatStore.instance)),
      );
    });

    test('视口加载：忽略 resume 的 messages 数组，以 session/messages 尾窗为准', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // resume 响应携带陈旧消息（新路径应忽略），尾窗接口返回最新内容
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'idle'},
            'messages': [
              _msg('user', [
                {'type': 'text', 'text': '陈旧消息'},
              ], id: 'stale-1', created: 1,),
            ],
          };
      server.session('sess-v').messages.add(_msg('assistant', [
        {'type': 'text', 'text': '最新回答'},
      ], id: 'fresh-1', created: 2,),);
      final store = _pairedStore(fake);

      await store.openSession('sess-v');
      expect(store.messages.map((m) => m.content), isNot(contains('陈旧消息')));
      expect(store.messages.single.content, '最新回答');
    });

    test('推送渲染：model.streaming 增量直渲染；turn.completed 纯文本本地收尾免权威刷新', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = _pairedStore(fake);
      await store.openSession('sess-p');

      // 订阅在 materialize 时建立（web-remote-replayable）
      final sub = fake.requests.firstWhere((e) => e.key == 'session/subscribe');
      expect(sub.value, {
        'sessionId': 'sess-p',
        'deliveryKind': 'web-remote-replayable',
      });
      expect(server.session('sess-p').subscribeCalls, 1);

      await store.sendMessage('hi');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        _pushEvent(store,
            sessionId: 'sess-p',
            type: type,
            seq: seq,
            turnId: 'turn-1',
            payload: payload,);
      }

      push('turn.started', {'messageId': 'srv-u-x', 'input': 'hi'});
      // 乐观 user 消息被 turn.started 采纳 protoId，不重复
      expect(
        store.messages.where((m) => m.role == MessageRole.user),
        hasLength(1),
      );

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'Hel',
        'kind': 'text_delta',
        'done': false,
      });
      expect(store.messages.last.content, 'Hel');
      expect(store.messages.last.isStreaming, isTrue);

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'lo',
        'kind': 'text_delta',
        'done': false,
      });
      expect(store.messages.last.content, 'Hello');

      // model.response 权威全文重对（防增量丢失）
      push('model.response', {'content': 'Hello'});
      expect(store.messages.last.content, 'Hello');

      final messagesReqsBefore =
          fake.requests.where((e) => e.key == 'session/messages').length;
      push('turn.completed', {
        'response': 'Hello',
        'tokenCount': 42,
        'toolCallCount': 0,
        'resultType': 'success',
        'usage': {'inputTokens': 40, 'outputTokens': 2},
      });
      expect(store.messages.last.content, 'Hello');
      expect(store.messages.last.isStreaming, isFalse);
      expect(store.messages.last.usage?.outputTokens, 2);
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);
      // 纯文本回合免权威刷新：没有新增 session/messages 请求
      expect(
        fake.requests.where((e) => e.key == 'session/messages').length,
        messagesReqsBefore,
      );
      // 任务完成通知
      expect(notifier.shown.single['status'], 'success');
      expect(notifier.shown.single['tokens'], 42);
      expect(notifier.shown.single['sessionId'], 'sess-p');
      // 推送可用：全程无降级轮询
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);
    });

    test('工具回合：turn.completed(toolCallCount>0) 走增量权威刷新（afterMessageId 水位）', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // 预置历史形成水位
      server.session('sess-t').messages.add(_msg('user', [
        {'type': 'text', 'text': '旧问题'},
      ], id: 'h1', created: 1,),);
      final store = _pairedStore(fake);
      await store.openSession('sess-t');
      expect(store.messages, hasLength(1)); // 打开时拉到尾窗

      await store.sendMessage('写文件');
      _pushEvent(store,
          sessionId: 'sess-t',
          type: 'model.streaming',
          seq: 1,
          turnId: 'turn-t',
          payload: {
            'assistantMessageId': 'msg-a2',
            'delta': '正在写',
            'kind': 'text_delta',
          },);
      // 服务端回合落库（user 已由 send 落库；assistant 带工具结果）
      server.session('sess-t').messages.add(_msg('assistant', [
        {'type': 'text', 'text': '写完了'},
        {
          'type': 'tool',
          'callId': 'tc1',
          'state': 'completed',
          'tool': {'name': 'FileWrite'},
          'output': '写入 3 行',
        },
      ], id: 'msg-a2', created: 2,),);
      _pushEvent(store,
          sessionId: 'sess-t',
          type: 'turn.completed',
          seq: 2,
          turnId: 'turn-t',
          payload: {
            'response': '写完了',
            'toolCallCount': 1,
            'resultType': 'success',
          },);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 增量刷新：只拉新增（afterMessageId = 打开时的水位 h1）
      final refresh =
          fake.requests.lastWhere((e) => e.key == 'session/messages');
      expect(refresh.value!['afterMessageId'], 'h1');
      expect(store.messages, hasLength(3)); // 历史 + 本回合 user + assistant
      final last = store.messages.last;
      expect(last.content, '写完了');
      expect(last.toolCalls!.single.toolName, 'FileWrite');
      expect(last.toolCalls!.single.outputSummary, '写入 3 行');
      expect(store.isStreaming, isFalse);
      // 流式占位被权威版本原位消解（不重复出现"正在写"）
      expect(store.messages.where((m) => m.content == '正在写'), isEmpty);
    });

    test('乱串杜绝：会话 A 流式中途切到 B——A 增量零泄漏进 B，切回 A 完整', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-A');
      await store.sendMessage('A 任务');
      _pushEvent(store,
          sessionId: 'sess-A',
          type: 'model.streaming',
          seq: 1,
          turnId: 't-A',
          payload: {
            'assistantMessageId': 'msg-a',
            'delta': '部分A',
            'kind': 'text_delta',
          },);
      expect(store.messages.last.content, '部分A');

      // A 流式中途切到 B
      await store.openSession('sess-B');
      expect(store.activeSessionId, 'sess-B');
      // A 的增量继续到达（后台）：不得进入 B 视口
      _pushEvent(store,
          sessionId: 'sess-A',
          type: 'model.streaming',
          seq: 2,
          turnId: 't-A',
          payload: {
            'assistantMessageId': 'msg-a',
            'delta': '更多A',
            'kind': 'text_delta',
          },);
      _pushEvent(store,
          sessionId: 'sess-B',
          type: 'model.streaming',
          seq: 1,
          turnId: 't-B',
          payload: {
            'assistantMessageId': 'msg-b',
            'delta': 'B 内容',
            'kind': 'text_delta',
          },);
      final bContents = store.messages.map((m) => m.content).toList();
      expect(bContents, isNot(contains('部分A')));
      expect(bContents, isNot(contains('更多A')));
      expect(bContents.last, 'B 内容');
      expect(store.thinkingContent, isEmpty); // A 的回合状态不泄漏

      // 切回 A：内容完整（含后台到达的增量），回合仍在途
      await store.openSession('sess-A');
      expect(store.messages.last.content, '部分A更多A');
      expect(store.isStreaming, isTrue);
      // B 的后续增量不泄漏进 A
      _pushEvent(store,
          sessionId: 'sess-B',
          type: 'model.streaming',
          seq: 2,
          turnId: 't-B',
          payload: {
            'assistantMessageId': 'msg-b',
            'delta': '后续B',
            'kind': 'text_delta',
          },);
      expect(
        store.messages.map((m) => m.content),
        isNot(contains('后续B')),
      );
    });

    test('epoch 失效：在途 resume 失败不惊动当前视口', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final originalResume = fake.handlers['session/resume'];
      // sess-A 的 resume 挂起，稍后以失败收场
      final gate = Completer<void>();
      fake.handlers['session/resume'] = (params) async {
        if (params?['sessionId'] == 'sess-A') {
          await gate.future;
          throw const ZcodeRequestException(-32004, 'Session is not active');
        }
        return originalResume!(params);
      };
      final store = _pairedStore(fake);

      final openingA = store.openSession('sess-A'); // 不等待：A 的 resume 在途
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // A 在途期间切到 B（正常打开）
      await store.openSession('sess-B');
      expect(store.activeSessionId, 'sess-B');

      gate.complete(); // A 的 resume 现在失败
      await openingA;
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // 旧纪元的失败被丢弃：不踢出视口、不弹错误
      expect(store.activeSessionId, 'sess-B');
      expect(store.error, isNull);
      expect(store.messages, isEmpty);
    });

    test('断线补放：重连后重订阅 + 按 lastSeq 补齐去重', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-r');
      await store.sendMessage('hi');
      _pushEvent(store,
          sessionId: 'sess-r',
          type: 'model.streaming',
          seq: 1,
          turnId: 't-r',
          payload: {
            'assistantMessageId': 'msg-r',
            'delta': 'A',
            'kind': 'text_delta',
          },);
      _pushEvent(store,
          sessionId: 'sess-r',
          type: 'model.streaming',
          seq: 2,
          turnId: 't-r',
          payload: {
            'assistantMessageId': 'msg-r',
            'delta': 'B',
            'kind': 'text_delta',
          },);
      expect(store.messages.last.content, 'AB');

      // 断线期间 seq 3 发生在服务端；重连时补放混入已应用的 seq 2
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'ev-sess-r-2',
                'seq': 2,
                'sessionId': 'sess-r',
                'payload': {'kind': 'text_delta', 'delta': 'B'},
              },
              {
                'eventId': 'ev-sess-r-3',
                'seq': 3,
                'sessionId': 'sess-r',
                'payload': {'kind': 'text_delta', 'delta': 'C'},
              },
            ],
          };
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 重连后重订阅（订阅不因切走/断线移除）
      expect(
        fake.requests.where((e) => e.key == 'session/subscribe').length,
        greaterThanOrEqualTo(2),
      );
      // 补放请求带 lastSeq 水位
      final replay = fake.requests.lastWhere((e) => e.key == 'session/events');
      expect(replay.value!['afterSeq'], 2);
      // 重复的 seq 2 按 eventId 去重，只应用新的 seq 3
      expect(store.messages.last.content, 'ABC');
    });

    test('本地缓存：写入后重建 store 秒开（恢复消息与水位）', () async {
      final cache = FakeZcodeSessionCache();
      final fake1 = FakeZcodeRelayClient();
      final server1 = FakeSessionServer()..bind(fake1);
      server1.session('sess-c').messages.add(_msg('user', [
        {'type': 'text', 'text': '历史问题'},
      ], id: 'h1', created: 1,),);
      server1.session('sess-c').messages.add(_msg('assistant', [
        {'type': 'text', 'text': '历史回答'},
      ], id: 'h2', created: 2,),);
      final store1 = ZcodeChatStore(client: fake1, cache: cache);
      expect(store1.pair(_pairingUrl), isTrue);
      await store1.openSession('sess-c');
      expect(store1.messages, hasLength(2));
      await Future<void>.delayed(Duration.zero); // persistSession 为 unawaited
      await Future<void>.delayed(Duration.zero);
      expect(cache.messages['sess-c'], isNotEmpty);
      expect(cache.cursors['sess-c']?.watermark, 'h2');

      // 重建 store（模拟 App 重启）：缓存先出，水位恢复驱动增量刷新
      final fake2 = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake2); // 服务端视角该会话为空
      final store2 = ZcodeChatStore(client: fake2, cache: cache);
      expect(store2.pair(_pairingUrl), isTrue);
      await store2.openSession('sess-c');
      expect(store2.messages.map((m) => m.content), contains('历史回答'));
      expect(
        fake2.requests.any((e) =>
            e.key == 'session/messages' && e.value?['afterMessageId'] == 'h2',),
        isTrue,
      );
    });

    test('上滑翻页：从本地缓存加载更早消息', () async {
      final cache = FakeZcodeSessionCache();
      cache.messages['sess-o'] = [
        for (var i = 0; i < 120; i++)
          ZcodeSessionItem(
            protoId: 'h$i',
            message: ChatMessage(
              role: i % 2 == 0 ? MessageRole.user : MessageRole.assistant,
              content: '历史 $i',
              createdAt: DateTime.fromMillisecondsSinceEpoch(i),
            ),
          ),
      ];
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore(client: fake, cache: cache);
      expect(store.pair(_pairingUrl), isTrue);
      await store.openSession('sess-o');
      expect(store.messages, hasLength(80)); // 缓存尾窗

      final added = await store.loadOlderMessages(limit: 40);
      expect(added, 40);
      expect(store.messages, hasLength(120));
      expect(store.messages.first.content, '历史 0');
      expect(store.messages.last.content, '历史 119');
    });

    test('多会话并发：A 后台回合收尾（通知/徽标刷新），B 视口零扰动', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = _pairedStore(fake);
      await store.openSession('sess-A');
      await store.sendMessage('A 任务');
      _pushEvent(store,
          sessionId: 'sess-A',
          type: 'model.streaming',
          seq: 1,
          turnId: 't-A',
          payload: {
            'assistantMessageId': 'msg-ab',
            'delta': '答案A',
            'kind': 'text_delta',
          },);
      await store.openSession('sess-B');

      // A 的回合在后台结束（纯文本 → 本地收尾）
      _pushEvent(store,
          sessionId: 'sess-A',
          type: 'turn.completed',
          seq: 2,
          turnId: 't-A',
          payload: {
            'response': '答案A',
            'tokenCount': 7,
            'toolCallCount': 0,
            'resultType': 'success',
          },);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(store.activeSessionId, 'sess-B'); // 视口未被打扰
      expect(store.messages, isEmpty);
      // 后台完成通知带 A 的 sessionId
      expect(notifier.shown.single['sessionId'], 'sess-A');
      // 会话列表徽标靠 session/list 刷新
      expect(fake.requests.any((e) => e.key == 'session/list'), isTrue);

      // 切回 A：本地收尾内容完整
      await store.openSession('sess-A');
      expect(store.messages.last.content, '答案A');
      expect(store.messages.last.isStreaming, isFalse);
      expect(store.isStreaming, isFalse);
    });

    test('模型兜底：send 字符串拒绝 → setModel 自动切换后重发成功', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-m');
      // 注入可用模型列表（state.updated 全量快照）
      store.debugHandleNotify(const ZcodeFrame(
        method: 'state.updated',
        params: {
          'sessionId': 'sess-m',
          'patch': {
            'model': {
              'available': [
                {
                  'ref': {
                    'providerId': 'builtin:bigmodel-coding-plan',
                    'modelId': 'glm-5.3',
                  },
                },
              ],
            },
          },
        },
      ),);
      var sendCalls = 0;
      fake.handlers['session/send'] = (_) {
        sendCalls++;
        return sendCalls == 1
            ? '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。'
            : {'accepted': true};
      };
      fake.handlers['session/setModel'] = (_) => {'ok': true};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isTrue);
      final setModel =
          fake.requests.firstWhere((e) => e.key == 'session/setModel');
      expect(setModel.value, {
        'sessionId': 'sess-m',
        'model': 'builtin:bigmodel-coding-plan/glm-5.3',
      });
      expect(sendCalls, 2); // 拒绝后自动重发一次
      expect(store.error, isNull);
      expect(store.isStreaming, isTrue); // 重发被接受，回合在途
      expect(store.messages.where((m) => m.content == 'hi'), hasLength(1));
    });

    test('模型兜底：无可用模型 → 提示原文拒绝', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-m2');
      fake.handlers['session/send'] = (_) => '历史任务使用的模型已不可用，请重新选择模型';

      await store.sendMessage('hi');
      expect(store.error, contains('模型已不可用'));
      expect(store.isStreaming, isFalse);
      expect(store.messages.last.isStreaming, isFalse); // 占位已终结
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isFalse);
    });

    test('模型兜底：非模型类字符串拒绝不触发 setModel（避免擅改会话配置）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = _pairedStore(fake);
      await store.openSession('sess-m3');
      store.debugHandleNotify(const ZcodeFrame(
        method: 'state.updated',
        params: {
          'sessionId': 'sess-m3',
          'patch': {
            'model': {
              'available': [
                {
                  'ref': {'providerId': 'p', 'modelId': 'm'},
                },
              ],
            },
          },
        },
      ),);
      fake.handlers['session/send'] = (_) => '配额已耗尽，请稍后再试';
      fake.handlers['session/setModel'] = (_) => {};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isFalse);
      expect(store.error, contains('配额已耗尽'));
      expect(store.isStreaming, isFalse);
    });

    test('权威合并：含多条未匹配 assistant 的工具回合消息不丢失', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('sess-mm').messages.add(_msg('user', [
        {'type': 'text', 'text': '旧问题'},
      ], id: 'h1', created: 1,),);
      final store = _pairedStore(fake);
      await store.openSession('sess-mm');
      await store.sendMessage('执行任务');
      _pushEvent(store,
          sessionId: 'sess-mm',
          type: 'model.streaming',
          seq: 1,
          turnId: 'turn-mm',
          payload: {
            'assistantMessageId': 'msg-am',
            'delta': '开始',
            'kind': 'text_delta',
          },);
      // 服务端回合：user + 文本 assistant + 工具 assistant + 结果文本
      // （典型 agent 回合：text → tool → text 多条 assistant 消息）
      server.session('sess-mm').messages.addAll([
        _msg('assistant', [
          {'type': 'text', 'text': '我先看看'},
        ], id: 'msg-am', created: 2,),
        _msg('assistant', [
          {
            'type': 'tool',
            'callId': 'tc1',
            'state': 'completed',
            'tool': {'name': 'FileWrite'},
          },
        ], id: 'msg-tool', created: 3,),
        _msg('assistant', [
          {'type': 'text', 'text': '写完了'},
        ], id: 'msg-final', created: 4,),
      ],);
      _pushEvent(store,
          sessionId: 'sess-mm',
          type: 'turn.completed',
          seq: 2,
          turnId: 'turn-mm',
          payload: {'toolCallCount': 1, 'resultType': 'success'},);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 全部回合消息存活（不互相顶替）
      final contents = store.messages.map((m) => m.content).toList();
      expect(contents, contains('我先看看'));
      expect(contents, contains('写完了'));
      expect(store.messages.last.content, '写完了');
      expect(store.messages, hasLength(5)); // 历史 + user + 3 条 assistant
    });

    test('回合收尾幂等：idle 兜底先到，turn.completed 后到只收尾一次', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = _pairedStore(fake);
      await store.openSession('sess-dup');
      await store.sendMessage('hi');
      _pushEvent(store,
          sessionId: 'sess-dup',
          type: 'model.streaming',
          seq: 1,
          turnId: 'turn-dup',
          payload: {
            'assistantMessageId': 'msg-dup',
            'delta': '答案',
            'kind': 'text_delta',
          },);
      // state.updated idle 兜底先到（跨通道顺序无保证）
      store.debugHandleNotify(const ZcodeFrame(
        method: 'state.updated',
        params: {
          'sessionId': 'sess-dup',
          'patch': {'status': 'idle'},
        },
      ),);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.shown, hasLength(1));

      // turn.completed(turnId) 后到：不重复通知/刷新
      _pushEvent(store,
          sessionId: 'sess-dup',
          type: 'turn.completed',
          seq: 2,
          turnId: 'turn-dup',
          payload: {
            'response': '答案',
            'toolCallCount': 0,
            'resultType': 'success',
          },);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.shown, hasLength(1));
      expect(store.isStreaming, isFalse);
    });

    test('推送看门狗：订阅成功但推送静默 → 拉起降级轮询；推送恢复即停', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'ev-wd-1',
                'seq': 1,
                'sessionId': 'sess-wd',
                'payload': {'kind': 'text_delta', 'delta': '轮询增量'},
              },
            ],
          };
      final store = _pairedStore(fake);
      store.pushWatchdogDelay = const Duration(milliseconds: 60);
      await store.openSession('sess-wd');
      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);

      // 推送静默超过看门狗阈值 → 自动拉起降级轮询
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(fake.requests.any((e) => e.key == 'session/events'), isTrue);
      expect(store.messages.last.content, '轮询增量');

      // 推送恢复：降级轮询停止（不再产生新的 session/events 请求）
      _pushEvent(store,
          sessionId: 'sess-wd',
          type: 'model.streaming',
          seq: 2,
          turnId: 't-wd',
          payload: {
            'assistantMessageId': 'msg-wd',
            'delta': '推送增量',
            'kind': 'text_delta',
          },);
      final eventsCount =
          fake.requests.where((e) => e.key == 'session/events').length;
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(
        fake.requests.where((e) => e.key == 'session/events').length,
        eventsCount,
      );
      expect(store.messages.last.content, '轮询增量推送增量');
      store.unpair(); // 清理计时器
    });
  });
}
