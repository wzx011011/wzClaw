// ============================================================
// zcode_relay_client 单元测试 — 注入 FakeChannel 模拟 relay 服务端
//
// 覆盖：认证握手与 proof 正确性（Node.js crypto 预计算向量对拍）、
// RPC 收发与自增 id、错误帧抛 ZcodeRequestException、请求超时、
// 未配对 request 抛 StateError、runtime prefs 自动代答、
// 未知反向请求安全拒绝、通知帧回调、NDJSON 行分帧、
// relay error 帧/服务端断开的重连、close() 后不重连、connect 幂等
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:wzxclaw_android/zcode/zcode_pairing.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

// stream_channel 是 web_socket_channel 的传递依赖；测试 fake 需要
// 其中的 StreamChannelMixin / StreamChannel 类型，故显式忽略依赖引用 lint
// ignore: depend_on_referenced_packages
import 'package:stream_channel/stream_channel.dart';

// ---------- 固定测试数据 ----------
// _expectedProof 由 Node.js crypto（与 relay/zcode/server.js 同一实现）预计算，
// 作为独立于被测代码的协议一致性向量
const _testHash = 'gR2WXJKhAFXockqchS/YNvaJLY7V2qipkjH41O407Jk=';
const _testSid = 'sid-test-1';
const _testNonce = 'nonce-abc123';
const _expectedProof = 'VTUZXUzYQY7iiL8vQvtmzhLyzCtAssHHHiEoftC78l8';

/// 按协议公式计算期望 proof：base64url 无 padding 的
/// HMAC-SHA256(hash 字符串 UTF8, "$nonce|probe|$sid" UTF8)
String _proofOf(String nonce, {String sid = _testSid, String hash = _testHash}) {
  final mac =
      Hmac(sha256, utf8.encode(hash)).convert(utf8.encode('$nonce|probe|$sid'));
  return base64Url.encode(mac.bytes).replaceAll('=', '');
}

/// 等待微任务与近端事件队列排空
Future<void> settle([int rounds = 8]) async {
  for (var i = 0; i < rounds; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

// ---------- 测试用 WebSocket 通道 ----------

/// 测试用 WebSocket 通道：[serverSide] 由测试代码扮演 relay 服务端。
/// 基于 StreamChannelController（sync），收发即时、行为与真实通道一致
/// （关闭任一端 sink，两端流都会关闭）。
class FakeWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamChannelController<dynamic> _controller =
      StreamChannelController<dynamic>(sync: true, allowForeignErrors: false);

  final Completer<void> _ready = Completer<void>()..complete(); // 立即建连成功

  /// 服务端视角的通道
  StreamChannel<dynamic> get serverSide => _controller.foreign;

  @override
  Stream<dynamic> get stream => _controller.local.stream;

  @override
  WebSocketSink get sink => _FakeWebSocketSink(_controller.local.sink);

  @override
  Future<void> get ready => _ready.future;

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;
}

/// 委托到内部 sink 的 WebSocketSink 实现
class _FakeWebSocketSink implements WebSocketSink {
  _FakeWebSocketSink(this._inner);
  final StreamSink<dynamic> _inner;

  @override
  void add(dynamic event) => _inner.add(event);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _inner.addError(error, stackTrace);

  @override
  Future addStream(Stream<dynamic> stream) => _inner.addStream(stream);

  @override
  Future close([int? closeCode, String? closeReason]) => _inner.close();

  @override
  Future get done => _inner.done;
}

/// 扮演 relay 服务端：记录客户端发来的信封，可主动下发/断开
class FakeRelayServer {
  FakeRelayServer(this.channel);

  final FakeWebSocketChannel channel;

  /// 客户端发来的全部信封（已 JSON 解码）
  final List<Map<String, dynamic>> messages = [];

  /// 客户端是否已关闭连接（服务端视角收到 done）
  bool clientClosed = false;

  /// 是否自动应答 pair_status_query（模拟健康 relay；false 模拟静默死链）
  bool autoReplyQueries = true;

  void start() {
    channel.serverSide.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      messages.add(msg);
      if (autoReplyQueries && msg['type'] == 'pair_status_query') {
        channel.serverSide.sink.add(jsonEncode({
          'type': 'pair_status_ack',
          'pair_status': 'matched',
        }),);
      }
    }, onDone: () => clientClosed = true,);
  }

  /// 下发一条信封（单条 WS 消息、无换行 —— 与 relay server.js 的 send() 一致）
  void send(Object envelope) =>
      channel.serverSide.sink.add(jsonEncode(envelope));

  /// 下发原始字符串（模拟一条 WS 消息内含多行 NDJSON）
  void sendRaw(String raw) => channel.serverSide.sink.add(raw);

  /// 服务端主动断开连接
  Future<void> close() => channel.serverSide.sink.close();

  /// 客户端发来的 data 信封 payload 列表
  List<Map<dynamic, dynamic>> get dataPayloads => messages
      .where((m) => m['type'] == 'data')
      .map((m) => m['payload'] as Map<dynamic, dynamic>)
      .toList();
}

