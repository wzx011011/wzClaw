// ============================================================
// connection_manager — 连接管理（换芯版）
//
// 【壳】类名/单例/公开签名与 f25b231 完全一致——UI、ChatStore、
// SessionSyncService 只依赖 WsTransport 接口与本类公开成员，零改动。
//
// 【芯】旧实现（旧 relay 子协议/token 鉴权/心跳超时/离线队列/多桌面
// 路由）整体废弃。内部 = ZcodeRelayClient（HMAC 认证 + 保活 ping +
// 指数退避重连，经 198 项测试打磨）+ 翻译层（app-server 帧 ↔ 旧
// WsEvents 事件形状）。
//
// 对上层伪装：
// - messageStream 产出旧事件形状（stream:agent:* / session:*:response），
//   ChatStore 的事件处理逻辑零改动
// - desktopsStream 产出单"桌面"（配对的大脑节点）
// - connect() 接受配对链接（https://host/pair?sid=..&hash=..&name=..），
//   凭据持久化于 server_url（配对链接原文）
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_config.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../models/ws_message.dart';
import '../zcode/zcode_pairing.dart';
import 'ws_transport.dart';
import '../zcode/zcode_relay_client.dart';
import 'zcode_protocol_translate.dart';

class ConnectionManager with WidgetsBindingObserver implements WsTransport {
  ConnectionManager._() {
    WidgetsBinding.instance.addObserver(this);
  }

  static final ConnectionManager _instance = ConnectionManager._();
  static ConnectionManager get instance => _instance;

  // ---- 对外流（签名与 f25b231 一致）----

  final StreamController<WsConnectionState> _stateController =
      StreamController<WsConnectionState>.broadcast();
  Stream<WsConnectionState> get stateStream => _stateController.stream;

  final StreamController<WsMessage> _messageController =
      StreamController<WsMessage>.broadcast();
  Stream<WsMessage> get messageStream => _messageController.stream;
  Stream<WsMessage> get incoming => _messageController.stream;

  final StreamController<String?> _errorController =
      StreamController<String?>.broadcast();
  Stream<String?> get errorStream => _errorController.stream;

  final StreamController<List<DesktopInfo>> _desktopsController =
      StreamController<List<DesktopInfo>>.broadcast();
  Stream<List<DesktopInfo>> get desktopsStream => _desktopsController.stream;

  String? _selectedDesktopId;
  String? get selectedDesktopId => _selectedDesktopId;

  final StreamController<String?> _selectedDesktopIdController =
      StreamController<String?>.broadcast();
  Stream<String?> get selectedDesktopIdStream => _selectedDesktopIdController.stream;

  bool get desktopOnline => _desktops.isNotEmpty;
  Stream<bool> get desktopOnlineStream =>
      _desktopsController.stream.map((list) => list.isNotEmpty);

  String? get desktopIdentity {
    final d = _desktops.isNotEmpty ? _desktops.last : null;
    final name = d?.name;
    return (name != null && name.isNotEmpty) ? name : null;
  }

  /// f25b231 UI 契约：最近一次连接错误（同步读）
  String? lastError;

  /// f25b231 UI 契约：当前桌面列表（同步读）
  List<DesktopInfo> get desktops => List.unmodifiable(_desktops);

