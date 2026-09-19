// ============================================================
// zcode_relay_client — ZCode 远程中继客户端（probe / 手机角色）
//
// 【契约文件】本文件的类签名是并行开发的公共契约，实现者补全方法体，
// 可增补私有成员，公共 API 不得改动（除非同步通知 store/UI 适配）。
//
// 协议参考（实测验证）：relay/zcode/APP-SERVER.md、relay/zcode/companion.js
//
// relay 信封（NDJSON over WebSocket）：
//   手机发送：
//     {type:'auth_init', role:'probe', device_sid}
//     {type:'auth_response', device_sid, proof}
//     {type:'data', payload:<ZCode 帧>}
//     {type:'pair_status_query', device_sid}（心跳查询，保活/死链检测）
//   接收：
//     {type:'auth_challenge', nonce}
//     {type:'auth_ack'|'pair_status_ack', pair_status:'waiting'|'matched'}
//     {type:'data', payload:<ZCode 帧>}
//     {type:'error', code, message} → 上浮 onRelayError 后关闭重连
//
// proof = base64url(HMAC-SHA256(hash 字符串作为密钥, "$nonce|probe|$sid"))
//   注意：hash 本身是字符串密钥，不要 base64 解码（Dart: package:crypto 的 Hmac）
//
// ZCode Protocol v1 帧（data.payload）：
//   请求 {id: int 递增, method, params} → 响应 {id, result} 或 {id, error:{code,message}}
//   通知 {method, params}（无 id）
//   反向请求 {id: "server-N" 字符串, method, params}：
//     session/requestRuntimePreferences → 自动代答 {id, result:{nativeSearchEnhancementsEnabled:false}}
//     其他 → 交给 onRequest 钩子（宿主决定批准/拒绝，result 帧回传）；
//           未设钩子 → 默认回 {id, error:{code:-32000, message:'手机端未处理该请求'}}（安全拒绝）
//
// 保活与死链检测（P1.2）：认证成功后按 pingInterval 发
// pair_status_query（relay 既有的应用层心跳），任何入站帧都会重置
// 活性计时；连续 pingLossLimit 个周期无任何入站帧判定为半开/死链
// （NAT 重绑、网络切换的典型症状），主动关闭走既有重连路径。
// 重连采用指数退避 + 抖动（基数 reconnectDelay，上限 60s）。
// ============================================================

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'zcode_pairing.dart';
import 'connection_diagnostics.dart';

/// 重连延迟上限（指数退避封顶）
const int _kMaxReconnectMs = 60 * 1000;

/// 连接状态
enum ZcodeRelayState { idle, connecting, authenticating, waiting, matched, closed }

/// ZCode 帧（data.payload 的 Dart 表示）
class ZcodeFrame {
  final dynamic id; // int（手机请求）/ String（服务端反向请求）/ null（通知）
  final String? method;
  final dynamic params;
  final dynamic result;
  final Map<String, dynamic>? error; // {code, message}

  const ZcodeFrame({this.id, this.method, this.params, this.result, this.error});
}

/// 在途请求（request 的完成器与超时定时器）
class _PendingRequest {
  final Completer<dynamic> completer;
  final Timer timer;
  _PendingRequest(this.completer, this.timer);
}

