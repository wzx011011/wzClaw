// ============================================================
// connection_manager — ZCode 连接唯一 owner
//
// 唯一创建并关闭 ZcodeRelayClient（主连接及短时在线 probe），负责配对切换、
// 重连、状态流和通用 x/* 请求。PairingStore 是唯一配对持久化；收到的
// app-server 帧经 attach/ingest 投给单例 ZcodeChatStore。
// ============================================================

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../zcode/zcode_pairing.dart';
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_keepalive_controller.dart';
import 'pairing_store.dart';
import 'pairing_url.dart';
import '../zcode/zcode_relay_client.dart';

class ConnectionManager {
  ConnectionManager._() {
    // 保活判定的链路数据源注入（依赖倒置：controller 不反向 import 本类）
    ZcodeKeepAliveController.linkedProvider =
        () => _stateNow != WsConnectionState.disconnected;
  }

  static final ConnectionManager _instance = ConnectionManager._();
  static ConnectionManager get instance => _instance;

  /// 连接代次：每次新建或断开 client 递增。多步操作（附件分块/下载分块/
  /// git 两步查询）开始时固定请求入口、以代次校验存活——切换节点后旧操作
  /// 绝不允许动态借用新连接（架构审查 P1-2）。
  int _generation = 0;
  int get connectionGeneration => _generation;

  /// 多步操作专用：返回绑定当前连接的请求入口；未连接/未配对返回 null
  /// （调用方回退原路径自然报错）。绑定后整个操作周期走同一 client，
  /// 代次漂移（切节点/重连）即抛 StateError 终止操作。
  Future<dynamic> Function(String method, [Map<String, dynamic>? params])?
      boundRequester() {
    final client = _client;
    final generation = _generation;
    if (client == null ||
        _stateNow != WsConnectionState.connected ||
        !client.paired) {
      return null;
    }
    Future<dynamic> bound(String method, [Map<String, dynamic>? params]) async {
      if (_generation != generation) {
        throw StateError('节点已切换，多步操作终止');
      }
      if (!client.paired) throw StateError('节点连接已断开，操作终止');
      return client.request(method, params);
    }

    return bound;
  }

  /// 仅测试使用：构造独立实例（生产走 [instance] 单例）
  @visibleForTesting
  static ConnectionManager createForTest() => ConnectionManager._();

  /// 仅测试使用：注入给内部 ZcodeRelayClient 的连接工厂
  ///（null = 生产直连）。测试借此计数建连、扮演 relay 服务端。
  @visibleForTesting
  static WebSocketChannel Function(Uri url)? debugSocketFactory;

  /// 仅测试使用：注入 client 替身并递增代次（boundRequester 契约测试用；
  /// 与真实路径一致：每次 attach 都代表一次新连接 = 新代次）
  @visibleForTesting
  void debugAttachClient(ZcodeRelayClient client) {
    _client?.close();
    _generation++;
    _client = client;
    _stateNow = WsConnectionState.connected;
  }

  // ---- 对外流（签名与 f25b231 一致）----

  final StreamController<WsConnectionState> _stateController =
      StreamController<WsConnectionState>.broadcast();
  Stream<WsConnectionState> get stateStream => _stateController.stream;

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
  Stream<String?> get selectedDesktopIdStream =>
      _selectedDesktopIdController.stream;

  bool get desktopOnline => _desktops.any((d) => d.online);
  Stream<bool> get desktopOnlineStream =>
      _desktopsController.stream.map((list) => list.isNotEmpty);

  String? get desktopIdentity {
    final sid = _pairing?.sid;
    final d = _desktops.where((d) => d.desktopId == sid).firstOrNull ??
        (_desktops.any((d) => d.online)
            ? _desktops.firstWhere((d) => d.online)
            : null);
    final name = d?.name;
    return (name != null && name.isNotEmpty) ? name : null;
  }

  /// f25b231 UI 契约：最近一次连接错误（同步读）
  String? lastError;

  /// f25b231 UI 契约：当前桌面列表（同步读）
  List<DesktopInfo> get desktops => List.unmodifiable(_desktops);

  Stream<String?> get desktopIdentityStream =>
      _desktopsController.stream.map((_) => desktopIdentity);

  WsConnectionState get state => _stateNow;

  // ---- 内部状态 ----

  final List<DesktopInfo> _desktops = [];
  ZcodeRelayClient? _client;
  ZcodePairingInfo? _pairing;
  String? _desktopName;
  WsConnectionState _stateNow = WsConnectionState.disconnected;

  // ---- 连接 ----

  /// [url] 为配对链接：https://host/pair?sid=..&hash=..（&name=.. 可选）
  Future<bool> connect(String url) async {
    final parsed = parsePairingUrlAny(url);
    if (parsed == null) {
      lastError = '连接地址无效：请使用配对链接';
      _errorController.add(lastError!);
      _setState(WsConnectionState.disconnected);
      return false;
    }
    disconnect();
    final name = _paramOf(url, 'name');
    _desktopName = name;
    _pairing = ZcodePairingInfo(
      relayWsUrl: parsed.relayWsUrl,
      sid: parsed.sid,
      hash: parsed.hash,
      desktopName: (name == null || name.isEmpty) ? null : name,
    );
    try {
      await PairingStore.instance.upsert(_pairing!);
      await PairingStore.instance.setActiveSid(parsed.sid);
    } catch (e) {
      lastError = '保存配对失败: $e';
      _errorController.add(lastError!);
      _pairing = null;
      return false;
    }
    _connectPairing();
    return true;
  }