// ---------- 测试夹具 ----------

/// 每个用例一套：注入连接工厂、记录状态/通知、可配置超时/重连/保活
class RelayHarness {
  RelayHarness({
    this.requestTimeout = const Duration(seconds: 30),
    this.reconnectDelay = const Duration(seconds: 5),
    this.pingInterval = const Duration(seconds: 15),
    this.onRequest,
  });

  final Duration requestTimeout;
  final Duration reconnectDelay;
  final Duration pingInterval;
  final Future<dynamic> Function(ZcodeFrame frame)? onRequest;

  final pairing = const ZcodePairingInfo(
    relayWsUrl: 'wss://zcode.5945.top/ws',
    sid: _testSid,
    hash: _testHash,
  );

  final channels = <FakeWebSocketChannel>[];
  final states = <(ZcodeRelayState, bool)>[];
  final notifies = <ZcodeFrame>[];

  /// 最近一次连接对应的服务端
  late FakeRelayServer server;

  ZcodeRelayClient newClient() {
    final client = ZcodeRelayClient(
      pairing: pairing,
      onStateChange: (state, paired) => states.add((state, paired)),
      onNotify: notifies.add,
      onRequest: onRequest,
      requestTimeout: requestTimeout,
      reconnectDelay: reconnectDelay,
      pingInterval: pingInterval,
      socketFactory: (url) {
        expect(url.toString(), pairing.relayWsUrl);
        final channel = FakeWebSocketChannel();
        channels.add(channel);
        server = FakeRelayServer(channel)..start();
        return channel;
      },
    );
    addTearDown(client.close);
    return client;
  }

  /// 走完整认证：challenge → auth_response → auth_ack
  Future<void> auth({
    String nonce = _testNonce,
    String pairStatus = 'matched',
  }) async {
    server.send({'type': 'auth_challenge', 'nonce': nonce});
    await settle();
    server.send({'type': 'auth_ack', 'pair_status': pairStatus});
    await settle();
  }

  /// 连接并配对成功
  Future<ZcodeRelayClient> connectMatched() async {
    final client = newClient();
    client.connect();
    await settle();
    await auth();
    return client;
  }
}

// ---------- 用例 ----------