/// relay 客户端（probe 角色）
class ZcodeRelayClient {
  ZcodeRelayClient({
    required ZcodePairingInfo pairing,
    void Function(ZcodeRelayState state, bool paired)? onStateChange,
    void Function(ZcodeFrame frame)? onNotify, // 通知帧回调（state.updated / v4/telemetry / session/event）
    Future<dynamic> Function(ZcodeFrame frame)? onRequest, // 反向请求钩子（权限/AskUser 等）
    void Function(String code, String message)? onRelayError, // relay 拒绝帧（认证失效等）
    Duration requestTimeout = const Duration(seconds: 30),
    Duration reconnectDelay = const Duration(seconds: 2), // 退避基数
    WebSocketChannel Function(Uri url)? socketFactory, // WebSocket 连接工厂（测试注入）
    Duration pingInterval = const Duration(seconds: 15), // 保活/死链检测周期
    int pingLossLimit = 3, // 连续无入站帧的周期数上限（45s：容忍移动网络短暂静默，仍早于 relay 的 60s 陈旧判定）
  })  : _pairing = pairing,
        _onStateChange = onStateChange,
        _onNotify = onNotify,
        _onRequest = onRequest,
        _onRelayError = onRelayError,
        _requestTimeout = requestTimeout,
        _reconnectDelay = reconnectDelay,
        _socketFactory = socketFactory,
        _pingInterval = pingInterval,
        _pingLossLimit = pingLossLimit;

  final ZcodePairingInfo _pairing;
  final void Function(ZcodeRelayState state, bool paired)? _onStateChange;
  final void Function(ZcodeFrame frame)? _onNotify;
  final Future<dynamic> Function(ZcodeFrame frame)? _onRequest;
  final void Function(String code, String message)? _onRelayError;
  final Duration _requestTimeout;
  final Duration _reconnectDelay;
  final WebSocketChannel Function(Uri url)? _socketFactory;
  final Duration _pingInterval;
  final int _pingLossLimit;

  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _subscription;
  ZcodeRelayState _state = ZcodeRelayState.idle;
  bool _closedByUser = false;
  Timer? _reconnectTimer;
  int _nextRequestId = 1;
  final Map<int, _PendingRequest> _pending = {};

  // ---- 保活 / 死链检测 ----
  Timer? _keepaliveTimer;
  final Stopwatch _inboundWatch = Stopwatch();
  final Random _random = Random();

  // ---- 重连退避 ----
  int _reconnectAttempts = 0;

  /// 下一跳延迟地板（毫秒）：relay 错误帧按码设置，消费一次后清零
  int _nextDelayFloorMs = 0;

  /// 当前已排程的重连延迟（测试观测；未排程时为 null）
  @visibleForTesting
  Duration? get debugScheduledReconnectDelay => _scheduledReconnectDelay;
  Duration? _scheduledReconnectDelay;

  // ---------- 公共 API ----------

  /// 连接并完成配对认证（幂等）
  void connect() {
    // 已有连接或正在建连/认证时幂等返回（waiting/matched 状态下 _socket 非空，同样覆盖）
    if (_socket != null ||
        _state == ZcodeRelayState.connecting ||
        _state == ZcodeRelayState.authenticating) {
      return;
    }
    _closedByUser = false;
    _setState(ZcodeRelayState.connecting, false);
    final factory = _socketFactory ?? _defaultConnect;
    final WebSocketChannel socket;
    try {
      final uri = Uri.parse(_pairing.relayWsUrl);
      ConnectionDiagnostics.instance.noteTarget(uri);
      ConnectionDiagnostics.instance.record('尝试', '连接 ${uri.host}:${uri.port}');
      socket = factory(uri);
    } catch (e) {
      // 工厂同步抛错视作建连失败，走重连
      ConnectionDiagnostics.instance.record('建连失败', '工厂抛错: $e');
      _scheduleReconnect();
      return;
    }
    _socket = socket;
    _subscription = socket.stream.listen(
      _onSocketData,
      onError: (Object _) => _onSocketClosed(socket),
      onDone: () => _onSocketClosed(socket),
    );
    // WebSocketChannel.connect 异步建连：就绪后再发 auth_init
    unawaited(_authInitWhenReady(socket));
  }

  /// 主动关闭（不再重连）
  void close() {
    _closedByUser = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _stopKeepalive();
    _failAllPending('已关闭');
    final socket = _socket;
    _socket = null;
    _subscription?.cancel();
    _subscription = null;
    if (socket != null) {
      try {
        socket.sink.close();
      } catch (_) {/* 忽略关闭异常 */}
    }
    _setState(ZcodeRelayState.closed, false);
  }

