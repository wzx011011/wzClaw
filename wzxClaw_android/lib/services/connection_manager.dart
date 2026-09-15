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

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/app_config.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../models/ws_message.dart';
import '../zcode/zcode_pairing.dart';
import '../zcode/zcode_model_heal.dart';
import '../models/goal_snapshot.dart';
import 'pairing_store.dart';
import 'phone_session_index.dart';
import 'session_sync_service.dart';
import 'ws_transport.dart';
import '../zcode/zcode_relay_client.dart';
import 'zcode_protocol_translate.dart';

class ConnectionManager with WidgetsBindingObserver implements WsTransport {
  ConnectionManager._() {
    WidgetsBinding.instance.addObserver(this);
  }

  static final ConnectionManager _instance = ConnectionManager._();
  static ConnectionManager get instance => _instance;

  /// 仅测试使用：构造独立实例（生产走 [instance] 单例）
  @visibleForTesting
  static ConnectionManager createForTest() => ConnectionManager._();

  /// 仅测试使用：注入给内部 ZcodeRelayClient 的连接工厂
  ///（null = 生产直连）。测试借此计数建连、扮演 relay 服务端。
  @visibleForTesting
  static WebSocketChannel Function(Uri url)? debugSocketFactory;

  // ---- 对外流（签名与 f25b231 一致）----

  final StreamController<WsConnectionState> _stateController =
      StreamController<WsConnectionState>.broadcast();
  @override
  Stream<WsConnectionState> get stateStream => _stateController.stream;

  final StreamController<WsMessage> _messageController =
      StreamController<WsMessage>.broadcast();
  Stream<WsMessage> get messageStream => _messageController.stream;
  @override
  Stream<WsMessage> get incoming => _messageController.stream;

  final StreamController<String?> _errorController =
      StreamController<String?>.broadcast();
  Stream<String?> get errorStream => _errorController.stream;

  final StreamController<List<DesktopInfo>> _desktopsController =
      StreamController<List<DesktopInfo>>.broadcast();
  Stream<List<DesktopInfo>> get desktopsStream => _desktopsController.stream;

  String? _selectedDesktopId;
  @override
  String? get selectedDesktopId => _selectedDesktopId;

  final StreamController<String?> _selectedDesktopIdController =
      StreamController<String?>.broadcast();
  @override
  Stream<String?> get selectedDesktopIdStream => _selectedDesktopIdController.stream;

  bool get desktopOnline => _desktops.any((d) => d.online);
  Stream<bool> get desktopOnlineStream =>
      _desktopsController.stream.map((list) => list.isNotEmpty);

  String? get desktopIdentity {
    final sid = _pairing?.sid;
    final d = _desktops.where((d) => d.desktopId == sid).firstOrNull ??
        (_desktops.any((d) => d.online) ? _desktops.firstWhere((d) => d.online) : null);
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

  @override
  WsConnectionState get state => _stateNow;

  // ---- 内部状态 ----

  final List<DesktopInfo> _desktops = [];
  ZcodeRelayClient? _client;
  ZcodePairingInfo? _pairing;
  String? _desktopName;
  String? _wsKey;
  String? _wsPath;
  /// 用户显式切换的工作区（workspaceKey）；null = 未选，取最新活跃组
  String? _selectedWsKey;
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
    final name = _paramOf(url, 'name');
    _desktopName = name;
    _selectedWsKey = null; // 新连接重置选中态，取最新活跃工作区为默认
    _pairing = ZcodePairingInfo(
      relayWsUrl: parsed.relayWsUrl,
      sid: parsed.sid,
      hash: parsed.hash,
      desktopName: (name == null || name.isEmpty) ? null : name,
    );
    // 多配对：入库并设为活动桌面（持久化失败不阻断连接）
    unawaited(PairingStore.instance.upsert(_pairing!));
    _connectPairing();
  }