  void _connectPairing() {
    final pairing = _pairing;
    if (pairing == null) return;
    // 防御性关闭：任何路径到达这里都不得遗留旧 client——泄漏的旧连接既把
    // 同一份推送流重复投进消息流（正文交错重复渲染），又占着 relay 的
    // probe 槽（重连风暴下 3 槽打满触发 CAPACITY 拒绝）
    _client?.close();
    _generation++; // 新连接 = 新代次（在途多步操作的绑定入口随即失效）
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
    // R1 换接线桥：连接交给直连栈供帧（聊天数据源正在切换 ZcodeChatStore，
    // 见 .planning/PLAN-chat-rewire.md）。翻译层暂留喂工作区/标题数据源
    // （SessionSyncService），R1 收尾即零消费方，R3 删除。
    ZcodeChatStore.instance.attach(
      client,
      desktopId: pairing.sid,
      desktopName: _desktopName ?? pairing.desktopName ?? '桌面 ZCode',
    );
    client.connect();
  }

  void _onZcodeState(ZcodeRelayState s, bool paired) {
    // 换接线桥：relay 状态同步进直连栈（matched 触发其自动拉会话列表、
    // 掉线触发其在途反向请求作废）
    ZcodeChatStore.instance.ingestRelayState(s, paired);
    switch (s) {
      case ZcodeRelayState.matched:
        if (_stateNow != WsConnectionState.connected) {
          _setState(WsConnectionState.connected);
          _emitDesktopOnline();
        }
        break;
      case ZcodeRelayState.waiting:
        // 多配对：列表常驻，仅当前桌面标记离线（relay 可达、桌面不在）
        unawaited(_refreshDesktopList());
        _setState(WsConnectionState.connecting);
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

  // ---- 入站：引擎通知帧 → 直连栈 ----

  void _onZcodeNotify(ZcodeFrame frame) {
    // 换接线桥：引擎通知帧原样投递直连栈（store 自行按帧归属路由）
    ZcodeChatStore.instance.ingestNotifyFrame(frame);
  }

  Future<dynamic> _onZcodeReverse(ZcodeFrame frame) {
    return ZcodeChatStore.instance.ingestReverseRequest(frame);
  }

  // ---- 出站：纯连接层通用请求通道 ----

  /// 直发 zcode/companion 请求（companion 本地扩展方法 `x/*`：git 分支/
  /// 模型目录/用量等，见 APP-SERVER.md「companion 本地扩展协议」）。
  /// 未连接或未配对时抛 StateError。
  Future<dynamic> zcodeRequest(String method, [Map<String, dynamic>? params]) {
    final client = _client;
    if (client == null ||
        _stateNow != WsConnectionState.connected ||
        !client.paired) {
      throw StateError('未连接桌面');
    }
    return client.request(method, params);
  }

  /// 短连接探测也由连接层创建，页面不直接拥有 ZcodeRelayClient。
  Future<bool> probePairing(
    ZcodePairingInfo pairing, {
    Duration timeout = const Duration(seconds: 6),
  }) async {
    final completer = Completer<bool>();
    late final ZcodeRelayClient probe;
    probe = ZcodeRelayClient(
      pairing: pairing,
      socketFactory: debugSocketFactory,
      onStateChange: (state, paired) {
        if (completer.isCompleted) return;
        if (state == ZcodeRelayState.matched) completer.complete(true);
        if (state == ZcodeRelayState.waiting ||
            state == ZcodeRelayState.closed) {
          completer.complete(false);
        }
      },
    );
    try {
      probe.connect();
      return await completer.future.timeout(timeout, onTimeout: () => false);
    } catch (e) {
      debugPrint('[connection] 桌面在线探测失败: $e');
      return false;
    } finally {
      probe.close();
    }
  }

  // ---- 桌面选择（单桌面语义：保留 API 兼容，无路由作用）----

  void selectDesktop(String? desktopId) {
    _selectedDesktopId = desktopId;
    _selectedDesktopIdController.add(desktopId);
  }

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
        _pairing = hit.info;
        _connectPairing();
      }
    } catch (e) {
      _errorController.add('恢复连接配置失败: $e');
    } finally {
      _restoringConfig = false;
    }
  }

  void handleLifecycleState(AppLifecycleState state) {
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
    _generation++; // 断开 = 新代次（在途多步操作的绑定入口随即失效）
    ZcodeChatStore.instance.detach();
    _selectedDesktopId = null;
    _selectedDesktopIdController.add(null);
    _setState(WsConnectionState.disconnected);
    unawaited(_refreshDesktopList());
  }

  void dispose() {
    disconnect();
    _stateController.close();
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