void main() {
  group('认证握手', () {
    test('auth_init → challenge → 正确 proof → auth_ack matched', () async {
      final h = RelayHarness();
      final client = h.newClient();
      client.connect();
      await settle();

      expect(h.channels, hasLength(1));
      expect(h.states.first, (ZcodeRelayState.connecting, false));

      // 1. 建连就绪后先发 auth_init
      expect(h.server.messages, hasLength(1));
      final init = h.server.messages.first;
      expect(init['type'], 'auth_init');
      expect(init['role'], 'probe');
      expect(init['device_sid'], _testSid);

      // 2. 质询应答：proof 与 Node.js crypto 预计算向量一致
      h.server.send({'type': 'auth_challenge', 'nonce': _testNonce});
      await settle();
      expect(h.server.messages, hasLength(2));
      final resp = h.server.messages[1];
      expect(resp['type'], 'auth_response');
      expect(resp['device_sid'], _testSid);
      expect(resp['proof'], _expectedProof);
      expect(resp['proof'], _proofOf(_testNonce));
      expect(h.states, contains((ZcodeRelayState.authenticating, false)));

      // 3. pair_status=matched → 配对成功
      h.server.send({'type': 'auth_ack', 'pair_status': 'matched'});
      await settle();
      expect(client.currentState, ZcodeRelayState.matched);
      expect(client.paired, isTrue);
      expect(h.states.last, (ZcodeRelayState.matched, true));
    });

    test('任意 nonce 的 proof 符合协议公式（43 字符 base64url 无 padding）', () async {
      final h = RelayHarness();
      final client = h.newClient();
      client.connect();
      await settle();
      h.server.send({'type': 'auth_challenge', 'nonce': 'another-nonce-42'});
      await settle();
      final resp = h.server.messages.last;
      expect(resp['proof'], _proofOf('another-nonce-42'));
      expect(resp['proof'] as String, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
    });

    test('auth_ack waiting → 未配对；pair_status_ack matched → 配对成功', () async {
      final h = RelayHarness();
      final client = h.newClient();
      client.connect();
      await settle();
      h.server.send({'type': 'auth_challenge', 'nonce': _testNonce});
      await settle();
      h.server.send({'type': 'auth_ack', 'pair_status': 'waiting'});
      await settle();
      expect(client.currentState, ZcodeRelayState.waiting);
      expect(client.paired, isFalse);

      h.server.send({'type': 'pair_status_ack', 'pair_status': 'matched'});
      await settle();
      expect(client.currentState, ZcodeRelayState.matched);
      expect(client.paired, isTrue);
    });
  });

  group('RPC 请求', () {
    test('请求携带自增 int id，响应按 id 匹配返回 result', () async {
      final h = RelayHarness();
      final client = await h.connectMatched();
      expect(client.paired, isTrue);

      final future = client.request('session/list', {});
      await settle();
      final payload = h.server.dataPayloads.single;
      expect(payload['id'], 1);
      expect(payload['method'], 'session/list');
      expect(payload['params'], {});

      h.server.send({
        'type': 'data',
        'payload': {
          'id': 1,
          'result': {'sessions': <String>[]},
        },
      });
      expect(await future, {'sessions': <String>[]});

      // 第二次请求 id 自增；params 为 null 时不携带该键
      final future2 = client.request('session/stop');
      await settle();
      final payload2 = h.server.dataPayloads.last;
      expect(payload2['id'], 2);
      expect(payload2['method'], 'session/stop');
      expect(payload2.containsKey('params'), isFalse);
      h.server.send({
        'type': 'data',
        'payload': {'id': 2, 'result': {}},
      });
      expect(await future2, {});
    });

    test('错误帧抛 ZcodeRequestException（含 code/message）', () async {
      final h = RelayHarness();
      final client = await h.connectMatched();

      final future = client.request('session/resume', {'sessionId': 'nope'});
      await settle();
      h.server.send({
        'type': 'data',
        'payload': {
          'id': 1,
          'error': {'code': -32601, 'message': 'Method not found'},
        },
      });
      await expectLater(
        future,
        throwsA(
          isA<ZcodeRequestException>()
              .having((e) => e.code, 'code', -32601)
              .having((e) => e.message, 'message', 'Method not found'),
        ),
      );
    });

    test('未配对时 request 抛 StateError（idle 与 waiting 状态）', () async {
      final h = RelayHarness();
      final client = h.newClient();
      expect(() => client.request('session/list'), throwsStateError);

      client.connect();
      await settle();
      h.server.send({'type': 'auth_challenge', 'nonce': _testNonce});
      await settle();
      h.server.send({'type': 'auth_ack', 'pair_status': 'waiting'});
      await settle();
      expect(client.paired, isFalse);
      expect(() => client.request('session/list'), throwsStateError);
    });

    test('请求超时抛 TimeoutException', () async {
      final h = RelayHarness(requestTimeout: const Duration(milliseconds: 40));
      final client = await h.connectMatched();

      final future = client.request('session/list', {});
      await settle();
      expect(h.server.dataPayloads, hasLength(1)); // 已发出，服务端不回
      await expectLater(future, throwsA(isA<TimeoutException>()));
    });
  });

  group('反向请求与通知', () {
    test('session/requestRuntimePreferences 自动代答 result', () async {
      final h = RelayHarness();
      await h.connectMatched();

      h.server.send({
        'type': 'data',
        'payload': {
          'id': 'server-1',
          'method': 'session/requestRuntimePreferences',
          'params': {'scope': 'runtime-materialization'},
        },
      });
      await settle();

      // fake 服务端收到代答帧：{id, result:{nativeSearchEnhancementsEnabled:false}}
      final reply = h.server.dataPayloads.single;
      expect(reply['id'], 'server-1');
      expect(reply['result'], {'nativeSearchEnhancementsEnabled': false});
      expect(reply.containsKey('method'), isFalse);
      expect(reply.containsKey('error'), isFalse);
    });

    test('未知反向请求默认安全拒绝（-32000）', () async {
      final h = RelayHarness();
      await h.connectMatched();

      h.server.send({
        'type': 'data',
        'payload': {'id': 'server-2', 'method': 'session/whatever'},
      });
      await settle();

      final reply = h.server.dataPayloads.single;
      expect(reply['id'], 'server-2');
      expect(reply['error'], {'code': -32000, 'message': '手机端未处理该请求'});
      expect(reply.containsKey('result'), isFalse);
    });

    test('通知帧（有 method 无 id）回调 onNotify，不产生应答', () async {
      final h = RelayHarness();
      await h.connectMatched();

      h.server.send({
        'type': 'data',
        'payload': {
          'method': 'state.updated',
          'params': {
            'patch': {'status': 'running'},
          },
        },
      });
      await settle();

      expect(h.notifies, hasLength(1));
      expect(h.notifies.single.method, 'state.updated');
      expect(h.notifies.single.params, {
        'patch': {'status': 'running'},
      });
      expect(h.server.dataPayloads, isEmpty);
    });

    test('NDJSON 行分帧：一条 WS 消息内多行 JSON 逐行处理', () async {
      final h = RelayHarness();
      await h.connectMatched();

      h.server.sendRaw(
        '{"type":"data","payload":{"method":"a","params":1}}\n'
        '{"type":"data","payload":{"method":"b","params":2}}\n',
      );
      await settle();
      expect(h.notifies.map((f) => f.method), ['a', 'b']);
      expect(h.notifies.map((f) => f.params), [1, 2]);
    });
  });

  group('断线与重连', () {
    test('relay error 帧：关闭连接并自动重连', () async {
      final h = RelayHarness(reconnectDelay: const Duration(milliseconds: 30));
      final client = await h.connectMatched();

      h.server.send({'type': 'error', 'code': 'AUTH_FAILED', 'message': 'auth failed'});
      await settle();

      // 客户端主动关闭了连接（服务端视角收到 done），状态回到 closed
      expect(h.server.clientClosed, isTrue);
      expect(client.paired, isFalse);
      expect(h.states, contains((ZcodeRelayState.closed, false)));

      // reconnectDelay 后自动重连，新连接重新走认证
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(h.channels, hasLength(2));
      await settle();
      expect(h.server.messages, isNotEmpty);
      expect(h.server.messages.first['type'], 'auth_init');
      expect(h.server.messages.first['role'], 'probe');
    });

    test('服务端断开：pending 全部失败、状态 closed、自动重连', () async {
      final h = RelayHarness(reconnectDelay: const Duration(milliseconds: 30));
      final client = await h.connectMatched();

      final future = client.request('session/list', {});
      // 先挂断言监听再断线，避免错误先于监听触发 unhandled
      final done = expectLater(future, throwsA(isA<Exception>()));
      await settle();
      await h.server.close(); // 服务端断开连接
      await done;

      // 经过 closed 转换（currentState 可能已被重连推进，故检查状态历史）
      expect(h.states, contains((ZcodeRelayState.closed, false)));
      expect(client.paired, isFalse);

      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(h.channels, hasLength(2)); // 已建立新连接
      await settle();
      expect(h.server.messages.first['type'], 'auth_init');
    });

    test('close() 手动关闭：pending 失败、不重连', () async {
      final h = RelayHarness(reconnectDelay: const Duration(milliseconds: 30));
      final client = await h.connectMatched();

      final future = client.request('session/list', {});
      // 先挂断言监听再关闭，避免错误先于监听触发 unhandled
      final done = expectLater(future, throwsA(isA<Exception>()));
      await settle();
      client.close();
      await done;
      expect(client.currentState, ZcodeRelayState.closed);
      expect(client.paired, isFalse);
      expect(h.states.last, (ZcodeRelayState.closed, false));

      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(h.channels, hasLength(1)); // 没有建立新连接
    });

    test('connect() 幂等：连接中重复调用只建立一条连接', () async {
      final h = RelayHarness();
      final client = h.newClient();
      client.connect();
      client.connect();
      await settle();
      expect(h.channels, hasLength(1));

      // 配对成功后再次 connect 也不重连
      await h.auth();
      client.connect();
      await settle();
      expect(h.channels, hasLength(1));
    });
  });

  group('保活与死链检测', () {
    test('认证成功后周期发 pair_status_query，健康应答不断线', () async {
      final h = RelayHarness(pingInterval: const Duration(milliseconds: 50));
      final client = await h.connectMatched();
      await Future<void>.delayed(const Duration(milliseconds: 300));

      // 心跳查询已发出且形状正确
      final queries =
          h.server.messages.where((m) => m['type'] == 'pair_status_query');
      expect(queries, isNotEmpty);
      expect(queries.first['device_sid'], _testSid);
      // 连接保持：无重连，仍配对
      expect(h.channels, hasLength(1));
      expect(client.paired, isTrue);
    });

    test('连续两个周期无入站帧 → 判定死链，主动断开并走既有重连', () async {
      final h = RelayHarness(
        reconnectDelay: const Duration(milliseconds: 30),
        pingInterval: const Duration(milliseconds: 50),
      );
      final client = await h.connectMatched();
      h.server.autoReplyQueries = false; // relay 静默（半开/死链）

      await Future<void>.delayed(const Duration(milliseconds: 400));
      // 死链被主动关闭（半开连接的 _onSocketClosed 永不触发的场景）
      expect(h.states, contains((ZcodeRelayState.closed, false)));
      expect(h.channels.length, greaterThanOrEqualTo(2));
      expect(client.paired, isFalse); // 新连接未完成认证
    });

    test('close() 手动关闭：保活停止，不再发心跳', () async {
      final h = RelayHarness(pingInterval: const Duration(milliseconds: 40));
      final client = await h.connectMatched();
      client.close();
      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(
        h.server.messages.where((m) => m['type'] == 'pair_status_query'),
        isEmpty,
      );
    });
  });

  group('重连退避', () {
    test('延迟 = 指数(基数*2^n) - 1/3 抖动；认证成功后计数归零', () async {
      final h = RelayHarness(reconnectDelay: const Duration(milliseconds: 90));
      final client = h.newClient();

      // 尝试 0：延迟 ∈ [60, 90]ms（基数 - 1/3 抖动）
      for (var i = 0; i < 10; i++) {
        final d = client.debugNextReconnectDelay().inMilliseconds;
        expect(d, greaterThanOrEqualTo(60));
        expect(d, lessThanOrEqualTo(90));
      }

      client.connect();
      await settle();
      await h.auth();
      expect(client.debugReconnectAttempts, 0); // 认证成功归零

      // 断线一次：计数 +1，下一次延迟翻倍区间 [120, 180]
      await h.server.close();
      await settle();
      expect(client.debugReconnectAttempts, 1);
      final d = client.debugNextReconnectDelay().inMilliseconds;
      expect(d, greaterThanOrEqualTo(120));
      expect(d, lessThanOrEqualTo(180));
    });
  });

  group('推送帧与拒绝帧', () {
    test('session/event 推送帧透传 onNotify（params 完整）；重连后新连接仍可达', () async {
      final h = RelayHarness(reconnectDelay: const Duration(milliseconds: 30));
      final client = await h.connectMatched();

      void pushEvent(String eventId) {
        h.server.send({
          'type': 'data',
          'payload': {
            'method': 'session/event',
            'params': {
              'deliveryKind': 'web-remote-replayable',
              'eventId': eventId,
              'seq': 1,
              'sessionId': 'sess-1',
              'turnId': 'turn-1',
              'type': 'model.streaming',
              'payload': {'delta': 'hi', 'kind': 'text_delta'},
            },
          },
        },);
      }

      pushEvent('e1');
      await settle();
      expect(h.notifies, hasLength(1));
      expect(h.notifies.single.method, 'session/event');
      expect((h.notifies.single.params as Map)['sessionId'], 'sess-1');
      expect(
        ((h.notifies.single.params as Map)['payload'] as Map)['delta'],
        'hi',
      );

      // 断线重连后，新连接上的推送帧仍到达
      await h.server.close();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(h.channels, hasLength(2));
      await h.auth();
      pushEvent('e2');
      await settle();
      expect(h.notifies, hasLength(2));
      expect(client.paired, isTrue);
    });

    test('onRequest 钩子抛错 → 回传 error 帧（-32000），而非 result', () async {
      final h = RelayHarness(
        onRequest: (frame) async =>
            throw Exception('会话已切换，请求被拒绝'),
      );
      await h.connectMatched();

      h.server.send({
        'type': 'data',
        'payload': {
          'id': 'server-9',
          'method': 'session/requestPermission',
          'params': {'toolCallId': 'tc-1', 'toolName': 'FileWrite'},
        },
      });
      await settle();

      final reply = h.server.dataPayloads.single;
      expect(reply['id'], 'server-9');
      expect((reply['error'] as Map)['code'], -32000);
      expect((reply['error'] as Map)['message'], contains('会话已切换'));
      expect(reply.containsKey('result'), isFalse);
    });
  });
}