  void _connectPairing() {
    final pairing = _pairing;
    if (pairing == null) return;
    // 防御性关闭：任何路径到达这里都不得遗留旧 client——泄漏的旧连接既把
    // 同一份推送流重复投进消息流（正文交错重复渲染），又占着 relay 的
    // probe 槽（重连风暴下 3 槽打满触发 CAPACITY 拒绝）
    _client?.close();
    _setState(WsConnectionState.connecting);
    final client = ZcodeRelayClient(
      pairing: pairing,
      socketFactory: debugSocketFactory,
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
        // 多配对：列表常驻，仅当前桌面标记离线（relay 可达、桌面不在）
        unawaited(_refreshDesktopList());
        _setState(WsConnectionState.connecting);
        _messageController.add(const WsMessage(
          event: 'system:no_desktop',
          data: {'error': '桌面端不在线，等待其连接…'},
        ),);
        break;
      case ZcodeRelayState.closed:
        unawaited(_refreshDesktopList());
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
    _selectedDesktopId = pairing.sid;
    _selectedDesktopIdController.add(pairing.sid);
    unawaited(_refreshDesktopList());
  }

  int _listGen = 0;

  /// 由配对存储重建桌面列表：全部已保存配对常驻，
  /// 当前配对按连接状态标在线（matched），其余离线。
  Future<void> _refreshDesktopList() async {
    final gen = ++_listGen;
    final stored = await PairingStore.instance.loadAll();
    if (gen != _listGen) return; // 过期响应：期间已有新刷新
    final isCurrentOnline = _stateNow == WsConnectionState.connected;
    _desktops
      ..clear()
      ..addAll([
        for (final sp in stored)
          DesktopInfo(
            desktopId: sp.info.sid,
            name: (sp.info.sid == _pairing?.sid && _desktopName != null)
                ? _desktopName
                : (sp.info.desktopName ?? '桌面 ZCode'),
            platform: 'zcode',
            connectedAt: sp.addedAt,
            online: isCurrentOnline && sp.info.sid == _pairing?.sid,
          ),
      ]);
    _desktopsController.add(List.from(_desktops));
  }

  /// 外部触发的列表刷新（landing 初始化等）
  Future<void> refreshDesktops() => _refreshDesktopList();

  /// 切换到已保存的某台桌面并连接；未找到返回 false
  Future<bool> connectToStored(String sid) async {
    final stored = await PairingStore.instance.loadAll();
    final hit = stored.where((s) => s.info.sid == sid).firstOrNull;
    if (hit == null) return false;
    disconnect();
    _desktopName = hit.info.desktopName;
    _selectedWsKey = null;
    _pairing = hit.info;
    unawaited(PairingStore.instance.setActiveSid(sid));
    _connectPairing();
    return true;
  }

  /// 删除已保存配对；删的是当前连接的桌面时先断开
  Future<void> removePairing(String sid) async {
    if (sid == _pairing?.sid && _client != null) disconnect();
    await PairingStore.instance.remove(sid);
    await _refreshDesktopList();
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
      // 回合边界/会话加载 → 延迟刷新目标快照（todos 在回合中会变化，
      // 引擎无独立 todo 推送；去抖避免一次回合内反复拉取）
      if (_goalRefreshPendingEvents.contains(e.event)) {
        _scheduleGoalRefresh();
      }
    }
    // state.updated：缓存 workspace（session/create 复用）+ 真实权限模式
    if (method == 'state.updated' && frame.params is Map) {
      _cacheWorkspace(frame.params as Map);
      _cacheMode(frame.params as Map);
    }
  }

  /// 触发 goal 快照刷新的事件（回合边界 + 会话加载完成）
  static const _goalRefreshPendingEvents = {
    'stream:agent:turn_end',
    'session:load:response',
  };

  Timer? _goalRefreshTimer;
  void _scheduleGoalRefresh() {
    _goalRefreshTimer?.cancel();
    _goalRefreshTimer = Timer(const Duration(milliseconds: 800), () {
      final sid = SessionSyncService.instance.activeSessionId;
      if (sid != null && sid.isNotEmpty) {
        unawaited(refreshGoalState(sid));
      }
    });
  }