  /// 是否配对成功可收发
  bool get paired => _state == ZcodeRelayState.matched;

  /// 当前状态
  ZcodeRelayState get currentState => _state;

  /// 发起 ZCode Protocol 请求；未配对时抛 StateError；超时/错误帧抛 Exception
  /// 返回 result（Map/List/其他），错误帧抛 ZcodeRequestException（含 code/message）
  Future<dynamic> request(String method, [Map<String, dynamic>? params]) {
    if (_socket == null || _state != ZcodeRelayState.matched) {
      throw StateError('未连接到 ZCode（配对未完成）');
    }
    final id = _nextRequestId++;
    final completer = Completer<dynamic>();
    final timer = Timer(_requestTimeout, () {
      _pending.remove(id);
      if (!completer.isCompleted) {
        completer.completeError(TimeoutException('请求超时: $method', _requestTimeout));
      }
    });
    _pending[id] = _PendingRequest(completer, timer);
    _send({
      'type': 'data',
      'payload': {
        'id': id,
        'method': method,
        // params 为 null 时省略键（与 TS 版 undefined 序列化行为一致）
        if (params != null) 'params': params,
      },
    });
    return completer.future;
  }

  // ---------- 仅测试使用的注入入口 ----------

  /// 仅测试使用：当前重连退避的尝试计数（认证成功后清零）
  @visibleForTesting
  int get debugReconnectAttempts => _reconnectAttempts;

  /// 仅测试使用：按当前尝试计数计算的下一次重连延迟（含抖动）
  @visibleForTesting
  Duration debugNextReconnectDelay() => _nextReconnectDelay();

  // ---------- 内部实现 ----------

  /// 默认连接工厂（生产环境）
  static WebSocketChannel _defaultConnect(Uri url) => WebSocketChannel.connect(url);

  /// 建连就绪后发送 auth_init
  Future<void> _authInitWhenReady(WebSocketChannel socket) async {
    try {
      await socket.ready;
    } catch (e) {
      ConnectionDiagnostics.instance.record('建连失败', 'TLS/网络: $e');
      _onSocketClosed(socket); // 建连失败，走断线流程
      return;
    }
    if (_socket == socket) {
      ConnectionDiagnostics.instance.record('已连接', '发送认证');
      _send({'type': 'auth_init', 'role': 'probe', 'device_sid': _pairing.sid});
    }
  }

  /// 套接字数据：NDJSON 行分帧（按 \n 切）。
  /// relay 实际每条 WS 消息发一个 JSON（无尾部换行，server.js send()），
  /// 因此切分后的最后一段也按完整行处理；一条消息内多行同样兼容。
  void _onSocketData(dynamic data) {
    final text = data is String
        ? data
        : data is List<int>
            ? utf8.decode(data)
            : null;
    if (text == null || text.isEmpty) return;
    for (final line in text.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      _handleRelayMessage(trimmed);
    }
  }

