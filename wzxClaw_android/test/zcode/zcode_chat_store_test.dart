// ============================================================
// zcode_chat_store_test — 状态层单元测试
//
// 用 FakeZcodeRelayClient（implements 公共 API）+ FakeZcodeNotifier
// 通过构造注入驱动；通知帧 / 反向请求用 @visibleForTesting 钩子注入。
// ============================================================

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

    test('stopGeneration：session/stop + 权威刷新', () async {
      final fake = FakeZcodeRelayClient();
      _stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/stop'] = (_) => {};
      fake.handlers['session/events'] = (_) => {'events': []};
      fake.handlers['session/messages'] = (_) => {
            'messages': [
              _msg('assistant', [
                {'type': 'text', 'text': '被中止的回答'},
              ], id: 'b1', created: 3,),
            ],
          };
      final store = _pairedStore(fake);
      await store.openSession('sess-stop');
      await store.sendMessage('go');

      await store.stopGeneration();
      expect(fake.requests.any((e) => e.key == 'session/stop'), isTrue);
      final stop = fake.requests.firstWhere((e) => e.key == 'session/stop');
      expect(stop.value, {'sessionId': 'sess-stop'});
      expect(store.messages.single.content, '被中止的回答');
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

    test('unpair：挂起的反向请求以拒绝结果收尾', () async {
      final fake = FakeZcodeRelayClient();
      final store = _pairedStore(fake);

      final future = store.debugHandleReverseRequest(const ZcodeFrame(
        id: 'server-7',
        method: 'session/requestPermission',
        params: {'toolCallId': 'tc-x', 'toolName': 'FileRead'},
      ),);
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission, isNotNull);

      store.unpair();
      expect(await future, {'rejected': true});
      expect(store.activePermission, isNull);
    });
  });
}