  /// 拉取目标快照并广播：
  /// 1) 旧 `todo:updated` 事件（ChatStore 现有 Todo 面板直接点亮，零 UI 改动）
  /// 2) `zcode:goal:snapshot` 事件（GoalStore 面板消费，含 groups/stats）
  Future<void> refreshGoalState(String sessionId) async {
    try {
      final result = await _requireClient().request('session/goal', {
        'sessionId': sessionId,
      });
      final snapshot = parseGoalSnapshot(result);
      _messageController.add(WsMessage(
          event: WsEvents.goalSnapshot,
          data: {'sessionId': sessionId, 'snapshot': snapshot},),);
      if (snapshot.todos.isNotEmpty) {
        _messageController.add(WsMessage(event: 'todo:updated', data: {
          'sessionId': sessionId,
          'todos': [for (final t in snapshot.todos) t.toLegacyTodo()],
        },),);
      }
    } catch (e) {
      // 会话未在本进程 materialize 等场景返回错误：静默（面板显示空态）
      debugPrint('[ConnectionManager] goal snapshot failed: $e');
    }
  }

  /// 子智能体线程（悬浮窗"智能体"板块）。引擎参数 schema 实测只接受
  /// {action:'show'}（带 sessionId 反而报 action 非法），作用于本进程
  /// 最近 materialize 的会话——手机驱动场景即当前会话。
  Future<List<SubagentThread>> fetchSubagentThreads() async {
    try {
      final result = await _requireClient()
          .request('session/subagents', {'action': 'show'});
      return parseSubagentThreads(result);
    } catch (e) {
      debugPrint('[ConnectionManager] subagents fetch failed: $e');
      return const [];
    }
  }