  /// f25b231 UI 契约：后台保活开关（前台服务由 App 生命周期模块接管，
  /// 新链路客户端自带保活 ping——保留 API 兼容，仅记录偏好）
  Future<void> setBackgroundKeepAliveEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('background_keepalive_enabled', enabled);
  }

  Stream<String?> get desktopIdentityStream =>
      _desktopsController.stream.map((_) => desktopIdentity);

  WsConnectionState get state => _stateNow;

  // ---- 内部状态 ----

  final List<DesktopInfo> _desktops = [];
  ZcodeRelayClient? _client;
  ZcodePairingInfo? _pairing;
  String? _desktopName;
  String? _wsKey;
  String? _wsPath;
  WsConnectionState _stateNow = WsConnectionState.disconnected;
  final List<_QueueEntry> _sendQueue = [];
  final Map<String, ReverseRequestInfo> _pendingReverse = {};
  final Map<String, Completer<dynamic>> _reverseWaiters = {};

  // ---- 连接 ----

  /// [url] 为配对链接：https://host/pair?sid=..&hash=..（&name=.. 可选）
  void connect(String url) {
    final parsed = parsePairingUrlAny(url);
    if (parsed == null) {
      lastError = '连接地址无效：请使用配对链接';
      _errorController.add(lastError!);
      _setState(WsConnectionState.disconnected);
      return;
    }
    disconnect();
    _desktopName = _paramOf(url, 'name');
    _pairing = ZcodePairingInfo(
      relayWsUrl: parsed.relayWsUrl,
      sid: parsed.sid,
      hash: parsed.hash,
    );
    _connectPairing();
  }

  void _connectPairing() {
    final pairing = _pairing;
    if (pairing == null) return;
    _setState(WsConnectionState.connecting);
    final client = ZcodeRelayClient(
      pairing: pairing,
      onStateChange: _onZcodeState,
      onNotify: _onZcodeNotify,
      onRequest: _onZcodeReverse,
      onRelayError: (code, message) {
        _errorController.add('中继拒绝（$code）：$message');
      },
    );
    _client = client;
    client.connect();
  }

  void _onZcodeState(ZcodeRelayState s, bool paired) {
    switch (s) {
      case ZcodeRelayState.matched:
        if (_stateNow != WsConnectionState.connected) {
          _setState(WsConnectionState.connected);
          _emitDesktopOnline();
          _flushQueue();
        }
        break;
      case ZcodeRelayState.waiting:
        _desktops.clear();
        _desktopsController.add([]);
        _setState(WsConnectionState.connecting);
        _messageController.add(const WsMessage(
          event: 'system:no_desktop',
          data: {'error': '桌面端不在线，等待其连接…'},
        ));
        break;
      case ZcodeRelayState.closed:
        _desktops.clear();
        _desktopsController.add([]);
        _setState(WsConnectionState.disconnected);
        break;
      case ZcodeRelayState.idle:
      case ZcodeRelayState.connecting:
      case ZcodeRelayState.authenticating:
        _setState(WsConnectionState.connecting);
        break;
    }
  }

  void _emitDesktopOnline() {
    final pairing = _pairing;
    if (pairing == null) return;
    _desktops
      ..clear()
      ..add(DesktopInfo(
        desktopId: pairing.sid,
        name: _desktopName ?? '桌面 ZCode',
        platform: 'zcode',
        connectedAt: DateTime.now().millisecondsSinceEpoch,
      ));
    _selectedDesktopId = pairing.sid;
    _selectedDesktopIdController.add(pairing.sid);
    _desktopsController.add(List.from(_desktops));
  }

  // ---- 入站：通知 → 旧事件 ----

  void _onZcodeNotify(ZcodeFrame frame) {
    final method = frame.method ?? '';
    final events = translateNotification(method, frame.params, _registerReverse);
    for (final e in events) {
      // permission.resolved（超时/桌面已答）：清待答表；旧协议无对应
      // 事件不下发，UI 卡片由超时兜底/用户点击自然清除
      if (e.event == 'stream:agent:permission_resolved') {
        final d = e.data is Map ? e.data as Map : const {};
        final rid = (d['requestId'] ?? d['toolCallId'])?.toString();
        if (rid != null && rid.isNotEmpty) _pendingReverse.remove(rid);
        continue;
      }
      _messageController.add(e);
    }
    // state.updated：缓存 workspace（session/create 复用）+ 真实权限模式
    if (method == 'state.updated' && frame.params is Map) {
      _cacheWorkspace(frame.params as Map);
      _cacheMode(frame.params as Map);
    }
  }

  void _registerReverse(ReverseRequestInfo info, WsMessage event) {
    final d = event.data is Map ? event.data as Map : const {};
    final key = (d['questionId'] ?? d['toolCallId'] ?? '').toString();
    if (key.isNotEmpty) _pendingReverse[key] = info;
  }

  /// 反向请求（权限/AskUser）→ 旧事件；应答由 ChatStore 的
  /// respondToPermission/respondToAskUser 发 'permission:response'
  /// 触发回传（_dispatchReverseAck 完成挂起的 future）
  Future<dynamic> _onZcodeReverse(ZcodeFrame frame) {
    final method = frame.method ?? '';
    final completer = Completer<dynamic>();
    final events = translateNotification(
      method,
      {'id': frame.id, 'method': method, 'params': frame.params},
      _registerReverse,
    );
    for (final e in events) {
      _messageController.add(e);
    }
    _reverseWaiters[frame.id.toString()] = completer;
    // 与 companion 的权限超时档对齐（120s）：companion 代答 -32022 给
    // 服务端后不会通知手机——此处兜底 complete，防止 waiter/UI 永久滞留
    final frameId = frame.id;
    Timer(const Duration(seconds: 120), () {
      final w = _reverseWaiters.remove(frameId.toString());
      if (w != null && !w.isCompleted) {
        w.completeError(TimeoutException('permission timeout'));
      }
    });
    return completer.future;
  }

  void _flushReverseAck(dynamic frameId, Map<String, dynamic> payload) {
    final waiter = _reverseWaiters.remove(frameId.toString());
    if (waiter == null || waiter.isCompleted) return;
    if (payload.containsKey('error')) {
      waiter.completeError(StateError('用户拒绝'));
    } else {
      waiter.complete(payload['result']);
    }
  }

  // ---- 出站：旧事件 → app-server 请求（编排）----

  void send(WsMessage message, {int priority = 0}) {
    final client = _client;
    if (client == null || _stateNow != WsConnectionState.connected || !client.paired) {
      _enqueue(message, priority);
      return;
    }
    unawaited(_dispatch(message, client));
  }

  void _enqueue(WsMessage message, int priority) {
    if (_sendQueue.length >= AppConfig.maxQueueSize) {
      _sendQueue.removeLast();
    }
    final entry = _QueueEntry(message.toJsonString(), priority);
    final idx = _sendQueue.indexWhere((e) => e.priority < priority);
    if (idx == -1) {
      _sendQueue.add(entry);
    } else {
      _sendQueue.insert(idx, entry);
    }
  }

  void _flushQueue() {
    // 头部排空（FIFO；队列头高尾低 → 高优先级先发、同优先级按入队顺序）
    while (_sendQueue.isNotEmpty) {
      final entry = _sendQueue.removeAt(0);
      final client = _client;
      if (client == null) break;
      try {
        final decoded = jsonDecode(entry.json);
        if (decoded is Map<String, dynamic>) {
          unawaited(_dispatch(WsMessage.fromJson(decoded), client));
        }
      } catch (_) {}
    }
  }

  Future<void> _dispatch(WsMessage message, ZcodeRelayClient client) async {
    final d = message.data is Map
        ? Map<String, dynamic>.from(message.data as Map)
        : <String, dynamic>{};
    switch (message.event) {
      case 'command:send':
        final sessionId = d['sessionId'] as String?;
        final content = d['content'] as String? ?? '';
        if (sessionId == null || sessionId.isEmpty || content.isEmpty) return;
        try {
          final r = await client.request('session/send', {
            'sessionId': sessionId,
            'content': content,
          });
          if (r is String) {
            _messageController.add(WsMessage(
              event: 'stream:agent:error',
              data: {'sessionId': sessionId, 'error': r},
            ));
            return;
          }
          await client.request('session/subscribe', {
            'sessionId': sessionId,
            'deliveryKind': 'web-remote-replayable',
          });
        } catch (e) {
          _messageController.add(WsMessage(
            event: 'stream:agent:error',
            data: {'sessionId': sessionId, 'error': '发送失败: $e'},
          ));
        }
        return;

      case 'command:stop':
        final sessionId = d['sessionId'] as String?;
        if (sessionId != null && sessionId.isNotEmpty) {
          try {
            await client.request('session/stop', {'sessionId': sessionId});
          } catch (_) {}
        }
        return;

      case 'session:list:request':
        await _respondList(client, d['requestId']?.toString() ?? '');
        return;

      case 'session:load:request':
        await _respondLoad(client, d);
        return;

      case 'session:create:request':
        await _respondCreate(client, d);
        return;

      case 'permission:response':
      case 'ask-user:answer':
        _dispatchReverseAck(message, d);
        return;

      case 'permission:set_mode:request':
        final sessionId = d['sessionId'] as String?;
        final uiMode = d['mode'] as String?;
        final serverMode = _uiToServerMode[uiMode] ?? uiMode;
        if (sessionId != null && serverMode != null) {
          try {
            await client.request('session/setMode', {
              'sessionId': sessionId,
              'mode': serverMode,
            });
            _serverModeNow = serverMode; // 乐观更新，权威以快照回填
          } catch (e) {
            _messageController.add(WsMessage(event: 'permission:mode:response', data: {
              'requestId': d['requestId'] ?? '',
              'error': '设置模式失败: $e',
            }));
            return;
          }
        }
        _messageController.add(WsMessage(
          event: 'permission:mode:response',
          data: {
            'requestId': d['requestId'] ?? '',
            'mode': _serverToUiMode[_serverModeNow] ?? uiMode ?? 'always-ask',
          },
        ));
        return;

      case 'permission:get_mode:request':
        _messageController.add(WsMessage(
          event: 'permission:mode:response',
          data: {
            'requestId': d['requestId'] ?? '',
            'mode': _serverToUiMode[_serverModeNow] ?? 'always-ask',
          },
        ));
        return;

      // 旧 relay 控制语义：新链路无对应，吞掉
      case 'identity:announce':
      case 'identity:mobile_announce':
      case 'target:select':
      case 'target:clear':
      case 'ping':
      case 'pong':
      case 'session:rename:request':
      case 'session:delete:request':
      case 'session:clear:request':
      case 'workspace:list:request':
      case 'workspace:switch:request':
      case 'file:tree:request':
      case 'file:read:request':
        return;
    }
  }

  Future<void> _respondList(ZcodeRelayClient client, String requestId) async {
    try {
      final result = await client.request('session/list');
      // 定型路径缓存 workspace（APP-SERVER.md：sessions[].workspace.
      // {workspaceKey,workspacePath}）——盲搜仅作兜底
      if (result is Map && result['sessions'] is List) {
        for (final s0 in (result['sessions'] as List).whereType<Map>()) {
          final ws = s0['workspace'];
          if (ws is Map && ws['workspaceKey'] != null && ws['workspacePath'] != null) {
            _wsKey = ws['workspaceKey'].toString();
            _wsPath = ws['workspacePath'].toString();
            break;
          }
        }
      }
      final events = responseToWsMessages('session/list', result, const {});
      for (final e in events) {
        _messageController.add(WsMessage(
          event: e.event,
          data: {'requestId': requestId, ...?e.data},
        ));
      }
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '获取会话列表失败: $e',
      }));
    }
  }

  Future<void> _respondLoad(ZcodeRelayClient client, Map<String, dynamic> d) async {
    final requestId = d['requestId']?.toString() ?? '';
    final sessionId = d['sessionId'] as String? ?? '';
    if (sessionId.isEmpty) {
      _messageController.add(WsMessage(
        event: 'session:error',
        data: {'requestId': requestId, 'error': '缺少会话 ID'},
      ));
      return;
    }
    try {
      final resume = await client.request('session/resume', {'sessionId': sessionId});
      if (resume is Map) {
        _cacheWorkspace(resume);
        _cacheMode(resume);
      }
      await client.request('session/subscribe', {
        'sessionId': sessionId,
        'deliveryKind': 'web-remote-replayable',
      });
      // resume 响应自带全量 messages（companion 已按帧上限截尾并打
      // messagesTruncated 标记）——直接使用，省一次同量级重拉
      final events = resume is Map && (resume['messages'] is List)
          ? responseToWsMessages('session/messages', resume, const {})
          : await (() async {
              final messages = await client.request('session/messages', {
                'sessionId': sessionId,
                'limit': 200,
              });
              return responseToWsMessages('session/messages', messages, const {});
            }());
      for (final e in events) {
        _messageController.add(WsMessage(
          event: e.event,
          data: {'requestId': requestId, 'sessionId': sessionId, ...?e.data},
        ));
      }
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'sessionId': sessionId,
        'error': e is ZcodeRequestException && e.code == -32004
            ? '该会话正在桌面端运行，手机端暂无法查看'
            : '加载会话失败: $e',
      }));
    }
  }

  Future<void> _respondCreate(ZcodeRelayClient client, Map<String, dynamic> d) async {
    final requestId = d['requestId']?.toString() ?? '';
    if (_wsKey == null || _wsPath == null) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '没有可用工作区，请先打开一个会话',
      }));
      return;
    }
    try {
      final result = await client.request('session/create', {
        'workspace': {'workspaceKey': _wsKey, 'workspacePath': _wsPath},
      });
      final events = responseToWsMessages('session/create', result, const {});
      for (final e in events) {
        _messageController.add(WsMessage(
          event: e.event,
          data: {'requestId': requestId, ...?e.data},
        ));
      }
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '新建会话失败: $e',
      }));
    }
  }

  void _dispatchReverseAck(WsMessage message, Map<String, dynamic> d) {
    final key = (d['requestId'] ?? d['questionId'] ?? d['toolCallId'] ?? '').toString();
    final info = _pendingReverse.remove(key);
    if (info == null) return;
    final approved = message.event == 'permission:response'
        ? d['approved'] == true
        : (d['selectedLabels'] is List && (d['selectedLabels'] as List).isNotEmpty);
    if (message.event == 'permission:response') {
      // 应答 = 所选 option 的 response 原文（APP-SERVER.md 实测：其它形状
      // 一律被服务端静默按 deny 处理）。旧 UI 无 remember 开关 → allow_once。
      final result = _pickPermissionResponse(info, approved);
      _flushReverseAck(info.frameId, {'result': result});
      return;
    }
    if (approved) {
      _flushReverseAck(info.frameId, {'result': d});
    } else {
      _flushReverseAck(info.frameId, {
        'error': {'code': -32000, 'message': '用户拒绝'},
      });
    }
  }

  /// 从权限请求暂存的 options 里回放所选 option 的 response 原文；
  /// 无暂存时按实测 schema 兜底构造（一次性批准，permissionUpdates 无法
  /// 凭空构造故不提供 remember 语义）
  Map<String, dynamic> _pickPermissionResponse(ReverseRequestInfo info, bool approved) {
    final options = info.permissionOptions;
    if (options != null) {
      final wanted = approved ? 'allow_once' : 'deny';
      for (final o in options) {
        if (o['optionId']?.toString() == wanted) {
          final response = o['response'];
          if (response is Map) return Map<String, dynamic>.from(response);
        }
      }
    }
    return {
      'decision': approved ? 'allow' : 'deny',
      'reason': approved ? 'Approved once' : 'Denied',
    };
  }

  /// 服务端权限模式真实值（state.updated patch.mode.current，实测字段）。
  /// UI 词表 ↔ 服务端枚举映射（语义最近对应，非完全等价）：
  /// always-ask→build（默认执行+权限拦截）、accept-edits→edit、
  /// plan→plan、bypass→yolo；auto 显示回落 build 档。
  static const _uiToServerMode = {
    'always-ask': 'build',
    'accept-edits': 'edit',
    'plan': 'plan',
    'bypass': 'yolo',
  };
  static const _serverToUiMode = {
    'plan': 'plan',
    'edit': 'accept-edits',
    'yolo': 'bypass',
    'build': 'always-ask',
    'auto': 'always-ask',
  };
  String? _serverModeNow;

  void _cacheMode(Map node) {
    dynamic mode;
    void search(Map n, int depth) {
      if (depth > 4 || mode != null) return;
      // state.updated 补丁形状：mode:{current:...}
      final m = n['mode'];
      if (m is Map && m['current'] != null) {
        mode = m['current'];
        return;
      }
      for (final v in n.values) {
        if (v is Map) search(v, depth + 1);
      }
    }

    search(node, 0);
    if (mode != null) _serverModeNow = mode.toString();
  }

  void _cacheWorkspace(Map node) {
    dynamic key;
    dynamic path;
    void search(Map n, int depth) {
      if (depth > 4) return;
      key ??= n['workspaceKey'];
      path ??= n['workspacePath'];
      for (final v in n.values) {
        if (v is Map) search(v, depth + 1);
      }
    }

    search(node, 0);
    if (key != null && path != null) {
      _wsKey = key.toString();
      _wsPath = path.toString();
    }
  }

  // ---- 桌面选择（单桌面语义：保留 API 兼容，无路由作用）----

  void selectDesktop(String? desktopId) {
    _selectedDesktopId = desktopId;
    _selectedDesktopIdController.add(desktopId);
  }

  void clearDesktopSelection() => selectDesktop(null);

  // ---- 生命周期 ----

  Future<void> connectFromSavedConfiguration() async {
    if (_stateNow != WsConnectionState.disconnected) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final serverUrl = prefs.getString('server_url');
      if (serverUrl == null || serverUrl.isEmpty) return;
      if (parsePairingUrlAny(serverUrl) == null) {
        _errorController.add('保存的连接配置不是有效的配对链接，请在设置中重新配置');
        return;
      }
      connect(serverUrl);
    } catch (e) {
      _errorController.add('恢复连接配置失败: $e');
    }
  }

  Future<void> wakeAndReconnect(String reason) async {
    debugPrint('[ConnectionManager] wakeAndReconnect: $reason');
    await connectFromSavedConfiguration();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 保活/重连由 ZcodeRelayClient 自理（ping + 指数退避）；
    // 前台唤醒时仅在断线状态下触发一次配置恢复
    if (state == AppLifecycleState.resumed) {
      if (_stateNow == WsConnectionState.disconnected) {
        unawaited(connectFromSavedConfiguration());
      }
    }
  }

  void disconnect() {
    _client?.close();
    _client = null;
    _sendQueue.clear();
    _desktops.clear();
    _desktopsController.add([]);
    _selectedDesktopId = null;
    _selectedDesktopIdController.add(null);
    for (final w in _reverseWaiters.values) {
      if (!w.isCompleted) w.completeError(StateError('disconnected'));
    }
    _reverseWaiters.clear();
    _pendingReverse.clear();
    _setState(WsConnectionState.disconnected);
  }

  void dispose() {
    disconnect();
    _stateController.close();
    _messageController.close();
    _errorController.close();
    _desktopsController.close();
    _selectedDesktopIdController.close();
  }

  void _setState(WsConnectionState s) {
    _stateNow = s;
    _stateController.add(s);
  }

  String? _paramOf(String url, String name) {
    try {
      return Uri.parse(url).queryParameters[name];
    } catch (_) {
      return null;
    }
  }
}

class _QueueEntry {
  final String json;
  final int priority;
  const _QueueEntry(this.json, this.priority);
}