  /// 处理一条 relay 信封
  void _handleRelayMessage(String raw) {
    final dynamic msg;
    try {
      msg = jsonDecode(raw);
    } catch (_) {
      return; // 非 JSON 行直接忽略
    }
    if (msg is! Map) return;
    // 任何入站信封都视为连接存活的证据（保活计时重置）
    _inboundWatch.reset();
    switch (msg['type']) {
      case 'error':
        {
          // relay 拒绝（认证失败/房间失效/未配对等）：上浮原因后关闭，交给重连流程。
          // CAPACITY = 同房间 probe 槽（默认 3）被网络切换留下的半开连接占满，
          // relay 要等一个陈旧回收周期（ping 30s × 1.5 = 45s）才能腾位：按「多等」
          // 原则把下一跳顶到长档，短档反复撞墙只会白刷拒绝日志。
          final code = msg['code']?.toString() ?? 'UNKNOWN';
          if (code == 'CAPACITY') _nextDelayFloorMs = 50 * 1000;
          ConnectionDiagnostics.instance.record(
            'relay拒绝',
            '$code ${(msg['message'] ?? '请求被拒绝')}',
          );
          _onRelayError?.call(
            code,
            (msg['message'] ?? '请求被拒绝').toString(),
          );
          try {
            _socket?.sink.close();
          } catch (_) {/* onDone 兜底 */}
          return;
        }
      case 'auth_challenge':
        _setState(ZcodeRelayState.authenticating, false);
        _send({
          'type': 'auth_response',
          'device_sid': _pairing.sid,
          'proof': _computeProof(msg['nonce']?.toString() ?? ''),
        });
        return;
      case 'auth_ack':
      case 'pair_status_ack':
        final matched = msg['pair_status'] == 'matched';
        ConnectionDiagnostics.instance.record(
          '配对',
          matched ? '成功' : '已认证，等待配对',
        );
        _setState(
          matched ? ZcodeRelayState.matched : ZcodeRelayState.waiting,
          matched,
        );
        return;
      case 'data':
        final payload = msg['payload'];
        if (payload is Map) _handleZcodeFrame(payload);
        return;
    }
  }

  /// 处理 ZCode Protocol 帧（data.payload）
  void _handleZcodeFrame(Map<dynamic, dynamic> payload) {
    final id = payload['id'];
    final rawMethod = payload['method'];
    final method = rawMethod is String ? rawMethod : null; // 容忍畸形帧
    // 反向请求：有 method 且有 id（"server-N" 字符串）
    if (method != null && id != null) {
      _handleReverseRequest(id, method, payload['params']);
      return;
    }
    // 本端请求的响应：id 为 int，按 id 匹配完成 pending
    if (id is int) {
      final entry = _pending.remove(id);
      if (entry == null) return;
      entry.timer.cancel();
      final error = payload['error'];
      if (error is Map) {
        if (!entry.completer.isCompleted) {
          entry.completer.completeError(
            ZcodeRequestException(
              (error['code'] as num?)?.toInt() ?? -32000,
              (error['message'] ?? '未知错误').toString(),
              error['data'] is Map
                  ? Map<String, dynamic>.from(error['data'] as Map)
                  : null,
            ),
          );
        }
      } else if (!entry.completer.isCompleted) {
        entry.completer.complete(payload['result']);
      }
      return;
    }
    // 通知帧：有 method 无 id
    if (method != null) {
      _onNotify?.call(ZcodeFrame(method: method, params: payload['params']));
    }
  }

  /// 反向请求：runtime preferences 自动代答；其余交给 onRequest 钩子（宿主决定
  /// 批准/拒绝，完成后回传 result/error 帧）。未设钩子时默认安全拒绝，
  /// 避免空 result 被对端解读为批准。
  void _handleReverseRequest(dynamic id, String method, dynamic params) {
    if (method == 'session/requestRuntimePreferences') {
      _send({
        'type': 'data',
        'payload': {
          'id': id,
          'result': {'nativeSearchEnhancementsEnabled': false},
        },
      });
      return;
    }
    final hook = _onRequest;
    if (hook == null) {
      _send({
        'type': 'data',
        'payload': {
          'id': id,
          'error': {'code': -32000, 'message': '手机端未处理该请求'},
        },
      });
      return;
    }
    // 捕获分发时的 socket：hook 完成时若连接已换代（断线重连/客户端重建），
    // 应答帧绝不能发上新连接——app-server 侧 server-N id 会从头复用，陈旧
    // 应答可能命中同 id 的新请求（一次未经确认的批准）。直接丢弃并留观测。
    // （store 侧另在断线时作废全部 pending 反向请求，这里是第二道防线。）
    final socketAtRequest = _socket;
    unawaited(() async {
      try {
        final result = await hook(ZcodeFrame(id: id, method: method, params: params));
        if (!identical(_socket, socketAtRequest)) {
          debugPrint(
              '[zcode-relay] 丢弃过期反向请求应答（连接已换代）: id=$id method=$method',);
          return;
        }
        _send({
          'type': 'data',
          'payload': {'id': id, 'result': result},
        });
      } catch (error) {
        if (!identical(_socket, socketAtRequest)) {
          debugPrint(
              '[zcode-relay] 丢弃过期反向请求拒绝（连接已换代）: id=$id method=$method',);
          return;
        }
        _send({
          'type': 'data',
          'payload': {
            'id': id,
            'error': {'code': -32000, 'message': error.toString()},
          },
        });
      }
    }());
  }