  ZcodeRelayClient _requireClient() {
    final c = _client;
    if (c == null) throw StateError('relay not connected');
    return c;
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

  @override
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
        String? error;
        try {
          final r = await client.request('session/send', {
            'sessionId': sessionId,
            'content': content,
          });
          if (r is String) {
            // 字符串 result = 业务拒绝；仅「模型不可用」类走自愈，
            // 其他按原文提示，不擅自改桌面端会话配置
            error =
                r.contains('模型') ? await _healModelAndResend(client, sessionId, content, r) : r;
          } else {
            await client.request('session/subscribe', {
              'sessionId': sessionId,
              'deliveryKind': 'web-remote-replayable',
            });
          }
        } catch (e) {
          if (e is ZcodeRequestException &&
              (e.code == -32031 || e.message.contains('模型'))) {
            error = await _healModelAndResend(client, sessionId, content, e.message);
          } else {
            error = '发送失败: $e';
          }
        }
        if (error != null) {
          _messageController.add(WsMessage(
            event: 'stream:agent:error',
            data: {'sessionId': sessionId, 'error': error},
          ),);
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

      case 'workspace:list:request':
        await _respondWorkspaceList(client, d['requestId']?.toString() ?? '');
        return;

      case 'workspace:switch:request':
        await _respondWorkspaceSwitch(client, d);
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
            },),);
            return;
          }
        }
        _messageController.add(WsMessage(
          event: 'permission:mode:response',
          data: {
            'requestId': d['requestId'] ?? '',
            'mode': _serverToUiMode[_serverModeNow] ?? uiMode ?? 'always-ask',
          },
        ),);
        return;

      case 'permission:get_mode:request':
        _messageController.add(WsMessage(
          event: 'permission:mode:response',
          data: {
            'requestId': d['requestId'] ?? '',
            'mode': _serverToUiMode[_serverModeNow] ?? 'always-ask',
          },
        ),);
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
      case 'file:tree:request':
      case 'file:read:request':
        return;
    }
  }

  /// 「模型已不可用」自愈：resume 现取可用模型（桥内无模型缓存），
  /// setModel → close → resume → 重发的共享尾段见 zcode_model_heal.dart。
  /// 返回 null = 已恢复（订阅由本方法补发）；否则返回给用户的错误文案。
  Future<String?> _healModelAndResend(
      ZcodeRelayClient client, String sessionId, String content, String reason,) async {
    try {
      final resume = await client.request('session/resume', {'sessionId': sessionId});
      final settings = resume is Map ? resume['settings'] as Map? : null;
      final modelCfg = settings?['model'] as Map?;
      final available = modelCfg?['available'] as List? ?? const [];
      Map? ref;
      for (final item in available) {
        final r = item is Map ? item['ref'] as Map? : null;
        if (r is Map && r['providerId'] is String && r['modelId'] is String) {
          ref = r;
          break;
        }
      }
      if (ref == null) return '发送失败：$reason（当前无可用模型，请检查桌面端登录状态）';
      final error = await zcodeSetModelResend(
        request: client.request,
        sessionId: sessionId,
        content: content,
        providerId: ref['providerId'] as String,
        modelId: ref['modelId'] as String,
        reason: reason,
      );
      if (error == null) {
        await client.request('session/subscribe', {
          'sessionId': sessionId,
          'deliveryKind': 'web-remote-replayable',
        });
      }
      return error;
    } catch (_) {
      return '发送失败：$reason';
    }
  }

  Future<void> _respondList(ZcodeRelayClient client, String requestId) async {
    try {
      final result = await client.request('session/list');
      // 按工作区分组：选中组优先（未选=最新活跃组），响应顶层带该工作区
      // 的 path/name 且只含其会话——旧 UI 的会话列表/工作区卡片依赖此语义
      final groups = groupSessionsByWorkspace(result);
      final selected = resolveWorkspace(groups, _selectedWsKey);
      if (selected != null) {
        _wsKey = selected.key;
        _wsPath = selected.path;
      }
      _messageController.add(sessionListWsResponse(requestId, groups, _selectedWsKey));
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '获取会话列表失败: $e',
      },),);
    }
  }

  /// 旧 workspace:list：app-server 无独立工作区接口，由 session/list 聚合
  Future<void> _respondWorkspaceList(ZcodeRelayClient client, String requestId) async {
    try {
      final result = await client.request('session/list');
      final groups = groupSessionsByWorkspace(result);
      _messageController.add(workspaceListWsResponse(requestId, groups));
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '获取工作区列表失败: $e',
      },),);
    }
  }

  /// 旧 workspace:switch：引擎全局会话、cwd 不可切换——切换是客户端过滤
  /// 语义。命中即记录选中组、应答成功并推送该工作区的会话列表刷新 UI。
  Future<void> _respondWorkspaceSwitch(
      ZcodeRelayClient client, Map<String, dynamic> d,) async {
    final requestId = d['requestId']?.toString() ?? '';
    final target = d['workspacePath']?.toString() ?? '';
    try {
      final result = await client.request('session/list');
      final groups = groupSessionsByWorkspace(result);
      final hit = resolveWorkspace(groups, target);
      if (hit == null) {
        _messageController.add(WsMessage(event: 'workspace:switch:response', data: {
          'requestId': requestId,
          'success': false,
          'error': '未找到工作区: $target',
        },),);
        return;
      }
      _selectedWsKey = hit.key;
      _wsKey = hit.key;
      _wsPath = hit.path;
      // Option A：用户显式切换工作区 → 记入本地每设备记忆，新建会话复用
      final sid = _pairing?.sid ?? '';
      if (sid.isNotEmpty) {
        unawaited(PhoneSessionIndex.instance
            .setDeviceWorkspace(sid, hit.key, hit.path),);
      }
      _messageController.add(WsMessage(event: 'workspace:switch:response', data: {
        'requestId': requestId,
        'success': true,
        'workspacePath': hit.path,
        'workspaceName': workspaceBasename(hit.path),
      },),);
      // 切换后立即推送新工作区的会话列表（旧 UI 依赖推送刷新抽屉/首页）
      _messageController
          .add(sessionListWsResponse('$requestId-list', groups, hit.key));
    } catch (e) {
      _messageController.add(WsMessage(event: 'workspace:switch:response', data: {
        'requestId': requestId,
        'success': false,
        'error': '切换工作区失败: $e',
      },),);
    }
  }

  Future<void> _respondLoad(ZcodeRelayClient client, Map<String, dynamic> d) async {
    final requestId = d['requestId']?.toString() ?? '';
    final sessionId = d['sessionId'] as String? ?? '';
    if (sessionId.isEmpty) {
      _messageController.add(WsMessage(
        event: 'session:error',
        data: {'requestId': requestId, 'error': '缺少会话 ID'},
      ),);
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
        ),);
      }
      // 会话加载完成 → 拉一次目标快照（悬浮窗"进程"板块随会话就绪）
      _scheduleGoalRefresh();
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'sessionId': sessionId,
        'error': e is ZcodeRequestException && e.code == -32004
            ? '该会话正在桌面端运行，手机端暂无法查看'
            : '加载会话失败: $e',
      },),);
    }
  }

  Future<void> _respondCreate(ZcodeRelayClient client, Map<String, dynamic> d) async {
    final requestId = d['requestId']?.toString() ?? '';
    final sid = _pairing?.sid ?? '';
    // 工作区解析顺序（Option A）：连接期间缓存 → 手机本地每设备记忆
    // → 一次 session/list 发现（发现结果回写本地记忆，之后不再拉）
    if (_wsKey == null || _wsPath == null) {
      final remembered = await PhoneSessionIndex.instance.workspaceFor(sid);
      if (remembered != null) {
        _wsKey = remembered.workspaceKey;
        _wsPath = remembered.workspacePath;
      }
    }
    if (_wsKey == null || _wsPath == null) {
      try {
        final result = await client.request('session/list');
        final selected = resolveWorkspace(groupSessionsByWorkspace(result), _selectedWsKey);
        if (selected != null) {
          _wsKey = selected.key;
          _wsPath = selected.path;
        }
      } catch (_) {}
    }
    if (_wsKey == null || _wsPath == null) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '没有可用工作区，请先打开一个会话',
      },),);
      return;
    }
    try {
      final result = await client.request('session/create', {
        'workspace': {'workspaceKey': _wsKey, 'workspacePath': _wsPath},
      });
      // 记住本设备工作区：下次新建会话免发现
      if (sid.isNotEmpty) {
        unawaited(PhoneSessionIndex.instance
            .setDeviceWorkspace(sid, _wsKey!, _wsPath!),);
      }
      final events = responseToWsMessages('session/create', result, const {});
      for (final e in events) {
        _messageController.add(WsMessage(
          event: e.event,
          data: {'requestId': requestId, ...?e.data},
        ),);
      }
    } catch (e) {
      _messageController.add(WsMessage(event: 'session:error', data: {
        'requestId': requestId,
        'error': '新建会话失败: $e',
      },),);
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

  // cFSC 互斥标志：入口守卫（状态检查）到 _connectPairing 之间隔着两个
  // await，并发触发（回前台双触发）会双双穿过得各自建连——互斥标志挡住
  // 同入口重入，两个 await 之后再复查状态挡住跨入口（点按桌面切换）穿插
  bool _restoringConfig = false;

  Future<void> connectFromSavedConfiguration() async {
    if (_stateNow != WsConnectionState.disconnected || _restoringConfig) return;
    _restoringConfig = true;
    try {
      final stored = await PairingStore.instance.loadAll();
      // await 窗口内状态可能已被其它入口改变（回前台双触发、点按桌面切换）。
      // 不复查会把窗口内新建的 client 无 close 覆盖——正是上面注释里的泄漏源
      if (_stateNow != WsConnectionState.disconnected) return;
      if (stored.isNotEmpty) {
        final active = await PairingStore.instance.activeSid();
        if (_stateNow != WsConnectionState.disconnected) return;
        final hit = stored.where((s) => s.info.sid == active).firstOrNull ??
            stored.first;
        _desktopName = hit.info.desktopName;
        _selectedWsKey = null;
        _pairing = hit.info;
        _connectPairing();
        return;
      }
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
    } finally {
      _restoringConfig = false;
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
      } else {
        // Android 后台期间定时器被冻结、链路多半已被回收，而客户端还挂着
        // matched 状态：立即校验活性，死链当场断开走快速重连，不再干等
        // 下一个保活周期（最长 45s）才暴露断线
        _client?.verifyAlive();
      }
    }
  }

  void disconnect() {
    _client?.close();
    _client = null;
    _sendQueue.clear();
    _selectedDesktopId = null;
    _selectedDesktopIdController.add(null);
    for (final w in _reverseWaiters.values) {
      if (!w.isCompleted) w.completeError(StateError('disconnected'));
    }
    _reverseWaiters.clear();
    _pendingReverse.clear();
    _setState(WsConnectionState.disconnected);
    unawaited(_refreshDesktopList());
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
