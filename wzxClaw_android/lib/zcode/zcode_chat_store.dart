// ============================================================
// zcode_chat_store — ZCode 远程控制状态管理（ChangeNotifier）
//
// 【契约文件】类签名是并行开发公共契约，实现者补全，公共 API 不得改动。
//
// 职责：配对持久化、会话列表、当前会话消息、流式渲染。
// 消息模型复用 models/chat_message.dart（与现有聊天 UI 兼容）。
//
// P1.2 同步层重构（对照 relay/zcode/APP-SERVER.md「同步层协议实测
// （第二轮）」与 .planning/PLAN-zcode-remote-v2.md）：
// - 每会话状态容器（ZcodeSessionState）：消息、eventId 去重、seq
//   水位、订阅与回合状态；_activeSessionId 退化为视口指针；
// - epoch 失效：切换/关闭递增纪元，在途异步结果携带发起时
//   (sessionId, epoch)，不匹配即丢弃——多会话乱串由构造杜绝；
// - 按帧归属路由：所有入站帧按自带 sessionId 路由到对应容器（含
//   后台会话）；订阅在 materialize 时建立、切走不移除；
// - 推送渲染：session/subscribe(web-remote-replayable) 的
//   session/event 帧，model.streaming 的 payload.delta 直渲染；
//   turn.completed 本地收尾（纯文本回合免权威刷新），工具回合仍走
//   权威刷新；断线从 last-seq 重订阅补放；轮询保留为降级路径；
// - 本地持久缓存（ZcodeSessionCache，SQLite）：每会话消息 + seq
//   水位，App 重启秒开；打开会话先出缓存 → resume 激活但忽略其
//   messages 数组（实测全量可达 26MB）→ session/read 轻量 meta +
//   session/messages {limit} 拉尾部 → 上滑从缓存翻页；
// - 增量权威刷新：turn 结束后 session/messages {afterMessageId:
//   水位} 只拉新增合并，替代每次重建 200 条；
// - 模型兜底：session/send 的「模型已不可用」拒绝有两种送达形态
//   （真机实测）——字符串 result 与错误帧 -32031；可用模型缓存来自
//   state.updated 补丁 + resume/read 的 settings.model.available；
//   setModel 实测只接受对象 {providerId, modelId}（字符串被 -32602
//   拒绝）；历史模型下线的旧会话 setModel 救不回（重发仍 -32031），
//   兜底失败提示用户新建会话。
//
// U2 协议实测轮（对照 relay/zcode/APP-SERVER.md「分页契约实测」「工具
// 回合实测」，探针 probe-sync3.js / probe-toolturn.js）：
// - session/messages 分页：{limit} 返回最新 N 条、升序；{afterMessageId,
//   limit} 返回游标后缀的最新 N 条、升序；time.created 为毫秒。
//   _normalizeChronological 按升序主路径处理（降序投票仅作异常兜底）。
// - 权限确认反向请求：method=interaction/requestPermission，params 带
//   input/reason/requestId/riskLevel/options/toolCallId/toolName/turnId；
//   应答 result = 所选 option 的 response 原文（{decision, reason,
//   permissionUpdates?}）——畸形 result 会被服务端静默判 deny。
// - 权威消息 tool part：{callID（大写 D）, tool:字符串, state:{status,
//   input, output|error, time}}。
// - restore() 已配对时转发 reconnect()（会话列表页"重连"按钮修复 #20）。
//
// 权限确认 / AskUser 通过客户端 onRequest 钩子接入（实现不变；
// AskUser 类反向请求实测未触发，解析/应答仍为兜底形状）。
//
// 【接线状态】本 store 目前无页面直接引用（消费方仅 ZcodeDesktopRegistry
// 与 keepalive 控制器，测试覆盖完整）——当前聊天 UI 走 services/
// chat_store（ConnectionManager 换芯路径）。本模块是 zcode 聊天页的
// 目标栈，随该页落地接线（同见 zcode_desktop_registry.restore 注释）。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat_message.dart';
import 'zcode_desktop_registry.dart';
import 'zcode_model_heal.dart';
import 'zcode_notifier.dart';
import 'zcode_pairing.dart';
import 'zcode_relay_client.dart';
import 'zcode_reverse_models.dart';
import 'zcode_session_cache.dart';
import 'zcode_session_state.dart';

/// 配对持久化 key（shared_preferences）
const String _kPairingPrefsKey = 'wzxclaw-zcode-pairing';

/// 流式轮询间隔（降级路径：推送不可用时才启用）
const Duration _kPollInterval = Duration(milliseconds: 1200);

/// 打开会话时拉取的尾部消息条数（session/messages limit）
const int _kTailLimit = 40;

/// 增量权威刷新的单页条数
const int _kIncrementalLimit = 200;

/// 增量刷新单次最多连续翻页数（防方向误判/超长会话拉爆）
const int _kMaxIncrementalPages = 10;

/// 缓存尾窗读取条数（略大于尾部窗口，上滑有货）
const int _kCacheTailLimit = 80;

/// 连接状态
enum ZcodeConnState { idle, connecting, waiting, matched }

/// ZCode 会话元信息（session/list 条目）
class ZcodeSessionMeta {
  final String sessionId;
  final String title;
  final int updatedAt;
  final String? workspaceKey;
  final String? workspacePath;

  /// 会话运行状态徽标（session/list / state.updated 的 status）
  final String? status;

  const ZcodeSessionMeta({
    required this.sessionId,
    required this.title,
    required this.updatedAt,
    this.workspaceKey,
    this.workspacePath,
    this.status,
  });
}

/// 可用模型条目（resume/subscribe/state.updated 快照 settings.model.available）
/// 实测条目形状：{ref:{providerId,modelId}, label, contextWindow,
/// maxOutputTokens, reasoning, providerLabel}
class ZcodeModelInfo {
  final String providerId;
  final String modelId;
  final String? label;
  final String? providerLabel;
  final int? contextWindow;
  final int? maxOutputTokens;
  final bool reasoning;

  const ZcodeModelInfo({
    required this.providerId,
    required this.modelId,
    this.label,
    this.providerLabel,
    this.contextWindow,
    this.maxOutputTokens,
    this.reasoning = false,
  });

  /// 'providerId/modelId' 引用形态（setModel 兜底同款）
  String get ref => '$providerId/$modelId';

  /// UI 显示名：优先 label，退回 modelId
  String get displayName => (label != null && label!.isNotEmpty) ? label! : modelId;
}

/// 会话切换/关闭/解除配同时对挂起反向请求的代答拒绝：
/// 客户端据此回传 **error 帧**（而非 result 帧），与无钩子路径的
/// 安全拒绝一致，避免"存在 result"被对端解读为批准
class ZcodeReverseRejectException implements Exception {
  final String reason;
  const ZcodeReverseRejectException(this.reason);

  @override
  String toString() => reason;
}

/// 待应答的反向请求（权限 / AskUser）
///
/// completer 的 future 由客户端持有：完成时客户端把结果作为响应帧回传
/// （响应帧带原反向请求 id），因此这里缓存 frameId ↔ toolCallId/questionId。
class _PendingReverse {
  final dynamic frameId; // 反向请求帧 id（形如 "server-N"）
  final Completer<dynamic> completer;

  _PendingReverse({required this.frameId, required this.completer});
}

/// ZCode 远程控制 store
class ZcodeChatStore extends ChangeNotifier {
  /// 全局单例（app 作用域）：多桌面模式下指向注册表的活动实例
  /// （ZcodeDesktopRegistry 切换桌面即换指针，页面零改动）。
  /// 本地通知初始化由注册表构造统一完成。
  static ZcodeChatStore get instance => ZcodeDesktopRegistry.instance.activeStore;

  /// 注册表专用：构造独立实例（非全局单例）
  factory ZcodeChatStore.detached() => ZcodeChatStore._raw(null, null);

  /// 无注入参数时返回全局单例；注入测试替身时构造全新实例
  factory ZcodeChatStore({
    ZcodeRelayClient? client, // 测试注入
    ZcodeSessionCache? cache, // 测试注入（缓存替身）
  }) =>
      (client == null && cache == null)
          ? instance
          : ZcodeChatStore._raw(client, cache);

  ZcodeChatStore._raw(
    ZcodeRelayClient? client,
    ZcodeSessionCache? cache,
  )   : _injectedClient = client,
        _injectedCache = cache;

  /// 注入的测试替身（真机路径为 null，pair/restore 时构造真客户端）
  final ZcodeRelayClient? _injectedClient;
  final ZcodeSessionCache? _injectedCache;

  ZcodeRelayClient? _client;
  ZcodeSessionCache? _cacheInst;

  /// 惰性缓存实例（注入替身优先）
  ZcodeSessionCache get _cache =>
      _cacheInst ??= _injectedCache ?? ZcodeSessionCache();

  // ---- 全局状态 ----
  ZcodePairingInfo? _pairing;
  ZcodeConnState _connState = ZcodeConnState.idle;
  String? _error;

  // ---- 多桌面身份（由 ZcodeDesktopRegistry 维护）----

  /// 本 store 归属的桌面 id（= 配对 sid；轮换换码时由注册表迁移）
  String? desktopId;

  /// 桌面显示名（通知标题、切换器展示用）
  String desktopName = '桌面';

  /// 配对成功回调（注册表同步条目：sid 轮换迁移 / 临时实例转正）
  void Function(String pairingUrl)? onPaired;

  /// 解绑回调（绕过注册表的 unpair 同步删条目）
  void Function()? onUnpaired;

  List<ZcodeSessionMeta> _sessions = [];
  bool _sessionsLoading = false;
  bool _sessionsAutoLoaded = false;

  // ---- 视口与每会话容器 ----

  /// 视口纪元：切换/关闭递增；在途异步操作携带发起时纪元，不匹配即丢弃
  int _epoch = 0;

  /// 视口指针（退化为指向 _states 中某个容器的引用）
  String? _activeSessionId;

  /// 每会话状态容器（含后台会话；按帧归属路由）
  final Map<String, ZcodeSessionState> _states = {};

  /// 已知可用模型（state.updated 全量快照缓存；setModel 兜底用）
  final List<String> _availableModels = [];

  /// 结构化模型目录（settings.model.available 全元数据；模型选择器数据源）
  final List<ZcodeModelInfo> _modelCatalog = [];

  /// 当前会话选中模型（settings.model.current，'providerId/modelId'）
  String? _currentModelRef;

  /// 当前思考强度（乐观值；setThoughtLevel 设置，快照回填覆盖）
  String? thoughtLevel;

  /// 降级轮询（仅视口会话；推送不可用时启用）
  Timer? _fallbackPollTimer;
  String? _fallbackPollSessionId;

  /// 推送看门狗（一次性）：订阅成功但推送静默失效时拉起降级轮询。
  /// 场景：app-server 在 relay 连接保持的情况下重启丢失订阅状态
  /// ——订阅请求不再重发、没有任何断线事件，仅表现为流式"冻住"。
  Timer? _pushWatchdogTimer;

  /// 看门狗延迟（默认 3 个轮询周期无任何推送帧即判失效；测试可调）
  @visibleForTesting
  Duration pushWatchdogDelay = const Duration(milliseconds: 3600);

  // ---- 权限确认 / AskUser ----
  final StreamController<PermissionRequest?> _permissionController =
      StreamController<PermissionRequest?>.broadcast();
  final StreamController<AskUserQuestion?> _askUserController =
      StreamController<AskUserQuestion?>.broadcast();
  PermissionRequest? _activePermission;
  AskUserQuestion? _activeAskUser;

  /// 待应答反向请求：toolCallId / questionId → 挂起的 completer
  final Map<String, _PendingReverse> _pendingReverse = {};

  /// 权限请求的原始 options（实测形状：应答需回所选 option 的 response
  /// 原文，"记住"语义 = allow_project 选项的 response 携带 permissionUpdates，
  /// 只有请求方才知道其内容——解析时按 toolCallId 暂存，应答后清除）
  final Map<String, List<Map>> _permissionOptions = {};