  /// 质询 proof：base64url 无 padding(HMAC-SHA256(hash 字符串 UTF8, "$nonce|probe|$sid" UTF8))
  String _computeProof(String nonce) {
    final key = utf8.encode(_pairing.hash); // hash 是字符串密钥，不要 base64 解码
    final data = utf8.encode('$nonce|probe|${_pairing.sid}');
    final digest = Hmac(sha256, key).convert(data);
    return base64Url.encode(digest.bytes).replaceAll('=', '');
  }

  /// 断线统一处理（对端关闭 / 建连失败 / 流错误 / 死链主动关闭）
  void _onSocketClosed(WebSocketChannel socket) {
    if (_socket != socket) return; // 过期连接的事件，忽略
    ConnectionDiagnostics.instance.record(
      '断开',
      '连接断开（已重试 $_reconnectAttempts 次）',
    );
    _socket = null;
    _subscription?.cancel();
    _subscription = null;
    _stopKeepalive();
    _failAllPending('连接已断开');
    _setState(ZcodeRelayState.closed, false);
    _scheduleReconnect();
  }

  /// 安排重连；close() 手动关闭或延迟为 0 时不重连。
  /// 延迟 = 指数退避（基数 * 2^attempt，上限 60s）+ 抖动（±1/6），
  /// 参考 services/connection_manager.dart 的既有实现。
  void _scheduleReconnect() {
    if (_closedByUser || _reconnectTimer != null) return;
    if (_reconnectDelay <= Duration.zero) return; // 0 = 不自动重连（与 TS 版一致）
    final delay = _nextReconnectDelay();
    _scheduledReconnectDelay = delay;
    _reconnectAttempts++;
    ConnectionDiagnostics.instance.record(
      '重连',
      '${delay.inMilliseconds}ms 后第 $_reconnectAttempts 次重试',
    );
    _reconnectTimer = Timer(delay, () {
      _scheduledReconnectDelay = null;
      _reconnectTimer = null;
      connect();
    });
  }

  /// 计算下一次重连延迟：base * 2^attempt 封顶 60s，叠加 ±1/6 对称抖动。
  /// 对称而非纯减：纯减抖动会让多台设备挤在窗口上限同时重连
  Duration _nextReconnectDelay() {
    final baseMs = _reconnectDelay.inMilliseconds;
    final shift = _reconnectAttempts < 16 ? _reconnectAttempts : 16; // 防溢出
    var cappedMs = baseMs * (1 << shift);
    if (cappedMs < baseMs) cappedMs = baseMs;
    if (cappedMs > _kMaxReconnectMs) cappedMs = _kMaxReconnectMs;
    if (cappedMs < _nextDelayFloorMs) cappedMs = _nextDelayFloorMs;
    _nextDelayFloorMs = 0; // 地板只消费一次
    final jitterMs = cappedMs ~/ 6;
    if (jitterMs == 0) return Duration(milliseconds: cappedMs);
    return Duration(
      milliseconds:
          cappedMs - jitterMs + _random.nextInt(jitterMs * 2 + 1),
    );
  }

  // ---------- 保活 / 死链检测 ----------

  /// 认证成功后启动保活：周期发 pair_status_query（relay 既有心跳），
  /// 连续 pingLossLimit 个周期无任何入站帧 → 判定半开/死链，
  /// 主动关闭触发既有重连路径
  void _startKeepalive() {
    if (_pingInterval <= Duration.zero || _keepaliveTimer != null) return;
    _inboundWatch
      ..reset()
      ..start();
    _keepaliveTimer = Timer.periodic(_pingInterval, (_) => _keepaliveTick());
  }

  void _stopKeepalive() {
    _keepaliveTimer?.cancel();
    _keepaliveTimer = null;
    _inboundWatch.stop();
  }

  void _keepaliveTick() {
    // 发心跳查询（relay 既有协议帧；应答 pair_status_ack 会重置活性计时）
    _send({'type': 'pair_status_query', 'device_sid': _pairing.sid});
    // 连续 pingLossLimit 个周期无任何入站帧 → 半开/死链：
    // 主动关闭，走既有断线重连流程
    if (_inboundWatch.elapsed < _pingInterval * _pingLossLimit) return;
    final socket = _socket;
    if (socket == null) return;
    _stopKeepalive();
    try {
      socket.sink.close();
    } catch (_) {/* 忽略关闭异常 */}
    _onSocketClosed(socket);
  }

  /// 回前台链路校验：Android 后台期间 Dart 定时器被冻结，保活/死链检测
  /// 停摆，链路多半已被系统或对端回收；回前台若仍显示已连接，要等最多
  /// 一个死链窗口才会发现。此方法供生命周期回调立即调用——已认证但超过
  /// [threshold] 无任何入站帧 → 视为死链，主动断开走快速重连。
  void verifyAlive({Duration threshold = const Duration(seconds: 10)}) {
    final state = _state;
    if (state != ZcodeRelayState.matched && state != ZcodeRelayState.waiting) {
      return; // 未认证：断线重连流程本就自理
    }
    if (_inboundWatch.elapsed <= threshold) return; // 链路新鲜
    final socket = _socket;
    if (socket == null) return;
    _stopKeepalive();
    try {
      socket.sink.close();
    } catch (_) {/* 忽略关闭异常 */}
    _onSocketClosed(socket);
  }

  /// 发送一条 relay 信封（连接已断开时静默丢弃，由断线流程统一善后）
  void _send(Object value) {    final socket = _socket;
    if (socket == null) return;
    try {
      socket.sink.add(jsonEncode(value));
    } catch (_) {/* 忽略已关闭时的发送失败 */}
  }

  /// 全部在途请求立即失败
  void _failAllPending(String message) {
    for (final entry in _pending.values) {
      entry.timer.cancel();
      if (!entry.completer.isCompleted) {
        entry.completer.completeError(Exception(message));
      }
    }
    _pending.clear();
  }

  /// 更新状态并回调；认证成功（waiting/matched）时启动保活并清零
  /// 重连退避计数，其余状态停保活
  void _setState(ZcodeRelayState state, bool paired) {
    _state = state;
    if (state == ZcodeRelayState.waiting || state == ZcodeRelayState.matched) {
      _reconnectAttempts = 0; // 连接+认证成功：退避归零
      _nextDelayFloorMs = 0;
      _scheduledReconnectDelay = null;
      _startKeepalive();
    } else {
      _stopKeepalive();
    }
    _onStateChange?.call(state, paired);
  }
}

/// ZCode 请求错误（错误帧）。[data] 为 error.data 原文——companion x/*
/// 族把可读分类放在 data.reason（见 protocol.js 约定），分类必须读这里，
/// 不许对 message 做字符串嗅探。
class ZcodeRequestException implements Exception {
  final int code;
  final String message;
  final Map<String, dynamic>? data;
  const ZcodeRequestException(this.code, this.message, [this.data]);

  /// error.data.reason 快捷读取（缺省 null）
  String? get reason => data?['reason']?.toString();

  @override
  String toString() => 'ZcodeRequestException($code): $message';
}