  // ──────────────────────────────────────────────
  // 状态 getter（notifyListeners 驱动 UI）
  // ──────────────────────────────────────────────

  ZcodePairingInfo? get pairing => _pairing;

  ZcodeConnState get connState => _connState;

  String? get error => _error;

  List<ZcodeSessionMeta> get sessions => _sessions;

  /// 结构化模型目录（模型选择器数据源；快照播种，可能为空）
  List<ZcodeModelInfo> get modelCatalog => List.unmodifiable(_modelCatalog);

  /// 当前会话选中模型（'providerId/modelId'；未知为 null）
  String? get currentModelRef => _currentModelRef;

  bool get sessionsLoading => _sessionsLoading;

  String? get activeSessionId => _activeSessionId;

  /// 视口消息（当前会话容器的快照；无活动会话为空列表）
  List<ChatMessage> get messages =>
      _activeState?.chatMessages ?? const <ChatMessage>[];

  bool get isStreaming => _activeState?.isStreaming ?? false;

  /// 当前视口会话是否正被桌面端应用运行（-32004；ChatPage 显示状态条用）
  bool get remoteActiveElsewhere =>
      _activeState?.remoteActiveElsewhere ?? false;

  bool get isWaitingForResponse => _activeState?.isWaitingForResponse ?? false;

  /// 当前回合的 thinking 内容（流式 reasoning 拼接；回合结束清空）。
  /// ChatMessage 模型没有 thinking 字段，与 services/chat_store 一致由
  /// store 层管理渲染状态。
  String get thinkingContent => _activeState?.thinkingContent ?? '';

  /// 当前会话的权限模式（plan|build|edit|yolo|auto；null = 未知）
  String? get sessionMode => _activeState?.mode;

  /// 视口会话是否正在打开（未 materialize 且无缓存内容）——
  /// ChatPage 骨架屏判定用（派生态，不引入新状态字段）
  bool get sessionOpening {
    final state = _activeState;
    return state != null && !state.materialized && state.items.isEmpty;
  }

  /// 当前待处理的权限请求（供 UI 渲染权限条）
  PermissionRequest? get activePermission => _activePermission;

  /// 当前待处理的 AskUser 问题（供 UI 渲染问题条）
  AskUserQuestion? get activeAskUser => _activeAskUser;

  /// 权限请求流（null 表示清除当前请求）
  Stream<PermissionRequest?> get permissionStream =>
      _permissionController.stream;

  /// AskUser 问题流（null 表示清除当前问题）
  Stream<AskUserQuestion?> get askUserStream => _askUserController.stream;

  /// 通知器（单例，测试可注入替身）
  ZcodeNotifier get _notifier => ZcodeNotifier.instance;

  /// 视口当前指向的容器
  ZcodeSessionState? get _activeState =>
      _activeSessionId == null ? null : _states[_activeSessionId!];

  /// 视口是否正指向该容器
  bool _isActive(ZcodeSessionState state) =>
      state.sessionId == _activeSessionId;

  /// 视口有效性：异步操作完成时校验（sessionId + 纪元均匹配才生效）
  bool _viewportValid(String sessionId, int epoch) =>
      _activeSessionId == sessionId && _epoch == epoch;

  /// 取（或创建）会话容器
  ZcodeSessionState _stateFor(String sessionId) =>
      _states.putIfAbsent(sessionId, () => ZcodeSessionState(sessionId));

  /// 仅视口会话变化时通知（后台会话更新不打扰当前视口）
  void _notifyIfActive(ZcodeSessionState state) {
    if (_isActive(state)) notifyListeners();
  }

  // ──────────────────────────────────────────────
  // 配对
  // ──────────────────────────────────────────────

  /// 从配对 URL 配对（解析失败返回 false 并设置 error）；持久化并连接
  bool pair(String pairingUrl) {
    final info = parsePairingUrl(pairingUrl);
    if (info == null) {
      _error = '配对链接无效，请重新扫码';
      notifyListeners();
      return false;
    }
    _pairing = info;
    _error = null;
    notifyListeners();
    unawaited(_persistPairing(info));
    _attachClient();
    // 通知注册表（sid 轮换迁移 / 临时实例转正）
    onPaired?.call(pairingUrl);
    return true;
  }

  /// 解除配对（清持久化 + 断开；本地缓存保留，重配对后可复用）
  void unpair() {
    // 外部供帧模式下解绑归宿主（ConnectionManager/注册表）负责：
    // store 若在此关闭/清理，会把宿主还在用的连接一并拆掉
    if (_externallyFed) {
      debugPrint('[zcode-store] 外部供帧模式下收到 unpair，忽略（解绑由宿主负责）');
      return;
    }
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client?.close();
    _client = null;
    _pairing = null;
    _connState = ZcodeConnState.idle;
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _states.clear();
    _availableModels.clear();
    _modelCatalog.clear();
    _currentModelRef = null;
    // 会话级运行时快照一并清掉：残留会让下一次配对直接复用旧桌面的
    // 工作区/思考强度（旧桌面可能已不在线或路径已变）
    thoughtLevel = null;
    _defaultWorkspaceKey = null;
    _defaultWorkspacePath = null;
    _resumeTitle = _resumeWsKey = _resumeWsPath = null;
    _error = null;
    notifyListeners();
    unawaited(_clearPersistedPairing());
    // 通知注册表同步删条目（registry.remove 路径会先置空本回调防重入）
    onUnpaired?.call();
  }

  /// 启动时恢复已保存的配对（自动重连）；**已配对时不早退**——转发到
  /// [reconnect] 显式重连（会话列表页"重连"按钮复用本入口；修复 #20：
  /// 此前 `_pairing != null` 早退使已配对状态下按钮永远无效）
  Future<void> restore() async {
    // 外部供帧模式：连接由宿主建立并转发，store 不得自建第二条连接
    // （同一配对双连接会触发 relay 接管互踢）
    if (_externallyFed) return;
    if (_pairing != null) {
      await reconnect();
      return;
    }
    final ZcodePairingInfo? saved;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_kPairingPrefsKey);
      if (raw == null || raw.isEmpty) return;
      final decoded = jsonDecode(raw);
      saved = ZcodePairingInfo.fromJson(
        decoded is Map ? decoded.cast<String, dynamic>() : null,
      );
    } catch (e) {
      // 持久化损坏：按未配对处理，但必须留观测——用户会看到「明明配过对
      // 却要求重新扫码」，没有这条日志就无法定位是 prefs 被谁写坏了
      debugPrint('[zcode-store] 配对持久化损坏，按未配对处理: $e');
      return;
    }
    if (saved == null) return;
    _pairing = saved;
    _connState = ZcodeConnState.connecting;
    notifyListeners();
    _attachClient();
    // 连接稳定后自动拉一次会话列表（注入替身时 paired 立即为真）
    await refreshSessions();
  }

  /// 显式重连：丢弃旧客户端（连同其内部重连退避/半开连接）重建连接并
  /// 刷新会话列表。未配对时为 no-op（保持 restore 启动恢复语义不变）。
  /// 旧客户端关闭触发 `_onRelayStateChange(disconnected)`，新客户端
  /// matched 后 `_resubscribeAll` 会为已物化会话重订阅补放。
  Future<void> reconnect() async {
    // 外部供帧模式：重连归宿主完成（relay 状态经 ingestRelayState 转入），
    // 这里只兜底刷新会话列表，绝不自建连接
    if (_externallyFed) {
      await refreshSessions();
      return;
    }
    final info = _pairing;
    if (info == null) return; // 未配对：无事可做
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _connState = ZcodeConnState.connecting;
    notifyListeners();
    _attachClient(); // 内部关闭旧客户端（非注入替身）并重建
    await refreshSessions();
  }

  /// 构造/挂载客户端：测试注入的替身直接使用；真机路径用 pairing 构造
  void _attachClient() {
    final info = _pairing;
    if (info == null) return;
    _stopFallbackPolling();

    if (_injectedClient != null) {
      _client = _injectedClient;
      _client!.connect();
      _connState = _relayStateToConn(_client!.currentState, _client!.paired);
    } else {
      // 旧客户端（重复配对时）先关掉
      final old = _client;
      if (old != null && old != _injectedClient) old.close();
      _client = ZcodeRelayClient(
        pairing: info,
        onStateChange: _onRelayStateChange,
        onNotify: _handleNotifyFrame,
        // 反向请求（权限确认 / AskUser）交给 store 路由到对应 UI 流
        onRequest: _handleReverseRequest,
        // relay 拒绝（配对失效/被顶号等）上浮到错误横幅
        onRelayError: (code, message) {
          _error = '中继拒绝（$code）：$message；若持续出现请解除配对后重新扫码';
          notifyListeners();
        },
      )..connect();
      _connState = ZcodeConnState.connecting;
    }
    notifyListeners();
  }

  // ── 外部供帧（R1 换接线桥）──────────────────────
  // R1 期间连接所有权仍在 services/ConnectionManager（配对/设备列表/保活/
  // x/* 扩展请求通道），引擎帧由宿主转发进来：store 不自建连接、不关宿主
  // 客户端、不写配对持久化。终态（R3）连接层定稿后本缝随桥拆除——
  // 见 .planning/PLAN-chat-rewire.md。

  /// 外部供帧模式标记（restore/reconnect/unpair 据此不自管连接生命周期）
  bool _externallyFed = false;

  /// 是否处于外部供帧模式（测试/诊断用）
  @visibleForTesting
  bool get isExternallyFed => _externallyFed;

  /// 宿主把自己的已连接客户端交给 store 供帧：重置会话态（等同换桌面），
  /// 但不 close 任何客户端（生命周期全归宿主）、不写/清配对持久化
  void attachExternal(ZcodeRelayClient client) {
    _externallyFed = true;
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client = client;
    _pairing = null;
    _connState = _relayStateToConn(client.currentState, client.paired);
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _states.clear();
    _error = null;
    notifyListeners();
  }

  /// 解除外部供帧（撤桥用）：store 回到未配对空态，宿主客户端不受影响
  void detachExternal() {
    if (!_externallyFed) return;
    _applyDetachedState();
    notifyListeners();
  }

  void _applyDetachedState() {
    _externallyFed = false;
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client = null;
    _pairing = null;
    _connState = ZcodeConnState.idle;
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _states.clear();
    _availableModels.clear();
    _modelCatalog.clear();
    _currentModelRef = null;
    thoughtLevel = null;
    _defaultWorkspaceKey = null;
    _defaultWorkspacePath = null;
    _resumeTitle = _resumeWsKey = _resumeWsPath = null;
    _error = null;
  }

  /// 宿主转发 relay 状态（配对成功/掉线/重连），语义同自建路径
  void ingestRelayState(ZcodeRelayState state, bool paired) =>
      _onRelayStateChange(state, paired);

  /// 宿主转发引擎通知帧（session/event、state.updated、v4/telemetry 等）
  void ingestNotifyFrame(ZcodeFrame frame) => _handleNotifyFrame(frame);

  /// 宿主转发服务端反向请求（权限 / AskUser；runtimePreferences 已由
  /// ZcodeRelayClient 内部自动代答，不会到达此处）；返回值即
  /// onRequest 契约要回给服务端的应答。同步异常（未知方法安全拒绝）
  /// 统一转为失败 Future，调用方无需 try/catch。
  Future<dynamic> ingestReverseRequest(ZcodeFrame frame) =>
      Future.sync(() => _handleReverseRequest(frame));

  /// relay 状态 → 连接状态映射；配对成功时自动拉一次会话列表，
  /// 重连成功后为所有已物化会话重订阅 + 补放断线期间的事件
  void _onRelayStateChange(ZcodeRelayState state, bool paired) {
    final wasMatched = _connState == ZcodeConnState.matched;
    _connState = _relayStateToConn(state, paired);
    if (paired && !wasMatched) {
      if (!_sessionsAutoLoaded) {
        _sessionsAutoLoaded = true;
        unawaited(refreshSessions());
      }
      unawaited(_resubscribeAll());
    }
    if (!paired) {
      // 重置一次性自动拉取标记：重连 matched 后重新自动刷新会话列表
      _sessionsAutoLoaded = false;
      _stopFallbackPolling();
      // 断线（掉线/被顶号/重连中）即作废全部在途反向请求：链路已更换，
      // app-server 侧 server-N 反向请求 id 会从头复用，迟到应答若带着旧
      // 帧 id 发上新连接，可能命中同 id 的新请求（一次未经确认的批准）。
      // 权限/AskUser 条同步清除——它们已不可能被应答（审查 P0 #2）。
      _clearReverseUi();
      _rejectAllPendingReverse();
    }
    notifyListeners();
  }

  /// 清除权限/AskUser 交互条（断线/作废路径）；控制器已关闭时静默跳过
  void _clearReverseUi() {
    if (_activePermission != null) {
      _activePermission = null;
      if (!_permissionController.isClosed) _permissionController.add(null);
    }
    if (_activeAskUser != null) {
      _activeAskUser = null;
      if (!_askUserController.isClosed) _askUserController.add(null);
    }
  }

  ZcodeConnState _relayStateToConn(ZcodeRelayState state, bool paired) {
    if (paired) return ZcodeConnState.matched;
    switch (state) {
      case ZcodeRelayState.waiting:
        return ZcodeConnState.waiting;
      case ZcodeRelayState.matched:
        return ZcodeConnState.matched;
      case ZcodeRelayState.connecting:
      case ZcodeRelayState.authenticating:
        return ZcodeConnState.connecting;
      case ZcodeRelayState.idle:
      case ZcodeRelayState.closed:
        return ZcodeConnState.idle;
    }
  }

  // ──────────────────────────────────────────────
  // 会话
  // ──────────────────────────────────────────────

  Future<void> refreshSessions() async {
    final client = _client;
    if (client == null || !client.paired) return;
    _sessionsLoading = true;
    notifyListeners();
    try {
      final result = await client.request('session/list');
      final map = result is Map ? result : const {};
      final entries = map['sessions'];
      final metas = <ZcodeSessionMeta>[];
      if (entries is List) {
        for (final e in entries) {
          if (e is! Map) continue;
          final id = e['sessionId']?.toString() ?? '';
          if (id.isEmpty) continue;
          final ws = e['workspace'];
          metas.add(ZcodeSessionMeta(
            sessionId: id,
            title: _nonEmpty(e['title']) ?? '（无标题会话）',
            updatedAt: _toInt(e['updatedAt']),
            workspaceKey: ws is Map ? _nonEmpty(ws['workspaceKey']) : null,
            workspacePath: ws is Map ? _nonEmpty(ws['workspacePath']) : null,
            status: _nonEmpty(e['status']),
          ),);
        }
      }
      _sessions = metas;
      // 记住最近一个带完整 workspace 的会话（新建会话复用）
      for (final s in metas) {
        if (s.workspaceKey != null && s.workspacePath != null) {
          _defaultWorkspaceKey = s.workspaceKey;
          _defaultWorkspacePath = s.workspacePath;
          break;
        }
      }
      _error = null;
    } catch (e) {
      _error = '刷新会话列表失败：$e';
    } finally {
      _sessionsLoading = false;
      notifyListeners();
    }
  }

  /// 复用最近会话的工作区（手机端不知道桌面路径，新建会话时复用）
  String? _defaultWorkspaceKey;
  String? _defaultWorkspacePath;

  /// 当前 openSession 的 resume 快照（session.title / workspace），
  /// 供打开成功后补齐会话列表缺失条目用（见 _upsertOpenedListing）
  String? _resumeTitle;
  String? _resumeWsKey;
  String? _resumeWsPath;

  /// 打开会话（视口切换），加载顺序：
  /// 1. 缓存秒开（SQLite 尾窗，0ms）；
  /// 2. resume 激活（materialize）——**忽略其 messages 数组**
  ///    （实测 resume 响应携带全量消息，可达 26MB）；
  /// 3. session/read 轻量 meta（2–5KB）取运行状态；
  /// 4. session/messages {limit} 拉尾部——实测 {limit} 返回最新 N 条且
  ///    升序（APP-SERVER.md「分页契约实测」），归一兜底保留；
  /// 5. 订阅推送（web-remote-replayable），切走不移除。
  Future<void> openSession(String sessionId) async {
    final client = _client;
    if (client == null || !client.paired) {
      _fail('尚未连接 ZCode，无法打开会话');
      return;
    }
    _epoch++;
    final epoch = _epoch;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _resumeTitle = _resumeWsKey = _resumeWsPath = null;
    _activeSessionId = sessionId;
    final state = _stateFor(sessionId)..epoch = epoch;
    notifyListeners();

    // 1. 缓存秒开（容器为空时；尽力而为，失败静默）
    if (state.items.isEmpty) {
      await _loadFromCache(state);
      if (!_viewportValid(sessionId, epoch)) return; // 期间已切走
      notifyListeners();
    }

    // 2. resume 激活（materialize）——忽略 messages 数组
    Map? resumeResult;
    if (!state.materialized) {
      try {
        final result =
            await client.request('session/resume', {'sessionId': sessionId});
        if (state.epoch != epoch) return; // 旧纪元：丢弃
        resumeResult = result is Map ? result : null;
        _applyResumeMeta(state, resumeResult ?? const {});
        state.remoteActiveElsewhere = false; // 成功激活：清除桌面占用标记
      } catch (e) {
        if (!_viewportValid(sessionId, epoch)) return; // 已切走：不惊动视口
        // 桌面端正在运行该会话（-32004，运行时单归属）：保留空视口 +
        // 明确状态条，而不是报错回列表
        if (e is ZcodeRequestException && e.code == -32004) {
          state.remoteActiveElsewhere = true;
          state.isStreaming = false;
          state.isWaitingForResponse = false;
          _error = '该会话正在桌面端运行中，手机端无法实时查看其流式过程；'
              '桌面端回合结束后点"刷新"查看结果';
          notifyListeners();
          return;
        }
        if (state.items.isEmpty) {
          _activeSessionId = null; // 打开失败：回到列表（旧行为）
          _fail('打开会话失败：$e');
          return;
        }
        // 有缓存内容：留在视口显示缓存 + 错误横幅；若会话已在服务端
        // 消失（被关闭/清理）则退回列表，避免可重复的死胡同
        _fail('打开会话失败（当前显示本地缓存）：$e');
        unawaited(_returnToListIfSessionGone(sessionId, epoch));
        return;
      }
    }

    // 3. 订阅推送（materialize 时建立；失败 → 降级轮询）
    await _ensureSubscribed(state);

    // 4. 轻量 meta（active 会话可用；失败用 resume 的 projection 兜底）
    try {
      final read = await client.request('session/read', {
        'sessionId': sessionId,
      });
      if (state.epoch == epoch && read is Map) _applyReadMeta(state, read);
    } catch (_) {
      // resume 的 projection 已兜底
    }

    // 5. 尾部拉取 + 前向收敛；失败 → 降级用 resume 的 messages 数组
    //   （老路径；大帧由 companion 截断打 messagesTruncated 标记）
    var merged = false;
    try {
      await _fetchTailWindow(state);
      merged = true;
    } catch (_) {
      // 降级路径见下
    }
    if (!merged && resumeResult != null) {
      _mergeServerMessages(state, resumeResult);
      if (resumeResult['messagesTruncated'] == true &&
          state.items.isNotEmpty) {
        state.insertHeadNotice(ChatMessage(
          role: MessageRole.assistant,
          content: '（历史较长，已截断，仅显示最近消息）',
          createdAt: state.items.first.message.createdAt,
        ),);
      }
    }

    // 运行中：推送不可用 → 降级轮询；推送在用 → 武装看门狗
    if (state.isStreaming && !state.pushAvailable) {
      _startFallbackPollingFor(state.sessionId);
    } else if (state.isStreaming) {
      _armPushWatchdog(state);
    }
    _upsertOpenedListing(state);
    unawaited(_persistSession(state));
    if (_viewportValid(sessionId, epoch)) notifyListeners();
  }

  /// resume 失败但有缓存内容时：确认会话是否已从服务端列表消失
  /// （被关闭/清理）——是则退回列表，否则保留缓存视口等用户重试
  Future<void> _returnToListIfSessionGone(String sessionId, int epoch) async {
    final client = _client;
    if (client == null || !client.paired) return;
    try {
      final result = await client.request('session/list');
      final entries = result is Map ? result['sessions'] : null;
      final exists = entries is List &&
          entries.any((e) => e is Map && e['sessionId'] == sessionId);
      if (!exists && _viewportValid(sessionId, epoch)) {
        _activeSessionId = null;
        notifyListeners();
      }
    } catch (_) {
      // 确认失败：保留缓存视口
    }
  }

  /// 新建会话：显式指定 workspace（抽屉分组头"+"）或复用最近会话的
  /// workspace；两者皆无则报错提示
  Future<void> newSession({String? workspaceKey, String? workspacePath}) async {
    final client = _client;
    if (client == null || !client.paired) {
      _fail('尚未连接 ZCode，无法新建会话');
      return;
    }
    final hasExplicit = (workspaceKey?.isNotEmpty ?? false)
        && (workspacePath?.isNotEmpty ?? false);
    // 未显式指定时复用最近会话的 workspace（手机端不知道桌面路径）
    if (!hasExplicit
        && (_defaultWorkspaceKey == null || _defaultWorkspacePath == null)) {
      await refreshSessions(); // 刷一次列表以获得可复用工作区
    }
    final wsKey = hasExplicit ? workspaceKey : _defaultWorkspaceKey;
    final wsPath = hasExplicit ? workspacePath : _defaultWorkspacePath;
    if (wsKey == null || wsKey.isEmpty || wsPath == null || wsPath.isEmpty) {
      _fail('没有可用的工作区，请先在桌面端创建一个会话');
      return;
    }
    try {
      final result = await client.request('session/create', {
        'workspace': {'workspaceKey': wsKey, 'workspacePath': wsPath},
      });
      final session = result is Map ? result['session'] : null;
      final newId = session is Map ? session['sessionId']?.toString() : null;
      if (newId == null || newId.isEmpty) {
        throw const ZcodeRequestException(-32602, '响应缺少 sessionId');
      }
      await refreshSessions();
      await openSession(newId);
    } catch (e) {
      _fail('新建会话失败：$e');
    }
  }

  /// 关闭会话视图回到列表（订阅保留，后台会话继续收事件进缓存）
  void closeSessionView() {
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _activeSessionId = null;
    notifyListeners();
  }

  /// 上滑翻页：从本地缓存加载更早的消息（服务端 afterMessageId 只能
  /// 向新翻页，更早历史由缓存累积提供）。返回本次新增条数。
  Future<int> loadOlderMessages({int limit = 40}) async {
    final state = _activeState;
    if (state == null) return 0;
    try {
      final cached = await _cache.loadTail(
        state.sessionId,
        limit: state.items.length + limit,
      );
      final known = state.items
          .where((e) => e.protoId != null)
          .map((e) => e.protoId!)
          .toSet();
      var added = 0;
      // 缓存按时间序返回：把视口尚未包含的更早消息插入头部
      for (var i = cached.length - 1; i >= 0; i--) {
        final it = cached[i];
        final pid = it.protoId;
        if (pid == null || known.contains(pid)) continue;
        state.items.insert(0, it);
        added++;
      }
      if (added > 0) notifyListeners();
      return added;
    } catch (_) {
      return 0; // 缓存尽力而为
    }
  }

  /// 清除全局错误横幅（UI 关闭按钮用）
  void clearError() {
    if (_error == null) return;
    _error = null;
    notifyListeners();
  }

  /// 清空本地消息缓存（配对与会话列表保留；
  /// 下次打开会话时从服务端重新拉取）。
  /// 内存会话态一并清空：否则已打开会话的消息仍留在内存，
  /// 后续缓存写入会把它们写回 SQLite（清了又复活）。
  /// 活动会话视图随之关闭，需重新 openSession。
  Future<void> clearLocalCache() async {
    await _cache.clearAll();
    _stopFallbackPolling();
    _states.clear();
    _activeSessionId = null;
    notifyListeners();
  }

  /// 设置会话权限模式（session/setMode；plan|build|edit|yolo|auto）。
  /// 乐观更新本地 mode；权威值以 state.updated 的 patch.mode.current
  /// 回填为准（实测 setMode 响应快照口径有差异：设 edit 快照显示 build，
  /// 故不从响应/ projection 播种）。
  Future<bool> setMode(String mode) async {
    const allowed = ['plan', 'build', 'edit', 'yolo', 'auto'];
    if (!allowed.contains(mode)) {
      _fail('未知权限模式：$mode');
      return false;
    }
    final client = _client;
    final state = _activeState;
    if (client == null || state == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    try {
      await client.request('session/setMode', {
        'sessionId': state.sessionId,
        'mode': mode,
      });
      state.mode = mode;
      _notifyIfActive(state);
      return true;
    } catch (e) {
      _fail('设置权限模式失败：$e');
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // 聊天
  // ──────────────────────────────────────────────

  /// 发送消息：本地追加 user 消息 + 流式 assistant 占位，session/send；
  /// 返回字符串 result（业务拒绝）时走 setModel 兜底
  Future<void> sendMessage(String content) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return;
    }
    final text = content.trim();
    if (text.isEmpty) return;
    final state = _stateFor(sessionId);

    // 本地立即追加 user 消息 + 流式 assistant 占位（乐观更新）
    state.finalizeStreaming(); // 终结上一回合的占位（若有）
    state.resetTurnState();
    state.appendLocalUserMessage(text);
    state.ensureStreamingPlaceholder();
    state.isStreaming = true;
    state.isWaitingForResponse = true;
    _error = null;
    notifyListeners();

    try {
      final result = await client.request(
        'session/send',
        {'sessionId': sessionId, 'content': text},
      );
      if (result is String) {
        // 业务拒绝（字符串 result，非 error 帧）。仅"模型不可用"类拒绝
        // （APP-SERVER.md 实测记录的唯一形态）走 setModel 自动兜底；
        // 其他字符串拒绝按原文提示，不擅自改桌面端会话配置
        if (result.contains('模型')) {
          await _handleSendRejection(state, text, result);
        } else {
          state.isStreaming = false;
          state.isWaitingForResponse = false;
          state.finalizeStreaming();
          _notifyIfActive(state);
          _fail('发送失败：$result');
        }
        return;
      }
    } catch (e) {
      // 「模型已不可用」有两种送达形态（真机实测）：字符串 result 与
      // 错误帧 -32031（ZCODE_RUNTIME_MODEL_UNAVAILABLE）——两者都走
      // setModel 兜底
      if (e is ZcodeRequestException &&
          (e.code == -32031 || e.message.contains('模型'))) {
        await _handleSendRejection(state, text, e.message);
        return;
      }
      state.isWaitingForResponse = false;
      state.isStreaming = false;
      state.finalizeStreaming();
      _notifyIfActive(state);
      _fail('发送失败：$e');
      return;
    }
    // 已接受：确保订阅（推送渲染）；推送不可用 → 降级轮询；
    // 推送在用 → 武装看门狗（防订阅静默失效导致流式冻住）
    await _ensureSubscribed(state);
    if (state.isStreaming && !state.pushAvailable && _isActive(state)) {
      _startFallbackPollingFor(state.sessionId);
    } else if (state.isStreaming) {
      _armPushWatchdog(state);
    }
  }

  /// session/send「模型不可用」拒绝（字符串 result 或错误帧 -32031）：
  /// 用缓存的可用模型走共享自愈尾段（zcode_model_heal.dart：setModel →
  /// close → resume 重新物化 → 重发；probe-modelheal4 真链路验证时序，
  /// 只 setModel 重发仍 -32031）——兜底失败提示新建会话
  Future<void> _handleSendRejection(
      ZcodeSessionState state, String text, String reason,) async {
    final client = _client;
    var attempted = false;
    var healError = '发送失败：$reason';
    if (client != null && client.paired && _availableModels.isNotEmpty) {
      final model = _availableModels.first;
      final slash = model.indexOf('/');
      if (slash > 0) {
        attempted = true;
        final error = await zcodeSetModelResend(
          request: client.request,
          sessionId: state.sessionId,
          content: text,
          providerId: model.substring(0, slash),
          modelId: model.substring(slash + 1),
          reason: reason,
        );
        if (error == null) {
          // 已恢复：继续走流式
          _error = null;
          await _ensureSubscribed(state);
          if (state.isStreaming && !state.pushAvailable && _isActive(state)) {
            _startFallbackPollingFor(state.sessionId);
          } else if (state.isStreaming) {
            _armPushWatchdog(state);
          }
          notifyListeners();
          return;
        }
        healError = error;
      }
    }
    state.isStreaming = false;
    state.isWaitingForResponse = false;
    state.finalizeStreaming();
    _notifyIfActive(state);
    _fail(attempted ? healError : '发送失败：$reason');
  }

  /// 停止生成（session/stop + 增量权威刷新）
  Future<void> stopGeneration() async {
    final client = _client;
    final state = _activeState;
    if (client == null || state == null) return;
    try {
      await client.request('session/stop', {'sessionId': state.sessionId});
    } catch (_) {
      // 停止请求失败也继续拉权威消息
    }
    await _refreshAuthoritative(state);
  }

  /// 关闭会话（session/close，协议实测存在）：结束该会话在节点上的运行，
  /// 释放占用；引擎无 delete——会话记录仍在列表中（close ≠ delete）。
  /// 若关闭的是视口会话，页面回到欢迎态。
  Future<void> closeSession(String sessionId) async {
    final client = _client;
    if (client == null || !client.paired) {
      _fail('未连接 ZCode，无法关闭会话');
      return;
    }
    try {
      await client.request('session/close', {'sessionId': sessionId});
    } catch (e) {
      _fail('关闭会话失败: $e');
      return;
    }
    if (_activeSessionId == sessionId) closeSessionView();
    await refreshSessions();
  }

  // ──────────────────────────────────────────────
  // 权限确认 / AskUser
  // ──────────────────────────────────────────────

  /// 应答权限请求：结果由客户端作为反向请求响应帧回传（带原请求 id）。
  ///
  /// 实测应答 schema（APP-SERVER.md「工具回合实测」）：result 即所选
  /// option 的 response 原文——`{decision: "allow"|"deny", reason,
  /// permissionUpdates?}`。实测畸形 result（空对象/错类型/error 帧）会被
  /// 服务端静默判为 deny（reason="Permission request failed"），因此这里
  /// 优先回放请求方给出的 option response 原文，无暂存时按同 schema 构造。
  /// remember=true 且批准 = allow_project 选项（携带 permissionUpdates）。
  void respondToPermission(String toolCallId,
      {required bool approved, bool remember = false,}) {
    final pending = _pendingReverse.remove(toolCallId);
    if (pending == null) return; // 没有对应待处理请求（可能已应答/已断开）
    final options = _permissionOptions.remove(toolCallId);
    if (_activePermission?.toolCallId == toolCallId) {
      _activePermission = null;
      if (!_permissionController.isClosed) {
        _permissionController.add(null); // 清除权限条
      }
    }
    pending.completer.complete(_buildPermissionResult(
      options: options,
      approved: approved,
      remember: remember,
    ),);
    notifyListeners();
  }

  /// 构造权限应答 result：优先回放实测 option 的 response 原文
  /// （schema 必然合法——服务端自己生成的）；无暂存时按实测 schema 兜底。
  Map<String, dynamic> _buildPermissionResult({
    required List<Map>? options,
    required bool approved,
    required bool remember,
  }) {
    // 找目标 option：批准且 remember → allow_project（allow_always）；
    // 否则批准 → allow_once；拒绝 → deny。
    if (options != null) {
      final wanted = approved
          ? (remember ? 'allow_project' : 'allow_once')
          : 'deny';
      for (final o in options) {
        if (o['optionId']?.toString() == wanted) {
          final response = o['response'];
          if (response is Map) return Map<String, dynamic>.from(response);
        }
      }
    }
    // 兜底构造（实测 schema：decision + reason；remember 需要
    // permissionUpdates，本地无法凭空构造——退化为一次性批准）
    return {
      'decision': approved ? 'allow' : 'deny',
      'reason': approved ? 'Approved once' : 'Denied',
    };
  }

  /// 应答 AskUser 问题：结果由客户端作为反向请求响应帧回传（带原请求 id）。
  /// （AskUser 反向请求实测未触发，应答 payload 形状未实测——沿用旧猜测，
  /// 待后续实测钉死后重写；参照权限请求的经验，畸形 result 大概率被服务端
  /// 静默拒绝，届时应改为回放 option response 原文）
  void respondToAskUser(String questionId, List<String> answers,
      {String? customText,}) {
    final pending = _pendingReverse.remove(questionId);
    if (pending == null) return;
    if (_activeAskUser?.questionId == questionId) {
      _activeAskUser = null;
      if (!_askUserController.isClosed) _askUserController.add(null); // 清除问题条
    }
    pending.completer.complete({
      'questionId': questionId,
      'selectedLabels': answers,
      if (customText != null && customText.isNotEmpty) 'customText': customText,
    });
    notifyListeners();
  }

  /// app-server 反向请求接入点（客户端 onRequest 钩子，运行时由客户端调用）。
  ///
  /// - `interaction/requestPermission`（实测方法名）→ 解析 PermissionRequest
  ///   推流，等待用户应答
  /// - AskUser 类（实测未触发，方法名未知）→ 模糊网兜底，见
  ///   _parseAskUserQuestion 的 UNVERIFIED 标注
  /// - 解析失败或未知 method → 抛错（客户端回默认拒绝 error 帧，安全优先）
  ///
  /// 已实测的方法用**精确匹配**：contains 模糊匹配会把未来新增的相似方法
  /// （如 *PermissionPolicy）误路由到错误分支。
  Future<dynamic> _handleReverseRequest(ZcodeFrame frame) {
    final method = frame.method ?? '';
    final params = frame.params is Map ? frame.params as Map : const {};

    if (method == 'interaction/requestPermission') {
      final request = _parsePermissionRequest(params,
          fallbackId: frame.id?.toString(),);
      if (request == null) {
        throw Exception('无法解析权限请求: $method');
      }
      return _awaitReverseResponse(
        key: request.toolCallId,
        frameId: frame.id,
        onRegistered: () {
          _activePermission = request;
          if (!_permissionController.isClosed) {
            _permissionController.add(request);
          }
          notifyListeners();
        },
      );
    }

    // UNVERIFIED：AskUser 反向请求从未实测触发，方法名未知——保留模糊网
    // 兜底（interaction/askuser/ask_user），解析失败自然落入安全拒绝
    final lower = method.toLowerCase();
    if (lower.contains('interaction') ||
        lower.contains('askuser') ||
        lower.contains('ask_user')) {
      final question = _parseAskUserQuestion(params,
          fallbackId: frame.id?.toString(),);
      if (question == null) {
        throw Exception('无法解析互动请求: $method');
      }
      return _awaitReverseResponse(
        key: question.questionId,
        frameId: frame.id,
        onRegistered: () {
          _activeAskUser = question;
          if (!_askUserController.isClosed) _askUserController.add(question);
          notifyListeners();
        },
      );
    }

    // 其他反向请求：默认安全拒绝（避免空 result 被解读为批准）
    throw Exception('手机端未处理该请求: $method');
  }

  /// 注册待应答反向请求并返回挂起的 future（客户端持有，完成后回传响应帧）
  Future<dynamic> _awaitReverseResponse({
    required String key,
    required dynamic frameId,
    required void Function() onRegistered,
  }) {
    final existing = _pendingReverse[key];
    if (existing != null && !existing.completer.isCompleted) {
      // 同 key 重复请求（连接重建后 server-N id 从头复用等）：旧挂起者
      // 让位——以拒绝完成，防 completer 泄漏悬挂（拒绝 = error 帧安全拒绝）
      existing.completer.completeError(
        const ZcodeReverseRejectException('同 id 的新请求到达，旧请求作废'),
      );
    }
    final completer = Completer<dynamic>();
    _pendingReverse[key] = _PendingReverse(frameId: frameId, completer: completer);
    onRegistered();
    return completer.future;
  }

  /// 解析权限请求（实测形状，APP-SERVER.md「工具回合实测」）：
  ///
  /// method = `interaction/requestPermission`，params = {
  ///   input: {command/description/…}（工具入参，形状随工具而定）,
  ///   reason: "High risk tools require explicit approval",
  ///   requestId: "perm_<uuid>", riskLevel: "high",
  ///   sessionId, turnId,
  ///   toolCallId: "call_…", toolName: "Bash",
  ///   options: [ {kind/optionId/name/response:{decision,reason,
  ///              permissionUpdates?}} ×3 (allow_once/allow_project/deny) ] }
  ///
  /// 字段名变体（tool_call_id 等）仅作协议漂移兜底；options 原文按
  /// toolCallId 暂存，供应答时回放所选 option 的 response。
  PermissionRequest? _parsePermissionRequest(Map params, {String? fallbackId}) {
    final toolCallId = _firstNonEmpty(
          params,
          ['toolCallId', 'tool_call_id', 'callId', 'requestId'],
        ) ??
        fallbackId;
    final toolName = _firstNonEmpty(
      params,
      ['toolName', 'tool_name', 'tool', 'name'],
    );
    if (toolCallId == null || toolCallId.isEmpty) return null;
    if (toolName == null || toolName.isEmpty) return null;

    dynamic input = params['input'];
    if (input is! Map) input = params['params'];
    if (input is! Map) input = params['arguments'];

    // 暂存原始 options（应答回放用；非 List 或缺失时走兜底构造）
    final rawOptions = params['options'];
    if (rawOptions is List) {
      _permissionOptions[toolCallId] =
          rawOptions.whereType<Map>().toList(growable: false);
    }

    return PermissionRequest(
      toolCallId: toolCallId,
      toolName: toolName,
      input: input is Map ? Map<String, dynamic>.from(input) : {},
    );
  }

  /// 解析 AskUser 问题（**实测未触发**——probe-toolturn 各轮均未出现
  /// AskUser 类反向请求，方法名与字段形状仍未知；保留 wzxClaw 自家 ws
  /// 形状的多字段名兜底，待后续实测钉死后重写）：
  /// questionId/question_id/callId/id；question/text/prompt；
  /// options/choices: [{label, description}]；multiSelect/multi_select
  AskUserQuestion? _parseAskUserQuestion(Map params, {String? fallbackId}) {
    final questionId =
        _firstNonEmpty(params, ['questionId', 'question_id', 'callId', 'id']) ??
            fallbackId;
    final question = _firstNonEmpty(params, ['question', 'text', 'prompt']);
    if (questionId == null || questionId.isEmpty) return null;
    if (question == null || question.isEmpty) return null;

    dynamic options = params['options'];
    if (options is! List) options = params['choices'];
    if (options is! List || options.isEmpty) return null;

    final mapped = <Map<String, String>>[];
    for (final o in options) {
      if (o is Map) {
        mapped.add({
          'label': o['label']?.toString() ?? o['value']?.toString() ?? '',
          'description': o['description']?.toString() ?? '',
        });
      } else if (o != null) {
        mapped.add({'label': o.toString(), 'description': ''});
      }
    }
    if (mapped.isEmpty) return null;

    final multi = params['multiSelect'] ?? params['multi_select'] ?? params['multiselect'];
    return AskUserQuestion(
      questionId: questionId,
      question: question,
      options: mapped,
      multiSelect: multi == true || multi == 'true',
    );
  }

  /// 断开/离开会话时收尾所有挂起的反向请求：
  /// 以 [ZcodeReverseRejectException] 完成 → 客户端回传 error 帧
  /// （code -32000，安全拒绝），避免桌面端 -32022 超时挂起，
  /// 也避免 result 形状被对端解读为批准
  void _rejectAllPendingReverse() {
    if (_pendingReverse.isEmpty) return;
    final entries = List.of(_pendingReverse.entries);
    _pendingReverse.clear();
    _permissionOptions.clear();
    for (final e in entries) {
      if (!e.value.completer.isCompleted) {
        e.value.completer.completeError(
          const ZcodeReverseRejectException('会话已切换，请求被拒绝'),
        );
      }
    }
    _activePermission = null;
    _activeAskUser = null;
    if (!_permissionController.isClosed) _permissionController.add(null);
    if (!_askUserController.isClosed) _askUserController.add(null);
  }

  // ──────────────────────────────────────────────
  // 内部：通知帧路由（按帧自带 sessionId 归属）
  // ──────────────────────────────────────────────

  /// 通知帧统一入口：
  /// - session/event：订阅推送事件（严格按 sessionId 路由，未知会话丢弃）
  /// - state.updated：状态补丁（running/idle、模型列表）
  /// - v4/telemetry/event：usage.delta / turn.terminal / stream.chunk
  void _handleNotifyFrame(ZcodeFrame frame) {
    final params = frame.params;
    if (params is! Map) return;
    switch (frame.method) {
      case 'session/event':
        final sid = _nonEmpty(params['sessionId']);
        final state = sid == null ? null : _states[sid];
        if (state == null) return; // 未知会话的事件丢弃（未订阅，防串扰）
        state.lastPushAt = DateTime.now(); // 推送通道存活的证据（看门狗判活）
        _applySessionEvent(state, params);
        // 推送恢复：停掉可能因看门狗拉起的降级轮询（eventId 去重本就并存安全）
        _stopFallbackPollingFor(state.sessionId);
        return;
      case 'state.updated':
        _handleStateUpdated(params);
        return;
      case 'v4/telemetry/event':
        _handleTelemetry(params);
        return;
    }
  }

  /// state.updated 补丁：status running/idle、模型可用列表缓存；
  /// 无 sessionId 的帧（兼容路径/测试注入）落到视口会话
  void _handleStateUpdated(Map params) {
    final patch = params['patch'];
    if (patch is! Map) return;
    _cacheAvailableModels(patch['model']);

    final sid = _nonEmpty(params['sessionId']);
    final state = sid == null ? _activeState : _states[sid];
    final status = _nonEmpty(patch['status']);

    if (state == null) {
      // 未知会话：仅刷新列表徽标
      if (sid != null && status != null) _updateSessionBadge(sid, status);
      return;
    }

    if (status == 'running') {
      state.isStreaming = true;
      _notifyIfActive(state);
    } else if (status == 'idle') {
      if (state.isStreaming) {
        // 兜底回合收尾（可能错过 turn.completed / turn.terminal）
        _handleTurnEnd(
          state,
          turnId: null,
          status: 'success',
          tokenCount: null,
          toolCallCount: null,
          authoritativeText: null,
          usage: null,
        );
      }
    }
    if (sid != null && status != null) _updateSessionBadge(sid, status);

    // 权限模式权威回填：patch.mode.current（setMode 响应快照口径
    // 有差异，不作为来源；见 setMode 注释）
    final modePatch = patch['mode'];
    final modeCurrent =
        modePatch is Map ? _nonEmpty(modePatch['current']) : null;
    if (modeCurrent != null && state.mode != modeCurrent) {
      state.mode = modeCurrent;
      _notifyIfActive(state);
    }
  }

  /// v4/telemetry/event：usage.delta 记 token；turn.terminal 回合收尾
  /// （telemetry 无 toolCallCount → 保守走权威刷新）；
  /// stream.chunk 在推送不可用时确保降级轮询在跑
  void _handleTelemetry(Map params) {
    final sid = _nonEmpty(params['sessionId']);
    if (sid != null && _states[sid] == null) return; // 未知会话：忽略
    final state = sid == null ? _activeState : _states[sid];
    if (state == null) return;

    final kind = params['kind'];
    if (kind == 'usage.delta') {
      state.lastInputTokens =
          _toIntOrNull(params['inputTokens']) ?? state.lastInputTokens;
      state.lastOutputTokens =
          _toIntOrNull(params['outputTokens']) ?? state.lastOutputTokens;
    } else if (kind == 'turn.terminal') {
      _handleTurnEnd(
        state,
        turnId: _nonEmpty(params['turnId']),
        status: _nonEmpty(params['status']) ?? 'success',
        tokenCount: _toIntOrNull(params['tokenCount']),
        toolCallCount: null, // telemetry 帧无工具计数 → 权威刷新
        authoritativeText: null,
        usage: null,
      );
    } else if (kind == 'stream.chunk') {
      if (!state.pushAvailable && _isActive(state)) _startFallbackPolling();
    } else {
      // 未知 telemetry kind：留观测（不硬猜用途）
      debugPrint('[zcode-store] telemetry 未处理 kind=$kind '
          'session=${state.sessionId}');
    }
  }

  /// 应用一条 session/event（推送帧 / 订阅快照 / events 补放共用）：
  /// eventId 去重 + seq 推进，按 type 分发
  void _applySessionEvent(ZcodeSessionState state, Map ev) {
    final eventId = _nonEmpty(ev['eventId']);
    if (eventId != null && !state.rememberEvent(eventId)) return; // 已应用
    state.advanceSeq(_toIntOrNull(ev['seq']));

    final payload = ev['payload'] is Map ? ev['payload'] as Map : const {};
    // 推送帧的 type（如 model.streaming）；session/events 拉取的旧形态
    // 用 payload.kind（如 text_delta）——两者统一分发
    final type = _nonEmpty(ev['type']) ?? _nonEmpty(payload['kind']);
    final turnId = _nonEmpty(ev['turnId']);

    switch (type) {
      case 'turn.started':
        state.isStreaming = true;
        final messageId =
            _nonEmpty(payload['messageId']) ?? _nonEmpty(payload['message_id']);
        final input = payload['input'];
        if (messageId != null && input is String && input.isNotEmpty) {
          state.ensureUserMessage(protoId: messageId, content: input);
        }
        _armPushWatchdog(state); // 桌面端发起的回合同样受看门狗保护
        _notifyIfActive(state);
        return;
      case 'model.streaming':
        state.isStreaming = true; // 收到流式增量即视作运行（含兜底收尾后恢复）
        final assistantId = _nonEmpty(payload['assistantMessageId']);
        if (assistantId != null) state.adoptStreamingProtoId(assistantId);
        final delta = payload['delta'];
        if (delta is String && delta.isNotEmpty) {
          final kind = payload['kind'];
          if (kind == 'reasoning_delta') {
            state.appendThinkingDelta(delta);
          } else if (kind == null || kind == 'text_delta') {
            state.appendTextDelta(delta);
          } else {
            // 未知增量种类：不留观测就会变成「内容少了但没人知道」
            debugPrint('[zcode-store] model.streaming 未处理 kind=$kind '
                'session=${state.sessionId}');
          }
          _notifyIfActive(state);
        }
        return;
      case 'text_delta':
        state.isStreaming = true; // 收到流式增量即视作运行
        final delta = payload['delta'];
        if (delta is String && delta.isNotEmpty) {
          state.appendTextDelta(delta);
          _notifyIfActive(state);
        }
        return;
      case 'reasoning_delta':
        final delta = payload['delta'];
        if (delta is String && delta.isNotEmpty) {
          state.appendThinkingDelta(delta);
          _notifyIfActive(state);
        }
        return;
      case 'model.response':
        // 权威全文重对流式文本（防增量丢失）；回合由 turn.completed 收尾
        final content = payload['content'];
        if (content is String && content.isNotEmpty) {
          state.reconcileStreamingText(content);
          _notifyIfActive(state);
        }
        final usage = payload['usage'];
        if (usage is Map) {
          final input = _toIntOrNull(usage['inputTokens']);
          final output = _toIntOrNull(usage['outputTokens']);
          if (input != null) state.lastInputTokens = input;
          if (output != null) state.lastOutputTokens = output;
        }
        return;
      case 'turn.completed':
        _handleTurnEnd(
          state,
          turnId: turnId,
          status: _nonEmpty(payload['resultType']) ?? 'success',
          tokenCount: _toIntOrNull(payload['tokenCount']),
          toolCallCount: _toIntOrNull(payload['toolCallCount']),
          authoritativeText: payload['response'] is String
              ? payload['response'] as String
              : null,
          usage: _mapUsage(payload['usage']),
        );
        return;
      case 'session.titleUpdated':
        final title = _nonEmpty(payload['title']);
        if (title != null) _renameSessionBadge(state.sessionId, title);
        return;
      default:
        // 静默丢弃 = 缺陷：未知类型留观测（session.updated 等已知无对应
        // 行为的类型也会经过这里，日志是发现新事件的唯一手段）
        debugPrint('[zcode-store] session/event 未处理 type=$type '
            'session=${state.sessionId}');
        return;
    }
  }

  /// 回合收尾（turn.completed / turn.terminal / state.updated idle 共用）：
  /// - 纯文本回合（toolCallCount == 0 且带权威全文）本地收尾，免权威刷新；
  /// - 工具回合/未知回合走增量权威刷新（工具结果只有权威列表才有）；
  /// - turnId 幂等去重（session/event 与 telemetry 双通道都会到达）。
  void _handleTurnEnd(
    ZcodeSessionState state, {
    required String? turnId,
    required String status,
    int? tokenCount,
    int? toolCallCount,
    String? authoritativeText,
    TokenUsage? usage,
  }) {
    if (turnId != null) {
      if (!state.endedTurnIds.add(turnId)) return; // 该回合已收尾
      // 回合已被其他通道收尾（如 state.updated idle 兜底先到）：不重复走
      // 收尾路径（避免双份通知），但 turn.completed 携带的权威全文/用量
      // 不能跟着丢——先前通道收尾时可能只有残缺流式文本，这里补一次
      // 增量权威刷新把最终内容拉平（幂等，仅此迟到场景触发）。
      if (!state.hasTurnInFlight) {
        if (usage != null) {
          state.lastInputTokens = usage.inputTokens;
          state.lastOutputTokens = usage.outputTokens;
        }
        if ((authoritativeText != null && authoritativeText.isNotEmpty) ||
            usage != null) {
          unawaited(_refreshAuthoritative(state));
        }
        return;
      }
    }
    _stopFallbackPollingFor(state.sessionId);
    state.isStreaming = false;
    state.isWaitingForResponse = false;
    final textTurn = toolCallCount == 0;
    if (textTurn) {
      state.finalizeStreaming(
        authoritativeText: authoritativeText,
        usage: usage,
      );
      unawaited(_persistSession(state));
    } else {
      state.finalizeStreaming();
      unawaited(_refreshAuthoritative(state)); // 工具回合：权威刷新
    }
    // 任务完成本地通知（App 在后台也能感知；后台会话同样通知）
    _notifier.showTaskDone(
      status: status,
      tokens:
          tokenCount ?? (state.lastInputTokens + state.lastOutputTokens),
      sessionId: state.sessionId,
      desktopId: desktopId,
      desktopName: desktopName,
    );
    if (!_isActive(state)) {
      unawaited(refreshSessions()); // 后台徽标靠 session/list 刷新
    }
    _notifyIfActive(state);
  }

  // ──────────────────────────────────────────────
  // 内部：订阅与断线补放
  // ──────────────────────────────────────────────

  /// 建立推送订阅（幂等）：web-remote-replayable 可回放事件流。
  /// 响应快照 events 走统一应用路径（eventId 去重）。
  /// 失败（旧版 app-server 无此方法等）→ pushAvailable=false，降级轮询。
  Future<void> _ensureSubscribed(ZcodeSessionState state) async {
    if (state.subscribed || !state.pushAvailable) return;
    final client = _client;
    if (client == null || !client.paired) return;
    try {
      final result = await client.request('session/subscribe', {
        'sessionId': state.sessionId,
        'deliveryKind': 'web-remote-replayable',
      });
      state.subscribed = true;
      if (result is Map && result['events'] is List) {
        for (final ev in result['events'] as List) {
          if (ev is Map) _applySessionEvent(state, ev);
        }
      }
    } catch (_) {
      state.pushAvailable = false; // 降级轮询
    }
  }

  /// 重连成功后：为所有已物化会话重订阅 + 按 lastSeq 补放断线期间事件
  /// （replayable 语义；eventId 去重使重复补放无害）。
  /// 补放后仍流式但无任何新事件的会话：回合可能已在断线期间结束
  /// （app-server 重启、事件缓冲丢失），用权威刷新校正本地状态，
  /// 避免永远的"生成中"转圈。
  Future<void> _resubscribeAll() async {
    final client = _client;
    if (client == null || !client.paired) return;
    for (final state in List.of(_states.values)) {
      if (!state.materialized) continue;
      final seqBefore = state.lastSeq;
      state.subscribed = false;
      state.pushAvailable = true; // 重连后重试推送
      await _ensureSubscribed(state);
      await _replayMissedEvents(state);
      if (state.isStreaming && state.lastSeq == seqBefore) {
        // 断线期间没有任何事件：回合大概率已结束，权威刷新收尾
        unawaited(_refreshAuthoritative(state));
      } else if (state.isStreaming &&
          !state.pushAvailable &&
          _isActive(state) &&
          _fallbackPollTimer == null) {
        _startFallbackPollingFor(state.sessionId);
      }
    }
  }

  /// 断线补放：session/events {afterSeq: lastSeq} 拉取缺口事件
  Future<void> _replayMissedEvents(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) return;
    try {
      final result = await client.request('session/events', {
        'sessionId': state.sessionId,
        'afterSeq': state.lastSeq,
        'limit': 100,
      });
      if (result is Map && result['events'] is List) {
        for (final ev in result['events'] as List) {
          if (ev is Map) _applySessionEvent(state, ev);
        }
      }
    } catch (_) {
      // 补放失败静默：订阅推送仍在，后续事件继续到达
    }
  }

  // ──────────────────────────────────────────────
  // 内部：视口加载与权威刷新（增量）
  // ──────────────────────────────────────────────

  /// resume 响应 meta：忽略 messages 数组，取 projection 状态与 workspace
  void _applyResumeMeta(ZcodeSessionState state, Map map) {
    state.materialized = true;
    // settings.model.available 播种可用模型缓存（setModel 兜底数据源，
    // 实测与 state.updated 的 model 补丁同形状）
    final settings = map['settings'];
    if (settings is Map) _cacheAvailableModels(settings['model']);
    // 快照该会话的标题与工作区（列表补条目用）+ 记住工作区（新建会话复用）
    final session = map['session'];
    if (session is Map) {
      _resumeTitle = _nonEmpty(session['title']);
      final ws = session['workspace'];
      if (ws is Map) {
        final key = _nonEmpty(ws['workspaceKey']);
        final path = _nonEmpty(ws['workspacePath']);
        _resumeWsKey = key;
        _resumeWsPath = path;
        if (key != null && path != null) {
          _defaultWorkspaceKey = key;
          _defaultWorkspacePath = path;
        }
      }
    }
    final projection = map['projection'];
    final status = projection is Map ? projection['status'] : null;
    if (status == 'running') {
      state.isStreaming = true;
    } else if (status != null && !state.hasTurnInFlight) {
      state.isStreaming = false;
    }
    // runtime.eventSeq 可作为 seq 水位种子（单调取大）
    final runtime = map['runtime'];
    state.advanceSeq(_toIntOrNull(runtime is Map ? runtime['eventSeq'] : null));
  }

  /// session/read 轻量 meta（2–5KB）：运行状态 + eventSeq 水位种子
  void _applyReadMeta(ZcodeSessionState state, Map read) {
    // settings.model.available 播种可用模型缓存（与 resume 同形状）
    final settings = read['settings'];
    if (settings is Map) _cacheAvailableModels(settings['model']);
    final projection = read['projection'];
    if (projection is Map) {
      final status = projection['status'];
      if (status == 'running') {
        state.isStreaming = true;
      } else if (status != null && !state.hasTurnInFlight) {
        state.isStreaming = false;
      }
    }
    final runtime = read['runtime'];
    state.advanceSeq(_toIntOrNull(runtime is Map ? runtime['eventSeq'] : null));
  }

  /// 从缓存恢复（秒开）：尾窗消息 + 游标（seq 水位/消息水位）
  Future<void> _loadFromCache(ZcodeSessionState state) async {
    try {
      final cached = await _cache.loadTail(
        state.sessionId,
        limit: _kCacheTailLimit,
      );
      if (state.items.isEmpty && cached.isNotEmpty) {
        state.items.addAll(cached);
      }
      final cursor = await _cache.loadCursor(state.sessionId);
      if (cursor != null) {
        state.advanceSeq(cursor.lastSeq);
        state.watermark ??= cursor.watermark;
      }
      state.watermark ??= state.lastProtoId;
    } catch (_) {
      // 缓存尽力而为：失败走网络路径
    }
  }

  /// 尾部拉取：有水位走增量（只拉新增），无水位先 {limit} 取一窗再
  /// 前向收敛。实测（APP-SERVER.md「分页契约实测」）：{limit} 返回
  /// **最新 N 条、升序**；{afterMessageId, limit} 返回游标后缀中的
  /// 最新 N 条（同样升序）——水位每轮推进到合并后尾部，循环收敛。
  Future<void> _fetchTailWindow(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) return;
    if (state.watermark != null) {
      try {
        await _pullIncremental(state);
        return;
      } catch (_) {
        // 水位可能失效（服务端压缩/清理）：回退全窗口
      }
    }
    final result = await client.request('session/messages', {
      'sessionId': state.sessionId,
      'limit': _kTailLimit,
    });
    if (result is Map) _mergeServerMessages(state, result);
    await _pullIncremental(state); // 前向收敛到尾部
  }

  /// 增量拉取：从水位 afterMessageId 向前翻页，直到不足一页或被截断
  Future<void> _pullIncremental(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) return;
    for (var page = 0; page < _kMaxIncrementalPages; page++) {
      final after = state.watermark;
      final result = await client.request('session/messages', {
        'sessionId': state.sessionId,
        'limit': _kIncrementalLimit,
        if (after != null) 'afterMessageId': after,
      });
      if (result is! Map) return;
      _mergeServerMessages(state, result);
      final raw = result['messages'];
      final got = raw is List ? raw.length : 0;
      // 页被 relay 截断（保留的是尾部，页头丢失）或不足一页：已收敛
      if (result['messagesTruncated'] == true || got < _kIncrementalLimit) {
        return;
      }
    }
  }

  /// 合并 session/messages 响应：映射 → 时间序归一 → 增量合并 + 推进水位。
  /// 入参条目一律视为已同步（synced），水位取**本批权威数据**中最新的
  /// 协议 id（不取容器尾——尾部可能有未确认的流式占位，见下方注释）。
  void _mergeServerMessages(ZcodeSessionState state, Map map) {
    final raw = map['messages'];
    if (raw is! List) return;
    final incoming = <ZcodeSessionItem>[];
    for (final m in raw) {
      if (m is! Map) continue;
      final msg = _mapProtocolMessage(m);
      if (msg == null) continue;
      final info = m['info'];
      incoming.add(ZcodeSessionItem(
        message: msg,
        protoId: _nonEmpty(info is Map ? info['id'] : null),
        synced: true, // 服务端权威数据
      ),);
    }
    if (incoming.isEmpty) return;
    _normalizeChronological(incoming);
    state.mergeAuthoritative(incoming);
    // 水位只由**本批权威数据**推进（服务端确认过的消息 id，展示序最后
    // 一条即最新）。不能取合并后容器尾部：容器尾部可能还挂着未确认的
    // 流式占位（已采纳 assistantMessageId 但权威页尚未返回它）——占位
    // 推进水位会使后续 afterMessageId 增量永久跳过该消息的最终版本
    //（数据丢失链，2026-09-15 审查 P0 #1）。
    for (final it in incoming.reversed) {
      final id = it.protoId;
      if (id != null) {
        state.watermark = id;
        break;
      }
    }
  }

  /// 时间序归一：实测（probe-sync3，APP-SERVER.md「分页契约实测」）确认
  /// `session/messages` 无论带不带 `afterMessageId` 一律**升序（旧→新）**
  /// 返回——升序页直接通过；页内 createdAt 多数呈降序时按逆序解释，
  /// 该投票仅作协议漂移/异常数据的兜底，正常路径不会再触发。
  void _normalizeChronological(List<ZcodeSessionItem> list) {
    if (list.length < 2) return;
    var ascending = 0;
    var descending = 0;
    for (var i = 1; i < list.length; i++) {
      final a = list[i - 1].message.createdAt;
      final b = list[i].message.createdAt;
      if (b.isAfter(a)) {
        ascending++;
      } else if (b.isBefore(a)) {
        descending++;
      }
    }
    if (descending > ascending) {
      // 逆序页（异常兜底）：反转成就近在尾
      final reversed = list.reversed.toList();
      list
        ..clear()
        ..addAll(reversed);
    }
  }

  /// turn 结束/stop 后的增量权威刷新：只拉新增合并（替代全量重建）
  Future<void> _refreshAuthoritative(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) {
      _finishTurnFlags(state);
      return;
    }
    try {
      await _pullIncremental(state);
    } catch (_) {
      // 权威刷新失败：保留现有流式内容，仅结束流式标记
    }
    _finishTurnFlags(state);
    unawaited(_persistSession(state));
  }

  /// 回合收尾的视口状态清理
  void _finishTurnFlags(ZcodeSessionState state) {
    _stopFallbackPollingFor(state.sessionId);
    state.isStreaming = false;
    state.isWaitingForResponse = false;
    state.finalizeStreaming();
    _notifyIfActive(state);
  }

  /// 持久化会话（尽力而为，增量）：只写 dirty 且有协议 id 的消息，
  /// 写成功后清除脏标记——避免每个回合全量重写整个消息窗。
  /// 游标（seq 水位/消息水位）每次都写。
  Future<void> _persistSession(ZcodeSessionState state) async {
    try {
      final dirty = state.items
          .where((e) => e.dirty && e.protoId != null)
          .toList(growable: false);
      if (dirty.isNotEmpty) {
        await _cache.upsertMessages(state.sessionId, dirty);
        for (final d in dirty) {
          d.dirty = false;
        }
      }
      await _cache.saveCursor(
        state.sessionId,
        lastSeq: state.lastSeq,
        watermark: state.watermark ?? state.lastProtoId,
      );
    } catch (_) {
      // 缓存失败不影响主流程
    }
  }

  /// state.updated 的 model 补丁 → 可用模型列表缓存（setModel 兜底用）
  void _cacheAvailableModels(dynamic modelPatch) {
    if (modelPatch is! Map) return;
    // 当前选中模型（settings.model.current，实测 {providerId, modelId}）
    final current = modelPatch['current'];
    if (current is Map) {
      final pid = _nonEmpty(current['providerId']);
      final mid = _nonEmpty(current['modelId']);
      if (pid != null && mid != null) _currentModelRef = '$pid/$mid';
    }
    final available = modelPatch['available'];
    if (available is! List) return;
    final models = <String>[];
    final catalog = <ZcodeModelInfo>[];
    for (final m in available) {
      if (m is Map) {
        final ref = m['ref'];
        final providerId = _nonEmpty(ref is Map ? ref['providerId'] : null);
        final modelId = _nonEmpty(ref is Map ? ref['modelId'] : null);
        if (providerId != null && modelId != null) {
          models.add('$providerId/$modelId');
          catalog.add(ZcodeModelInfo(
            providerId: providerId,
            modelId: modelId,
            label: _nonEmpty(m['label']),
            providerLabel: _nonEmpty(m['providerLabel']),
            contextWindow: m['contextWindow'] is num ? (m['contextWindow'] as num).toInt() : null,
            maxOutputTokens: m['maxOutputTokens'] is num ? (m['maxOutputTokens'] as num).toInt() : null,
            reasoning: m['reasoning'] == true,
          ),);
        }
      }
    }
    if (models.isNotEmpty) {
      _availableModels
        ..clear()
        ..addAll(models);
    }
    if (catalog.isNotEmpty) {
      _modelCatalog
        ..clear()
        ..addAll(catalog);
    }
  }

  /// 设置会话模型（session/setModel；实测只接受对象 {providerId, modelId}）。
  /// 乐观更新 currentModelRef；权威值以随后的 state.updated 快照回填为准。
  /// 返回是否成功（失败时 error 已置位）。
  Future<bool> setModel(String providerId, String modelId) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    if (providerId.isEmpty || modelId.isEmpty) {
      _fail('模型引用不完整');
      return false;
    }
    try {
      await client.request('session/setModel', {
        'sessionId': sessionId,
        'model': {'providerId': providerId, 'modelId': modelId},
      });
      _currentModelRef = '$providerId/$modelId';
      notifyListeners();
      return true;
    } catch (e) {
      _fail('切换模型失败：$e');
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // 会话高级操作（官方 web 对齐；schema 均经 probe-methods 实测）
  // ──────────────────────────────────────────────

  /// 思考强度（session/setThoughtLevel；实测字段 thoughtLevel: string，
  /// 业务枚举 low|medium|high）。乐观更新，权威值以快照回填为准。
  Future<bool> setThoughtLevel(String level) async {
    const allowed = ['low', 'medium', 'high'];
    if (!allowed.contains(level)) {
      _fail('未知思考强度：$level');
      return false;
    }
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    try {
      await client.request('session/setThoughtLevel', {
        'sessionId': sessionId,
        'thoughtLevel': level,
      });
      thoughtLevel = level;
      notifyListeners();
      return true;
    } catch (e) {
      _fail('设置思考强度失败：$e');
      return false;
    }
  }

  /// 会话用量统计（session/usage；实测响应含 8 项计数）。
  /// 返回原始 Map 供 UI 渲染；失败抛出。
  Future<Map<String, dynamic>> fetchUsage() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      throw Exception('未连接 ZCode 或未打开会话');
    }
    final result = await client.request('session/usage', {'sessionId': sessionId});
    return result is Map ? Map<String, dynamic>.from(result) : const {};
  }

  /// 手动压缩上下文（session/compact）。成功后刷新会话列表；
  /// 返回原始响应（形状通用处理）。
  Future<void> compactSession() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return;
    }
    try {
      await client.request('session/compact', {'sessionId': sessionId});
      unawaited(refreshSessions());
    } catch (e) {
      _fail('压缩上下文失败：$e');
    }
  }

  /// 分叉当前会话（session/fork；要求会话已有 workspace 检查点，
  /// 否则 -32603 INVALID_STATE_TRANSITION）。成功后刷新列表并打开副本。
  Future<bool> forkSession() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    try {
      final result = await client.request('session/fork', {'sessionId': sessionId});
      String? newId;
      if (result is Map) {
        // 响应形状未单测（业务上仅 checkpoint 齐全的会话可 fork）：兼容两种常见形态
        newId = _nonEmpty(result['sessionId']) ??
            ((result['session'] is Map)
                ? _nonEmpty((result['session'] as Map)['sessionId'])
                : null);
      }
      await refreshSessions();
      if (newId != null) {
        await openSession(newId);
        return true;
      }
      _fail('分叉完成但未返回新会话，请在会话列表中查看');
      return false;
    } catch (e) {
      final message = e.toString();
      if (message.contains('checkpoint') || message.contains('INVALID_STATE_TRANSITION')) {
        _fail('该会话还没有可用的工作区检查点（需先产生过文件修改）');
      } else {
        _fail('分叉失败：$e');
      }
      return false;
    }
  }

  /// 取消后台任务（session/cancelBackgroundTask；实测响应
  /// {cancelled, reason, status, taskId}）。返回响应 Map。
  Future<Map<String, dynamic>> cancelBackgroundTask(String taskId) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      throw Exception('未连接 ZCode 或未打开会话');
    }
    final result = await client.request('session/cancelBackgroundTask', {
      'sessionId': sessionId,
      'taskId': taskId,
    });
    return result is Map ? Map<String, dynamic>.from(result) : const {};
  }

  /// 读取会话目标（session/goal action=show）。注意：目标状态大的会话
  /// 可能触发 -32001（响应超中继帧上限），调用方需容错展示。
  Future<Map<String, dynamic>> goalShow() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      throw Exception('未连接 ZCode 或未打开会话');
    }
    final result = await client.request('session/goal', {
      'sessionId': sessionId,
      'action': 'show',
    });
    return result is Map ? Map<String, dynamic>.from(result) : const {};
  }

  /// 设置/替换会话目标（session/goal action=set|replace；字段 objective，
  /// 可选 expectedRevision 乐观锁）。action=set 追加、replace 整体替换。
  Future<bool> setGoal(String objective, {required bool replace}) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    if (objective.trim().isEmpty) {
      _fail('目标内容为空');
      return false;
    }
    try {
      await client.request('session/goal', {
        'sessionId': sessionId,
        'action': replace ? 'replace' : 'set',
        'objective': objective.trim(),
      });
      return true;
    } catch (e) {
      if (e is ZcodeRequestException && e.code == -32001) {
        _fail('目标数据过大，请在桌面端处理该会话目标');
      } else {
        _fail('设置目标失败：$e');
      }
      return false;
    }
  }

  /// 子代理列表（session/subagents；实测响应 {revision, childSessionIds[]}）
  Future<List<String>> loadSubagents() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      throw Exception('未连接 ZCode 或未打开会话');
    }
    final result = await client.request('session/subagents', {'sessionId': sessionId});
    if (result is Map && result['childSessionIds'] is List) {
      return (result['childSessionIds'] as List)
          .map((e) => e?.toString() ?? '')
          .where((e) => e.isNotEmpty)
          .toList();
    }
    return const [];
  }

  /// 关闭会话运行时（session/close；桌面端释放该会话资源）。
  /// 成功后回到会话列表并刷新。
  Future<bool> closeSessionRemote() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    try {
      await client.request('session/close', {'sessionId': sessionId});
      closeSessionView();
      unawaited(refreshSessions());
      return true;
    } catch (e) {
      _fail('关闭会话失败：$e');
      return false;
    }
  }

  /// openSession 成功后把缺失的会话补进列表快照（新会话置顶）：
  /// newSession 的 refreshSessions 可能失败（内部吞错）或服务端列表
  /// 尚未包含刚创建的会话——视口已打开而列表缺失会让抽屉头部误显示
  /// 「未选择会话」。已有条目以 session/list 权威快照为准，不覆盖。
  void _upsertOpenedListing(ZcodeSessionState state) {
    if (_sessions.any((s) => s.sessionId == state.sessionId)) return;
    _sessions.insert(
      0,
      ZcodeSessionMeta(
        sessionId: state.sessionId,
        title: _resumeTitle ?? '（无标题会话）',
        updatedAt: DateTime.now().millisecondsSinceEpoch,
        workspaceKey: _resumeWsKey ?? _defaultWorkspaceKey,
        workspacePath: _resumeWsPath ?? _defaultWorkspacePath,
        status: state.isStreaming ? 'running' : 'idle',
      ),
    );
  }

  /// 更新会话列表徽标（state.updated 的 status）
  void _updateSessionBadge(String sessionId, String status) {
    final idx = _sessions.indexWhere((s) => s.sessionId == sessionId);
    if (idx < 0) return;
    final s = _sessions[idx];
    if (s.status == status) return;
    _sessions[idx] = ZcodeSessionMeta(
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
      workspaceKey: s.workspaceKey,
      workspacePath: s.workspacePath,
      status: status,
    );
    notifyListeners();
  }

  /// 更新会话列表标题（session.titleUpdated）
  void _renameSessionBadge(String sessionId, String title) {
    final idx = _sessions.indexWhere((s) => s.sessionId == sessionId);
    if (idx < 0) return;
    final s = _sessions[idx];
    if (s.title == title) return;
    _sessions[idx] = ZcodeSessionMeta(
      sessionId: s.sessionId,
      title: title,
      updatedAt: s.updatedAt,
      workspaceKey: s.workspaceKey,
      workspacePath: s.workspacePath,
      status: s.status,
    );
    notifyListeners();
  }

  // ──────────────────────────────────────────────
  // 内部：降级轮询（推送不可用/失效时的视口会话）
  // ──────────────────────────────────────────────

  /// 对指定会话启动降级轮询（与推送并存安全：eventId 去重）
  void _startFallbackPollingFor(String sessionId) {
    final state = _states[sessionId];
    if (state == null || !state.isStreaming) return;
    if (_client?.paired != true) return;
    _fallbackPollSessionId = sessionId;
    if (_fallbackPollTimer != null) return; // 已在轮询
    unawaited(_pollOnce()); // 立即拉一次
    _fallbackPollTimer = Timer.periodic(
      _kPollInterval,
      (_) => unawaited(_pollOnce()),
    );
  }

  /// 对当前视口会话启动降级轮询（兼容旧调用点）
  void _startFallbackPolling() {
    final state = _activeState;
    if (state != null) _startFallbackPollingFor(state.sessionId);
  }

  void _stopFallbackPolling() {
    _fallbackPollTimer?.cancel();
    _fallbackPollTimer = null;
    _fallbackPollSessionId = null;
    _pushWatchdogTimer?.cancel();
    _pushWatchdogTimer = null;
  }

  void _stopFallbackPollingFor(String sessionId) {
    if (_fallbackPollSessionId == sessionId) {
      _fallbackPollTimer?.cancel();
      _fallbackPollTimer = null;
      _fallbackPollSessionId = null;
    }
  }

  /// 武装推送看门狗：会话进入流式且推送在用时安排一次延迟检查；
  /// 期间仍有推送帧到达则重新武装，静默超过阈值则拉起降级轮询
  /// （轮询与推送并存，eventId 去重；推送恢复时自动停轮询）
  void _armPushWatchdog(ZcodeSessionState state) {
    if (!state.pushAvailable || !state.subscribed) return;
    if (_client?.paired != true) return;
    _pushWatchdogTimer?.cancel();
    _pushWatchdogTimer = Timer(pushWatchdogDelay, () {
      _pushWatchdogTimer = null;
      final s = _states[state.sessionId];
      if (s == null || !s.isStreaming || !s.pushAvailable) return;
      final lastAt = s.lastPushAt;
      if (lastAt != null &&
          DateTime.now().difference(lastAt) < pushWatchdogDelay) {
        _armPushWatchdog(s); // 推送仍在流：重新武装
        return;
      }
      // 推送疑似失效：视口会话拉起降级轮询（后台会话等回归视口后校正）
      if (_isActive(s)) _startFallbackPollingFor(s.sessionId);
    });
  }

  /// 降级轮询 session/events：payload.kind
  /// text_delta→追加流式消息、reasoning_delta→thinking；按 eventId 去重
  Future<void> _pollOnce() async {
    final client = _client;
    final sessionId = _fallbackPollSessionId;
    final state = sessionId == null ? null : _states[sessionId];
    if (client == null || state == null || !client.paired) {
      _stopFallbackPolling();
      return;
    }
    try {
      final result = await client.request('session/events', {
        'sessionId': sessionId,
        'limit': 100,
      });
      if (result is Map && result['events'] is List) {
        for (final ev in result['events'] as List) {
          if (ev is Map) _applySessionEvent(state, ev);
        }
      }
    } catch (_) {
      // 轮询失败静默，下一轮重试
    }
  }

  // ──────────────────────────────────────────────
  // 内部：协议消息映射
  // ──────────────────────────────────────────────

  /// usage 映射：{inputTokens, outputTokens} → TokenUsage（字段齐全才映射）
  TokenUsage? _mapUsage(dynamic usage) {
    if (usage is! Map) return null;
    final rawInput = usage['inputTokens'];
    final rawOutput = usage['outputTokens'];
    if (rawInput == null && rawOutput == null) return null;
    // 部分字段容忍：字段存在但解析失败按 0 计，不因单边缺失整体丢弃
    // （usage 形状可能随版本增减字段——丢一个字段比丢整份好）
    return TokenUsage(
      inputTokens: _toIntOrNull(rawInput) ?? 0,
      outputTokens: _toIntOrNull(rawOutput) ?? 0,
    );
  }

  /// app-server 消息（info + parts）→ ChatMessage。
  /// parts：text→content 拼接；tool{callId,state,tool{name}}→ToolCallInfo
  /// （state：running→running / completed→done / 其他→error）。
  /// reasoning 部分历史加载不展示（ChatMessage 无 thinking 字段，
  /// 流式阶段的 thinking 走 store 的 thinkingContent）。
  ChatMessage? _mapProtocolMessage(Map m) {
    final info = m['info'];
    if (info is! Map) return null;
    final parts = m['parts'];
    if (parts is! List) return null;

    final role =
        info['role'] == 'user' ? MessageRole.user : MessageRole.assistant;

    var content = '';
    final toolCalls = <ToolCallInfo>[];
    for (final p in parts) {
      if (p is! Map) continue;
      final type = p['type'];
      if (type == 'text') {
        final text = p['text'];
        if (text is String) content += text;
      } else if (type == 'tool') {
        toolCalls.add(_mapToolPart(p));
      }
    }

    // 空 assistant 中间态消息过滤（user 空消息保留）
    if (role != MessageRole.user && content.isEmpty && toolCalls.isEmpty) {
      return null;
    }

    // usage（info.tokens{input,output}，字段存在才映射）
    TokenUsage? usage;
    final tokens = info['tokens'];
    if (tokens is Map) {
      final input = _toIntOrNull(tokens['input']);
      final output = _toIntOrNull(tokens['output']);
      if (input != null && output != null) {
        usage = TokenUsage(inputTokens: input, outputTokens: output);
      }
    }

    return ChatMessage(
      role: role,
      content: content,
      createdAt: _parseCreatedTime(info) ?? DateTime.now(),
      toolCalls: toolCalls.isEmpty ? null : List.unmodifiable(toolCalls),
      usage: usage,
      model: _nonEmpty(info['modelID']),
    );
  }

  /// tool part → ToolCallInfo（实测形状，APP-SERVER.md「工具回合实测」）：
  ///
  /// `{type:'tool', callID:'call_…', tool:'Bash'（字符串）,
  ///   state:{status:'completed'|'error'|…, input:{…}, output:'…'|error:'…',
  ///          title, metadata, time:{start,end}},
  ///   id:'part_…', sessionID, messageID}`
  ///
  /// 注意 id 键是 `callID`（大写 D）；input/output 嵌在 state 里；
  /// 失败时 state.error 携带原因（如权限拒绝的 "Permission request failed"
  /// 或我们应答的 reason 原文）。旧猜测形态（callId/顶层 input/output/
  /// state 为字符串）保留为兜底。
  ToolCallInfo _mapToolPart(Map p) {
    final tool = p['tool'];
    final String name;
    if (tool is String) {
      name = tool;
    } else if (tool is Map) {
      name = tool['name']?.toString() ?? 'tool';
    } else {
      name = 'tool';
    }

    // 实测 state 为对象：{status, input, output|error, time, …}
    final stateObj = p['state'];
    final String statusStr;
    dynamic input;
    dynamic output;
    String? errorText;
    if (stateObj is Map) {
      statusStr = stateObj['status']?.toString() ?? '';
      input = stateObj['input'];
      output = stateObj['output'];
      final err = stateObj['error'];
      if (err != null) errorText = err is String ? err : _summaryOf(err);
    } else {
      // 旧猜测形态兜底：state 为 'running'/'completed' 字符串
      statusStr = stateObj?.toString() ?? '';
      input = p['input'] ?? (tool is Map ? tool['input'] : null);
      output = p['output'] ?? p['result'];
    }

    final ToolCallStatus status;
    switch (statusStr) {
      case 'completed':
        status = ToolCallStatus.done;
        break;
      case 'error':
      case 'failed': // 显式失败档
        status = ToolCallStatus.error;
        break;
      default:
        // pending/running/未知状态一律视为进行中——未知 ≠ 失败（失败模式
        // 方向：宁可多等不误报；真实失败会带 state.error 并落 error 档）
        status = ToolCallStatus.running;
    }

    return ToolCallInfo(
      toolCallId: (p['callID'] ?? p['callId'])?.toString() ?? '',
      toolName: name,
      inputSummary: _summaryOf(input),
      // 失败时优先展示错误原因（实测权限拒绝会落在 state.error）
      outputSummary: errorText ?? _summaryOf(output),
      status: status,
      isError: status == ToolCallStatus.error,
    );
  }

  /// info.time.created → DateTime（毫秒时间戳或 ISO 字符串兜底）
  DateTime? _parseCreatedTime(Map info) {
    final time = info['time'];
    final created = time is Map ? time['created'] : null;
    final ms = _toIntOrNull(created);
    if (ms != null && ms > 0) return DateTime.fromMillisecondsSinceEpoch(ms);
    if (created is String) return DateTime.tryParse(created);
    return null;
  }

  /// 工具输入/输出摘要：String 原样，其他 JSON 化并限长
  String? _summaryOf(dynamic v) {
    if (v == null) return null;
    if (v is String) return v;
    try {
      final encoded = jsonEncode(v);
      return encoded.length > 400 ? '${encoded.substring(0, 400)}…' : encoded;
    } catch (_) {
      return v.toString();
    }
  }

  // ──────────────────────────────────────────────
  // 内部：持久化与工具函数
  // ──────────────────────────────────────────────

  Future<void> _persistPairing(ZcodePairingInfo info) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kPairingPrefsKey, jsonEncode(info.toJson()));
    } catch (_) {
      // 持久化失败不阻断配对流程
    }
  }

  Future<void> _clearPersistedPairing() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_kPairingPrefsKey);
    } catch (_) {
      // 忽略
    }
  }

  void _fail(String message) {
    _error = message;
    notifyListeners();
  }

  static int _toInt(dynamic v) => _toIntOrNull(v) ?? 0;

  static int? _toIntOrNull(dynamic v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v);
    return null;
  }

  static String? _nonEmpty(dynamic v) {
    final s = v?.toString();
    return s == null || s.isEmpty ? null : s;
  }

  /// 多字段名兜底取第一个非空字符串
  static String? _firstNonEmpty(Map map, List<String> keys) {
    for (final k in keys) {
      final s = _nonEmpty(map[k]);
      if (s != null) return s;
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // 仅测试使用的注入入口
  // ──────────────────────────────────────────────

  /// 仅测试使用：直接注入通知帧（等价于真实客户端的 onNotify 回调）
  @visibleForTesting
  void debugHandleNotify(ZcodeFrame frame) => _handleNotifyFrame(frame);

  /// 仅测试使用：手动触发一次流式轮询（不等待 1.2s 计时器）
  @visibleForTesting
  Future<void> debugPollOnce() => _pollOnce();

  /// 仅测试使用：直接注入反向请求（等价于真实客户端的 onRequest 钩子）
  @visibleForTesting
  Future<dynamic> debugHandleReverseRequest(ZcodeFrame frame) =>
      _handleReverseRequest(frame);

  /// 仅测试使用：模拟 relay 状态变化（重连/断线补放路径）
  @visibleForTesting
  void debugSimulateRelayState(ZcodeRelayState state, bool paired) =>
      _onRelayStateChange(state, paired);

  @override
  void dispose() {
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client?.close();
    _client = null;
    _permissionController.close();
    _askUserController.close();
    super.dispose();
  }
}
