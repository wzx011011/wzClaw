// ============================================================
// zcode_chat_store — ZCode 远程控制状态管理（ChangeNotifier）
//
// 【契约文件】类签名是并行开发公共契约，实现者补全，公共 API 不得改动。
//
// 职责：会话列表、当前会话消息、流式渲染与反向交互投影。
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
//
// 权限确认 / AskUser 由 ConnectionManager 持有的客户端经 ingest 接入；
// AskUser 类反向请求实测未触发，解析/应答仍为兜底形状。
//
// ConnectionManager 是唯一客户端 owner，本 store 是进程级单例，仅维护
// 当前桌面的会话投影；切换桌面时由 attach 传入 identity 并重置投影。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/chat_message.dart';
import '../models/goal_snapshot.dart';
import 'zcode_model_heal.dart';
import 'zcode_notifier.dart';
import 'zcode_relay_client.dart';
import 'zcode_reverse_models.dart';
import 'zcode_session_cache.dart';
import 'zcode_session_state.dart';

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

  /// 推理档位（引擎快照 reasoning.levels 的 value，如 low/high/max）。
  /// 非空时 setModel 必须带 options.reasoningLevel（实测契约，imported
  /// 模型缺失即 -32603）
  final List<String> reasoningLevels;
  final String? reasoningDefaultLevel;

  const ZcodeModelInfo({
    required this.providerId,
    required this.modelId,
    this.label,
    this.providerLabel,
    this.contextWindow,
    this.maxOutputTokens,
    this.reasoningLevels = const [],
    this.reasoningDefaultLevel,
  });

  /// 'providerId/modelId' 引用形态（setModel 兜底同款）
  String get ref => '$providerId/$modelId';

  /// setModel 所需的推理档位：默认档位（须在档位表内）优先，回退首个；
  /// 无档位返回 null
  String? get reasoningLevelForRequest {
    final def = reasoningDefaultLevel;
    if (def != null && reasoningLevels.contains(def)) return def;
    return reasoningLevels.isNotEmpty ? reasoningLevels.first : null;
  }

  /// UI 显示名：优先 label，退回 modelId
  String get displayName =>
      (label != null && label!.isNotEmpty) ? label! : modelId;
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
/// [request] 保留解析后的 UI 模型（含 sessionId）：待处理请求不再随视口
/// 切换被拒绝，展示条按 pending 队列轮转（应答/超时后自动顶上下一请求）。
class _PendingReverse {
  final dynamic frameId; // 反向请求帧 id（形如 "server-N"）
  final Completer<dynamic> completer;

  /// 解析后的请求模型（PermissionRequest / AskUserQuestion）
  final Object? request;

  _PendingReverse({
    required this.frameId,
    required this.completer,
    this.request,
  });
}

/// ZCode 远程控制 store
class ZcodeChatStore extends ChangeNotifier {
  /// App 作用域唯一会话投影。连接与配对生命周期归 ConnectionManager。
  static final ZcodeChatStore instance = ZcodeChatStore._raw(null);

  /// 注入缓存时构造隔离测试实例；生产无参数始终返回全局单例。
  factory ZcodeChatStore({ZcodeSessionCache? cache}) =>
      cache == null ? instance : ZcodeChatStore._raw(cache);

  ZcodeChatStore._raw(ZcodeSessionCache? cache) : _injectedCache = cache;

  final ZcodeSessionCache? _injectedCache;

  ZcodeRelayClient? _client;
  ZcodeSessionCache? _cacheInst;

  /// 惰性缓存实例（注入替身优先）
  ZcodeSessionCache get _cache =>
      _cacheInst ??= _injectedCache ?? ZcodeSessionCache();

  // ---- 全局状态 ----
  ZcodeConnState _connState = ZcodeConnState.idle;
  String? _error;

  /// 「模型不可用」且自动自愈失败：挂起等用户选择（选模型重试/新建会话）。
  /// 渲染为会话尾部操作卡片；成功发送 / 重试成功 / 迁移新会话后清除。
  String? modelBlockedSessionId;
  String? modelBlockedContent;
  String? modelBlockedReason;

  // ---- 当前连接的桌面身份（由 ConnectionManager attach 时提供）----

  String? desktopId;
  String desktopName = '桌面';

  List<ZcodeSessionMeta> _sessions = [];
  bool _sessionsLoading = false;
  bool _sessionsAutoLoaded = false;

  /// 节点引擎代次（companion x/engine/generation 推送；null=尚未收到）。
  /// 换代即作废全部会话物化/订阅（架构审查 P1-1）。
  int? _engineGeneration;

  // ---- 视口与每会话容器 ----

  /// 视口纪元：切换/关闭递增；在途异步操作携带发起时纪元，不匹配即丢弃
  int _epoch = 0;

  /// 视口指针（退化为指向 _states 中某个容器的引用）
  String? _activeSessionId;

  /// 每会话状态容器（含后台会话；按帧归属路由）
  final Map<String, ZcodeSessionState> _states = {};

  /// 每会话最多一个在途权威刷新；tool.result / batch / recovery 连续到达时
  /// 合并成串行拉取，防止旧响应在新结果之后回写状态。
  final Map<String, Future<void>> _authoritativeRefreshes = {};

  /// 收尾请求表：sessionId → 发起时的回合代次。tool.result / batch /
  /// recovery 连续到达时合并成串行拉取；完成时容器代次已前进（新回合
  /// 开始）则只做数据合并，绝不收尾新回合。
  final Map<String, int> _refreshFinishRequested = {};
  final Set<String> _queuedAuthoritativeRefreshes = {};

  /// 已知可用模型（state.updated 全量快照缓存；setModel 兜底用）
  final List<String> _availableModels = [];

  // ---- 工作区选择（欢迎页选择态；null = 跟随最近会话）----

  /// 用户显式选择的工作区（数据源 = store.sessions 分组，非引擎状态）。
  /// 引擎无"当前工作区"概念——这只影响 newSession 的 workspace 参数。
  /// 归属当前连接的桌面：detach（断开/切换桌面）时清空，绝不带到别的节点。
  String? _selectedWorkspaceKey;
  String? _selectedWorkspacePath;

  /// 当前生效的工作区路径（显式选择 ?? 默认回退）；供欢迎页 chip 显示
  String? get selectedWorkspacePath =>
      _selectedWorkspacePath ?? _defaultWorkspacePath;

  /// 当前生效的工作区 key（显式选择 ?? 默认回退）；供抽屉会话列表过滤
  String? get selectedWorkspaceKey =>
      _selectedWorkspaceKey ?? _defaultWorkspaceKey;

  /// 活动会话自己的工作区路径（会话列表/resume meta 权威数据）。
  /// 聊天页状态栏与 Git 工具的数据源——「新任务工作区选择」只决定
  /// newSession 参数，不能冒充活动会话的工作区。
  String? get activeSessionWorkspacePath {
    final sid = _activeSessionId;
    if (sid == null) return null;
    for (final s in _sessions) {
      if (s.sessionId == sid) return s.workspacePath;
    }
    return null;
  }

  String? get activeSessionWorkspaceKey {
    final sid = _activeSessionId;
    if (sid == null) return null;
    for (final s in _sessions) {
      if (s.sessionId == sid) return s.workspaceKey;
    }
    return null;
  }

  void selectWorkspace(String workspaceKey, String workspacePath) {
    _selectedWorkspaceKey = workspaceKey;
    _selectedWorkspacePath = workspacePath;
    notifyListeners();
  }

  /// 结构化模型目录（settings.model.available 全元数据；模型选择器数据源）
  final List<ZcodeModelInfo> _modelCatalog = [];

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

  /// 反向请求本地看护：key → 超时 Timer。桌面端对反向请求有 120s 看护，
  /// 超时后自动拒绝——手机端必须对齐（125s 余量），否则权限条还挂着、
  /// 用户点「允许」实际已被拒（与 a1af416「点允许实际拒绝」同类事故）。
  final Map<String, Timer> _reverseWatchdogs = {};

  /// UI 轻量通告（SnackBar 级提示，如反向请求等待超时）
  final StreamController<String> _uiNotices =
      StreamController<String>.broadcast();

  /// UI 层订阅：非阻断式提示（SnackBar）
  Stream<String> get uiNotices => _uiNotices.stream;

  // ──────────────────────────────────────────────
  // 状态 getter（notifyListeners 驱动 UI）
  // ──────────────────────────────────────────────

  ZcodeConnState get connState => _connState;

  String? get error => _error;

  List<ZcodeSessionMeta> get sessions => _sessions;

  /// 结构化模型目录（模型选择器数据源；快照播种，可能为空）
  List<ZcodeModelInfo> get modelCatalog => List.unmodifiable(_modelCatalog);

  /// 当前会话选中模型（'providerId/modelId'；未知为 null）。
  /// 会话级状态：读活动会话容器，后台会话的 patch 不串视口。
  String? get currentModelRef => _activeState?.modelRef;

  /// 当前会话思考强度（乐观值；setThoughtLevel 设置）。
  /// 会话级状态；协议快照未实测携带，无权威回填。
  String? get thoughtLevel => _activeState?.thoughtLevel;

  set thoughtLevel(String? value) {
    _activeState?.thoughtLevel = value;
  }

  bool get sessionsLoading => _sessionsLoading;

  String? get activeSessionId => _activeSessionId;

  /// 视口消息（当前会话容器的快照；无活动会话为空列表）
  List<ChatMessage> get messages =>
      _activeState?.chatMessages ?? const <ChatMessage>[];

  bool get isStreaming => _activeState?.isStreaming ?? false;

  /// 该会话是否正在本进程内运行（流式/等待中；后台会话同样覆盖）。
  /// 抽屉状态指示用——meta.status 跨进程可能 stale（实测 running 显示
  /// 为 idle），只有本进程状态是权威实时的。
  bool isSessionBusy(String sessionId) {
    final s = _states[sessionId];
    return s != null && (s.isStreaming || s.isWaitingForResponse);
  }

  // ── 回合块数据（最近一次已完成回合）──────────────
  int? get lastTurnMs => _activeState?.lastTurnMs;

  // ── 回合指标（首字延迟 / tok/s；口径见 ZcodeSessionState 注释）──
  /// 当前回合首字延迟（毫秒；首增量未到为 null）
  int? get firstTokenLatencyMs => _activeState?.firstTokenLatencyMs;

  /// 流式 tok/s 估算（字符速率 ÷ 自校准比率；无采样为 null。是估算，
  /// UI 必须标 ≈）
  double? get estimatedTokensPerSecond {
    final cps = _activeState?.liveCharsPerSecond();
    if (cps == null) return null;
    return cps / ZcodeSessionState.charsPerTokenEstimate;
  }

  /// 流式已耗时（运行中实时；空闲为 null）
  Duration? get streamElapsed => _activeState?.streamElapsed;

  /// 最近一次已完成回合的首字延迟（毫秒；未知为 null）
  int? get lastFirstTokenMs => _activeState?.lastFirstTokenMs;

  /// 最近一次已完成回合的权威 tok/s（未知为 null）
  double? get lastTurnTokensPerSecond => _activeState?.lastTurnTokensPerSecond;

  /// 当前视口会话是否正被桌面端应用运行（-32004；ChatPage 显示状态条用）
  bool get remoteActiveElsewhere =>
      _activeState?.remoteActiveElsewhere ?? false;

  /// 当前会话的上下文容量快照（0.16.9 state.updated contextUsage）。
  /// 空闲快照不带该字段 → null，UI 回退 session/usage 视图。
  ZcodeContextUsage? get activeContextUsage => _activeState?.contextUsage;

  /// 当前会话的后台任务投影（官方「后台任务」徽章数据源）
  List<Map<String, dynamic>> get activeBackgroundJobs =>
      _activeState?.backgroundJobs ?? const [];

  bool get isWaitingForResponse => _activeState?.isWaitingForResponse ?? false;

  /// 当前回合的实时思考内容（当前流式消息尾部 reasoning 行；canonical
  /// parts 是思考的唯一存储，没有独立缓冲）。
  String get liveThinkingText => _activeState?.liveThinkingText ?? '';

  /// 当前会话的权限模式（plan|build|edit|yolo|auto；null = 未知）
  String? get sessionMode => _activeState?.mode;

  /// 视口会话是否正在打开（未 materialize 且无缓存内容）——
  /// ChatPage 骨架屏判定用（派生态，不引入新状态字段）
  bool get sessionOpening {
    final state = _activeState;
    return state != null && !state.materialized && state.items.isEmpty;
  }

  /// openSession 异步流程（缓存秒开后的 resume/订阅/meta/尾窗）是否在途。
  /// 与 [sessionOpening]（骨架屏派生态）不同：缓存秒开内容就位后骨架已
  /// 消失，但权威运行状态尚未确认——排队消息的自动冲队以本旗标为准，
  /// 恢复结束前不得自动发送（2026-09-19 评审 P2）。
  bool get sessionRestoring => _sessionRestoring;
  bool _sessionRestoring = false;

  /// 会话标题（反向请求来源标注用；列表未含该会话时返回 null）
  String? sessionTitleFor(String? sessionId) {
    if (sessionId == null || sessionId.isEmpty) return null;
    for (final meta in _sessions) {
      if (meta.sessionId == sessionId) return meta.title;
    }
    return null;
  }

  /// 反向请求来源标注：请求不属于当前视口会话时给出可辨认的来源
  /// （会话标题或「后台会话」）；当前会话的请求返回 null（无需标注）。
  /// 权限条/问题条共用（2026-09-19 评审 P1：跨会话批准必须可见来源）。
  String? reverseSourceLabel(String? sessionId) {
    if (sessionId == null || sessionId.isEmpty) return null;
    if (sessionId == _activeSessionId) return null;
    final title = sessionTitleFor(sessionId);
    return (title == null || title.isEmpty) ? '来自后台会话' : '来自会话「$title」';
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

  // ── 连接层供帧 ──────────────────────────────────

  /// ConnectionManager 挂载其唯一客户端。切换桌面时重置全部会话投影，
  /// 客户端生命周期仍完全归 ConnectionManager。
  void attach(
    ZcodeRelayClient client, {
    required String desktopId,
    required String desktopName,
  }) {
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client = client;
    this.desktopId = desktopId;
    this.desktopName = desktopName;
    _connState = _relayStateToConn(client.currentState, client.paired);
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _states.clear();
    _sessionRestoring = false;
    _error = null;
    notifyListeners();
  }

  /// 宿主断开时清空投影，不关闭宿主客户端。
  void detach() {
    if (_client == null) return;
    _epoch++;
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client = null;
    desktopId = null;
    desktopName = '桌面';
    _connState = ZcodeConnState.idle;
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _states.clear();
    _sessionRestoring = false;
    _availableModels.clear();
    _modelCatalog.clear();
    // 工作区选择归属当前连接的桌面：切换/断开即失效，
    // 绝不把 A 节点选的工作区带给 B 节点的 newSession
    _selectedWorkspaceKey = null;
    _selectedWorkspacePath = null;
    _defaultWorkspaceKey = null;
    _defaultWorkspacePath = null;
    _resumeTitle = _resumeWsKey = _resumeWsPath = null;
    _error = null;
    notifyListeners();
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
          metas.add(
            ZcodeSessionMeta(
              sessionId: id,
              title: _nonEmpty(e['title']) ?? '（无标题会话）',
              updatedAt: _toInt(e['updatedAt']),
              workspaceKey: ws is Map ? _nonEmpty(ws['workspaceKey']) : null,
              workspacePath: ws is Map ? _nonEmpty(ws['workspacePath']) : null,
              status: _nonEmpty(e['status']),
            ),
          );
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
    // 权限/AskUser 待处理请求不随视口切换拒绝：它们归属会话与连接，
    // 浏览其他会话不影响其有效性；展示条按 pending 队列继续轮转
    _resumeTitle = _resumeWsKey = _resumeWsPath = null;
    _activeSessionId = sessionId;
    final state = _stateFor(sessionId)..epoch = epoch;
    // 恢复流程显式置位（2026-09-19 评审 P2）：有缓存秒开内容时
    // sessionOpening 派生态已是 false，但 resume/订阅/meta/尾窗仍在途——
    // 页面的排队自动冲队必须等恢复结束、权威运行状态就位后再发，
    // 否则会在 resume 窗口内按「默认空闲」误发队首。
    // 旗标归属本纪元（epoch 守卫收旗，见 finally）
    _sessionRestoring = true;
    notifyListeners();
    try {
      await _openSessionRestoring(client, sessionId, epoch, state);
    } finally {
      // 纪元守卫：期间又切了会话/断开重连，只有最新纪元有权收旗；
      // 收旗后补一次通告——正文的末次 notify 发生在收旗前，页面要看到
      // 「恢复结束」才会恢复排队自动冲队
      if (_epoch == epoch) {
        _sessionRestoring = false;
        notifyListeners();
      }
    }
  }

  /// openSession 的恢复正文：缓存秒开 → resume → 订阅 → meta → 尾窗。
  /// 恢复中旗标与纪元由 openSession 统一管理，本方法只做数据与状态。
  Future<void> _openSessionRestoring(
    ZcodeRelayClient client,
    String sessionId,
    int epoch,
    ZcodeSessionState state,
  ) async {
    // 1. 缓存秒开（容器为空时；尽力而为，失败静默）
    if (state.items.isEmpty) {
      await _loadFromCache(state);
      if (!_viewportValid(sessionId, epoch)) return; // 期间已切走
      notifyListeners();
    }

    // 2. resume 激活（materialize）——忽略 messages 数组
    Map? resumeResult;
    var needResume = !state.materialized;
    if (!needResume) {
      // 物化标记可能是旧引擎的遗留（换代通知丢失/进程外 close 等兜底）：
      // 轻量 read 探测存活，失败则降级重走 resume，不得跳过激活直接拉事件
      // （架构审查 P1-1「重开跳过 resume」入口）。
      try {
        final probe = await client.request('session/read', {
          'sessionId': sessionId,
        });
        if (state.epoch != epoch) return; // 旧纪元：丢弃
        if (probe is Map) _applyReadMeta(state, probe);
      } catch (e) {
        if (!_viewportValid(sessionId, epoch)) return;
        if (e is ZcodeRequestException && e.code == -32004) {
          state.remoteActiveElsewhere = true;
          state.isStreaming = false;
          state.isWaitingForResponse = false;
          _error = '该会话正在桌面端运行中，手机端无法实时查看其流式过程；'
              '桌面端回合结束后点"刷新"查看结果';
          notifyListeners();
          return;
        }
        state.materialized = false;
        needResume = true;
      }
    }
    if (needResume) {
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
      if (resumeResult['messagesTruncated'] == true && state.items.isNotEmpty) {
        state.insertHeadNotice('（历史较长，已截断，仅显示最近消息）');
      }
    }
    // 引擎契约（2026-09-17 探针实测）：回合未完成时 session/messages 返回
    // 空——刚发出消息就切走再点回会话会看到空白。显式说明而不是无声空屏；
    // 回合完成后 _refreshAuthoritative 会拉到历史并持久化，再进入即正常。
    if (state.items.isEmpty &&
        (state.isStreaming || state.isWaitingForResponse)) {
      state.insertHeadNotice(
        '（回合进行中：引擎在回合完成后才落库消息，稍后重新打开即可看到完整记录）',
      );
    }

    // 运行中：推送不可用 → 降级轮询；推送在用 → 武装看门狗
    if (state.isStreaming && !state.pushAvailable) {
      _startFallbackPollingFor(state.sessionId);
    } else if (state.isStreaming) {
      _armPushWatchdog(state);
    }
    _upsertOpenedListing(state);
    unawaited(_persistSession(state));
    // 截断缓存联网补齐（审查 P2-10）：截断的旧消息在水位之前，尾窗拉取
    // 永不重取；打开会话在线时按窗口回拉权威内容替换
    if (_viewportValid(sessionId, epoch)) {
      unawaited(_backfillTruncatedMessages(state, epoch));
    }
    if (_viewportValid(sessionId, epoch)) notifyListeners();
  }

  /// 截断缓存补齐：以第一条截断项的前一项为锚做窗口回拉，同 protoId
  /// 原位替换（权威 parts 原子取代），成功后清截断标记。失败保留标记，
  /// 下次打开会话重试——尽力而为，不阻塞视口。
  Future<void> _backfillTruncatedMessages(
    ZcodeSessionState state,
    int epoch,
  ) async {
    final client = _client;
    if (client == null || !client.paired) return;
    final first = state.items.indexWhere((e) => e.truncated && e.protoId != null);
    if (first < 0) return;
    final anchor = first > 0 ? state.items[first - 1].protoId : null;
    final count =
        state.items.where((e) => e.truncated && e.protoId != null).length;
    try {
      final result = await client.request('session/messages', {
        'sessionId': state.sessionId,
        if (anchor != null) 'afterMessageId': anchor,
        'limit': count + 8,
      });
      final messages = result is Map ? result['messages'] as List? : null;
      if (messages == null || messages.isEmpty) return;
      _mergeServerMessages(state, {'messages': messages});
      // 只清「本次回拉窗口实际覆盖」的标记（残余守卫）：merge 是按 protoId
      // 原位替换，被权威内容替换过的条目才恢复完整；窗口外（如 limit 截断
      // 未取到的更早消息）保留标记待下次补齐
      final fetched = <String>{
        for (final m in messages)
          if (m is Map && m['info'] is Map)
            if (_protocolMessageId(m['info'] as Map) case final fid?)
              fid,
      };
      for (final e in state.items) {
        if (e.truncated && e.protoId != null && fetched.contains(e.protoId)) {
          e.truncated = false; // 权威替换后恢复完整
        }
      }
      unawaited(_persistSession(state));
      if (_isActive(state) && state.epoch == epoch) notifyListeners();
    } catch (_) {
      // 补齐失败保留截断标记（下次打开重试）；不影响已展示内容
    }
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
    final hasExplicit = (workspaceKey?.isNotEmpty ?? false) &&
        (workspacePath?.isNotEmpty ?? false);
    // 未显式指定时：欢迎页显式选择的工作区优先，其次复用最近会话的
    // workspace（手机端不知道桌面路径）
    if (!hasExplicit && _selectedWorkspaceKey == null) {
      await refreshSessions(); // 刷一次列表以获得可复用工作区
    }
    final wsKey = hasExplicit
        ? workspaceKey
        : (_selectedWorkspaceKey ?? _defaultWorkspaceKey);
    final wsPath = hasExplicit
        ? workspacePath
        : (_selectedWorkspacePath ?? _defaultWorkspacePath);
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

  /// 关闭会话视图回到列表（订阅保留，后台会话继续收事件进缓存）。
  /// 待处理反向请求（权限/AskUser）保持有效——关闭的只是视口。
  void closeSessionView() {
    _epoch++;
    _stopFallbackPolling();
    _sessionRestoring = false;
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
      // 缓存按时间序返回：收集视口尚未包含的更早消息（从尾往头收集得到
      // 新→旧，反转成时间序），头部插入收口到 state.prependHistory——
      // 流式下标平移在那里统一处理（审查 P1-4）
      final older = <ZcodeSessionItem>[];
      for (var i = cached.length - 1; i >= 0; i--) {
        final it = cached[i];
        final pid = it.protoId;
        if (pid == null || known.contains(pid)) continue;
        known.add(pid);
        older.add(it);
      }
      final added = state.prependHistory(older.reversed.toList());
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
    state.beginLocalTurn(); // 新回合代次：旧回合迟到的权威收尾不得越界
    final turnGen = state.turnGeneration; // 本次发送的回合身份（审查 P1-3）
    state.appendLocalUserMessage(text);
    state.ensureStreamingPlaceholder();
    state.isStreaming = true;
    state.isWaitingForResponse = true;
    _error = null;
    notifyListeners();

    // 回合越界守卫：发送在途期间用户可能已开始新回合（T2），迟到的拒绝/
    // 异常回填不得收尾 T2（审查 P1-3「旧发送请求的错误回填新回合」）
    bool staleTurn() => state.turnGeneration != turnGen;

    try {
      final result = await client.request(
        'session/send',
        {'sessionId': sessionId, 'content': text},
      );
      if (result is String) {
        // 业务拒绝（字符串 result，非 error 帧）。仅"模型不可用"类拒绝
        // （APP-SERVER.md 实测记录的唯一形态）走 setModel 自动兜底；
        // 其他字符串拒绝按原文提示，不擅自改桌面端会话配置
        if (staleTurn()) return; // T2 已接管状态：丢弃本次迟到的拒绝
        if (result.contains('模型')) {
          await _handleSendRejection(state, text, result, turnGen: turnGen);
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
        if (staleTurn()) return;
        await _handleSendRejection(state, text, e.message, turnGen: turnGen);
        return;
      }
      if (staleTurn()) return; // 迟到异常：不得收尾新回合
      if (e is! ZcodeRequestException) {
        // 结果未知（超时/断开/网络错误——服务端可能已接受并继续执行）：
        // 先核对权威状态再表达，不得直接宣布失败或鼓励重发（审查 P1-3）
        await _resolveUnknownSendOutcome(state, e);
        return;
      }
      state.isWaitingForResponse = false;
      state.isStreaming = false;
      state.finalizeStreaming();
      _notifyIfActive(state);
      _fail('发送失败：$e');
      return;
    }
    // 已接受：模型阻塞卡若因本次发送挂起，此刻已解除
    modelBlockedSessionId = null;
    modelBlockedContent = null;
    modelBlockedReason = null;
    // 已接受：确保订阅（推送渲染）；推送不可用 → 降级轮询；
    // 推送在用 → 武装看门狗（防订阅静默失效导致流式冻住）
    await _ensureSubscribed(state);
    if (state.isStreaming && !state.pushAvailable && _isActive(state)) {
      _startFallbackPollingFor(state.sessionId);
    } else if (state.isStreaming) {
      _armPushWatchdog(state);
    }
  }

  /// 发送结果未知（超时/断开/网络错误——不是服务端拒绝）：先读权威状态
  /// 再表达，不得直接宣布失败或鼓励重发（审查 P1-3「结果未知 ≠ 失败」）。
  /// - 服务端 running：回合已被接受并继续执行 → 保持流式占位；
  /// - 服务端 idle：以权威刷新收敛（已完成的回合正常落位；若从未送达，
  ///   乐观消息被权威真相替换——单一真相原则）；
  /// - 查询也失败：保留占位并明示「结果未知」，等重连确认流程收尾。
  Future<void> _resolveUnknownSendOutcome(
    ZcodeSessionState state,
    Object cause,
  ) async {
    // 确认在途期间可能开始新回合（T2）：迟到的「当时 idle/running」采样
    // 不得收尾 T2——与 P1-6b 重连确认同一竞态形状，捕获代次核对（残余守卫）
    final confirmGen = state.turnGeneration;
    final client = _client;
    if (client == null || !client.paired) {
      state.isWaitingForResponse = false;
      if (_isActive(state)) {
        _error = '网络中断：发送结果未知。回合若已开始将继续在节点上运行，'
            '重连后自动确认状态';
        notifyListeners();
      }
      return;
    }
    try {
      final read = await client.request('session/read', {
        'sessionId': state.sessionId,
      });
      if (state.turnGeneration != confirmGen) return; // T2 已接管：丢弃采样
      final proj = read is Map ? read['projection'] : null;
      final status = proj is Map ? proj['status']?.toString() : null;
      if (status == 'running') {
        // 已接受：占位保持，恢复推送/轮询管线
        state.isWaitingForResponse = false;
        state.remoteActiveElsewhere = false;
        await _ensureSubscribed(state);
        if (state.isStreaming && !state.pushAvailable && _isActive(state)) {
          _startFallbackPollingFor(state.sessionId);
        } else if (state.isStreaming) {
          _armPushWatchdog(state);
        }
        if (_isActive(state)) {
          state.insertHeadNotice('（网络中断期间发送的回合仍在运行）');
          _error = null;
          notifyListeners();
        }
        return;
      }
      if (status == 'idle') {
        // 回合已结束（或从未送达）：权威刷新收敛到服务端真相。
        // _refreshAuthoritative 内部按发起时代次决定是否收尾，不会误杀新回合
        state.isWaitingForResponse = false;
        state.isStreaming = false;
        state.finalizeStreaming();
        await _refreshAuthoritative(state);
        _notifyIfActive(state);
        return;
      }
      // 未知状态（含 read 形状异常）：保守保留占位 + 明示未知
      state.isWaitingForResponse = false;
      if (_isActive(state)) {
        _error = '发送结果未知（状态：$status），请稍后刷新确认';
        notifyListeners();
      }
    } catch (_) {
      state.isWaitingForResponse = false;
      if (_isActive(state)) {
        _error = '网络中断：发送结果未知，回合状态待重连后确认';
        notifyListeners();
      }
    }
  }

  /// session/send「模型不可用」拒绝（字符串 result 或错误帧 -32031）：
  /// 用缓存的可用模型走共享自愈尾段（zcode_model_heal.dart：setModel →
  /// close → resume 重新物化 → 重发；probe-modelheal4 真链路验证时序，
  /// 只 setModel 重发仍 -32031）——兜底失败提示新建会话
  Future<void> _handleSendRejection(
    ZcodeSessionState state,
    String text,
    String reason, {
    int? turnGen,
  }) async {
    // 迟到的拒绝回填不得收尾新回合（审查 P1-3）
    if (turnGen != null && state.turnGeneration != turnGen) return;
    final client = _client;
    var attempted = false;
    var healError = '发送失败：$reason';
    if (client != null && client.paired && _availableModels.isNotEmpty) {
      final model = _availableModels.first;
      final slash = model.indexOf('/');
      if (slash > 0) {
        attempted = true;
        // 兜底模型的推理档位从快照目录解析：imported 模型不带档位会被
        // 引擎 -32603 拒绝，自愈永远失败
        final level = _modelCatalog
            .where((m) => m.ref == model)
            .map((m) => m.reasoningLevelForRequest)
            .firstWhere((l) => l != null, orElse: () => null);
        final error = await zcodeSetModelResend(
          request: client.request,
          sessionId: state.sessionId,
          content: text,
          providerId: model.substring(0, slash),
          modelId: model.substring(slash + 1),
          reason: reason,
          reasoningLevel: level,
        );
        if (error == null) {
          // 已恢复：继续走流式（期间可能已换代：换代即丢弃，T2 已接管）
          if (state.turnGeneration != turnGen) return;
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
    if (turnGen != null && state.turnGeneration != turnGen) return;
    state.isStreaming = false;
    state.isWaitingForResponse = false;
    state.finalizeStreaming();
    // 自愈失败：挂起「模型不可用」操作卡等待用户介入（选模型重试/新建会话）
    modelBlockedSessionId = state.sessionId;
    modelBlockedContent = text;
    modelBlockedReason = attempted ? healError : '发送失败：$reason';
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

  /// 子智能体线程（session/subagents）。0.16.9 实测 schema：sessionId
  /// 必填（缺省 -32602 ZodError，probe-surface-report 已钉）——作用于
  /// 当前活动会话。响应逐行经 _mapProtocolMessage 映射后按 info.agent
  /// 分组，最新线程在前。失败返回空列表（尽力而为）。
  Future<List<SubagentThread>> fetchSubagentThreads() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || !client.paired || sessionId == null) {
      return const [];
    }
    try {
      final result = await client.request('session/subagents', {
        'sessionId': sessionId,
        'action': 'show',
      });
      final rows = (result is Map ? result['messages'] : null) as List? ?? [];
      final byAgent = <String, List<Map<String, dynamic>>>{};
      for (final row in rows.whereType<Map>()) {
        final info = row['info'] is Map ? row['info'] as Map : const {};
        final agent = info['agent']?.toString() ?? '';
        final msg = _mapProtocolMessage(row);
        if (msg == null) continue;
        final time = info['time'] is Map ? info['time'] as Map : const {};
        byAgent.putIfAbsent(agent, () => []).add({
          'role': msg.role.name,
          'content': msg.text,
          'created_at': (time['created'] as num?)?.toInt() ?? 0,
        });
      }
      int newest(SubagentThread t) => t.messages
          .map((m) => (m['created_at'] as num?)?.toInt() ?? 0)
          .reduce((x, y) => x > y ? x : y);
      final threads = byAgent.entries
          .map((e) => SubagentThread(agent: e.key, messages: e.value))
          .toList()
        ..sort((a, b) => newest(b).compareTo(newest(a)));
      return threads;
    } catch (_) {
      return const [];
    }
  }

  /// 子智能体详情（probe-subagents-map 钉死的形状）：按 toolCallId 在
  /// running[] / ended.items[] 里找对应条目。ended 元素 =
  /// {childSessionId, agentId, toolCallId, subagentType, title, startedAt,
  /// status, summary}；running 条目同构（status/summary 可能为空）。
  /// 找不到 / 未连接 / 失败返回 null（尽力而为）。
  Future<Map<String, dynamic>?> fetchSubagentDetail(String toolCallId) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || !client.paired || sessionId == null) return null;
    try {
      final result = await client.request('session/subagents', {
        'sessionId': sessionId,
      });
      if (result is! Map) return null;
      final phases = <String, Object?>{
        'running': result['running'],
        'ended': (result['ended'] is Map)
            ? (result['ended'] as Map)['items']
            : null,
      };
      for (final entry in phases.entries) {
        final items = entry.value;
        if (items is! List) continue;
        for (final item in items) {
          if (item is Map && item['toolCallId'] == toolCallId) {
            return {
              ...item.cast<String, dynamic>(),
              'phase': entry.key,
            };
          }
        }
      }
      return null;
    } catch (_) {
      return null;
    }
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
    // close 成功 = 该会话在本引擎已释放（引擎无 delete，记录仍在列表）：
    // 必须作废物化/订阅，否则重开会话会跳过 resume，向已关闭会话拉事件
    // （架构审查 P1-1 的 session/close 入口）。
    final closed = _states[sessionId];
    if (closed != null) {
      closed.materialized = false;
      closed.subscribed = false;
      closed.lastSeq = 0;
    }
    if (_activeSessionId == sessionId) closeSessionView();
    await refreshSessions();
  }

  /// 清除「模型不可用」阻塞卡（重试成功 / 新建会话迁移后调用）
  void clearModelBlocked() {
    if (modelBlockedSessionId == null &&
        modelBlockedContent == null &&
        modelBlockedReason == null) {
      return;
    }
    modelBlockedSessionId = null;
    modelBlockedContent = null;
    modelBlockedReason = null;
    notifyListeners();
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
  void respondToPermission(
    String toolCallId, {
    required bool approved,
    bool remember = false,
  }) {
    _clearReverseWatchdog(toolCallId);
    final pending = _pendingReverse.remove(toolCallId);
    if (pending == null) return; // 没有对应待处理请求（可能已应答/已断开）
    final options = _permissionOptions.remove(toolCallId);
    pending.completer.complete(
      _buildPermissionResult(
        options: options,
        approved: approved,
        remember: remember,
      ),
    );
    // 应答完成：展示条轮转到队列里下一个权限请求（如有）
    _refreshReverseUi();
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
      final wanted =
          approved ? (remember ? 'allow_project' : 'allow_once') : 'deny';
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
  void respondToAskUser(
    String questionId,
    List<String> answers, {
    String? customText,
  }) {
    _clearReverseWatchdog(questionId);
    final pending = _pendingReverse.remove(questionId);
    if (pending == null) return;
    pending.completer.complete({
      'questionId': questionId,
      'selectedLabels': answers,
      if (customText != null && customText.isNotEmpty) 'customText': customText,
    });
    // 应答完成：展示条轮转到队列里下一个 AskUser 请求（如有）
    _refreshReverseUi();
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
      final request = _parsePermissionRequest(
        params,
        fallbackId: frame.id?.toString(),
      );
      if (request == null) {
        throw Exception('无法解析权限请求: $method');
      }
      return _awaitReverseResponse(
        key: request.toolCallId,
        frameId: frame.id,
        request: request,
        onRegistered: () {
          // 后台通知：任务挂起等人批准，不提醒会无声卡住
          _notifier.showReverseRequest(isAskUser: false, summary: request.toolName);
          _refreshReverseUi();
        },
      );
    }

    // UNVERIFIED：AskUser 反向请求从未实测触发，方法名未知——保留模糊网
    // 兜底（interaction/askuser/ask_user），解析失败自然落入安全拒绝
    final lower = method.toLowerCase();
    if (lower.contains('interaction') ||
        lower.contains('askuser') ||
        lower.contains('ask_user')) {
      final question = _parseAskUserQuestion(
        params,
        fallbackId: frame.id?.toString(),
      );
      if (question == null) {
        throw Exception('无法解析互动请求: $method');
      }
      return _awaitReverseResponse(
        key: question.questionId,
        frameId: frame.id,
        request: question,
        onRegistered: () {
          // 后台通知：任务挂起等人回答，不提醒会无声卡住
          _notifier.showReverseRequest(isAskUser: true, summary: question.question);
          _refreshReverseUi();
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
    Object? request,
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
    _pendingReverse[key] = _PendingReverse(
      frameId: frameId,
      completer: completer,
      request: request,
    );
    _armReverseWatchdog(key);
    onRegistered();
    return completer.future;
  }

  /// 反向请求展示队列轮转：展示条始终指向 pending 队列里最早的同类请求
  /// （权限/AskUser 各一条，可并存）。注册/应答/超时后调用——并发请求
  /// 不再互相覆盖，导航切换视口也不影响展示与有效性。
  void _refreshReverseUi() {
    PermissionRequest? permission;
    AskUserQuestion? askUser;
    for (final pending in _pendingReverse.values) {
      final request = pending.request;
      if (request is PermissionRequest) {
        permission ??= request;
      } else if (request is AskUserQuestion) {
        askUser ??= request;
      }
    }
    if (permission != _activePermission) {
      _activePermission = permission;
      if (!_permissionController.isClosed) _permissionController.add(permission);
    }
    if (askUser != _activeAskUser) {
      _activeAskUser = askUser;
      if (!_askUserController.isClosed) _askUserController.add(askUser);
    }
    notifyListeners();
  }

  /// 桌面端对反向请求的看护是 120s 自动拒绝；本地 125s 余量对齐——
  /// 超时后清条 + 通告，绝不留一个「点了允许也无效」的僵尸权限条。
  void _armReverseWatchdog(String key) {
    _reverseWatchdogs[key]?.cancel();
    _reverseWatchdogs[key] = Timer(const Duration(seconds: 125), () {
      _reverseWatchdogs.remove(key);
      final pending = _pendingReverse.remove(key);
      if (pending != null && !pending.completer.isCompleted) {
        pending.completer.completeError(
          const ZcodeReverseRejectException('等待超时，桌面端已自动拒绝'),
        );
      }
      _permissionOptions.remove(key);
      var cleared = false;
      if (_activePermission?.toolCallId == key ||
          _activeAskUser?.questionId == key) {
        cleared = true;
      }
      // 展示条轮转：超时请求出队，下一个同类请求（如有）顶上
      _refreshReverseUi();
      if (cleared && !_uiNotices.isClosed) {
        _uiNotices.add('等待超时：桌面端已自动拒绝该请求');
      }
    });
  }

  void _clearReverseWatchdog(String key) {
    _reverseWatchdogs.remove(key)?.cancel();
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
      sessionId: _firstNonEmpty(params, ['sessionId', 'session_id']),
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

    final multi = params['multiSelect'] ??
        params['multi_select'] ??
        params['multiselect'];
    return AskUserQuestion(
      questionId: questionId,
      question: question,
      options: mapped,
      multiSelect: multi == true || multi == 'true',
      sessionId: _firstNonEmpty(params, ['sessionId', 'session_id']),
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
    for (final w in _reverseWatchdogs.values) {
      w.cancel();
    }
    _reverseWatchdogs.clear();
    for (final e in entries) {
      if (!e.value.completer.isCompleted) {
        e.value.completer.completeError(
          const ZcodeReverseRejectException('连接已更换/断开，请求作废'),
        );
      }
    }
    // pending 已清空：展示条随之清除（队列轮转的唯一出口）
    _refreshReverseUi();
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
      case 'x/engine/generation':
        _handleEngineGeneration(params);
        return;
    }
  }

  /// 引擎代次（companion 在 app-server 首次 spawn 与每次 respawn 时推送）。
  /// 换代必须显式作废全部会话的物化/订阅/事件水位——「relay 连着」不代表
  /// 「会话还在同一引擎运行」（架构审查 P1-1）：新进程既无旧激活也无旧订阅，
  /// 保留 materialized/subscribed 会让重开/看门狗继续向死状态操作。
  void _handleEngineGeneration(Map params) {
    final raw = params['generation'];
    final generation = raw is int ? raw : int.tryParse('$raw');
    if (generation == null) return;
    final previous = _engineGeneration;
    _engineGeneration = generation;
    if (previous == null || previous == generation) return; // 首见 / 未换代
    var invalidated = 0;
    for (final state in _states.values) {
      final hadLive = state.materialized ||
          state.subscribed ||
          state.isStreaming ||
          state.isWaitingForResponse;
      if (!hadLive) continue;
      invalidated++;
      state.materialized = false;
      state.subscribed = false;
      state.lastSeq = 0; // 旧引擎的 eventSeq 空间作废，重新物化后从头补放
      if (state.isStreaming || state.isWaitingForResponse) {
        state.isStreaming = false;
        state.isWaitingForResponse = false;
        state.insertHeadNotice('（引擎已重启：上一回合状态未知，重新打开会话以恢复）');
      }
      _stopFallbackPollingFor(state.sessionId);
    }
    debugPrint('[zcode-store] 引擎换代 $previous→$generation：'
        '作废 $invalidated 个会话的物化/订阅');
    notifyListeners();
  }

  /// state.updated 补丁：status running/idle、模型可用列表缓存；
  /// 无 sessionId 的帧（兼容路径/测试注入）落到视口会话
  void _handleStateUpdated(Map params) {
    final patch = params['patch'];
    if (patch is! Map) return;
    // 可用目录是节点级投影（全局缓存）；current 是会话级选中，
    // 路由到对应容器，后台会话的补丁不串视口（#12）
    final modelPatch = patch['model'];
    _cacheModelCatalog(modelPatch);

    final sid = _nonEmpty(params['sessionId']);
    final state = sid == null ? _activeState : _states[sid];
    if (state != null) _applyCurrentModelRef(state, modelPatch);
    // 上下文容量快照（0.16.9 state.updated contextUsage；兼容 patch 层与
    // 快照顶层两种取值路径，schema 见 APP-SERVER.md OQ1 定论）
    final contextUsageRaw = patch['contextUsage'] ?? params['contextUsage'];
    final contextUsage = ZcodeContextUsage.fromEngineJson(contextUsageRaw);
    if (contextUsage != null && state != null) state.contextUsage = contextUsage;
    // 后台任务投影（0.16.9）：整体替换，元素形状见 state 字段注释
    final bgJobs = patch['backgroundJobs'];
    if (bgJobs is List && state != null) {
      state.backgroundJobs = bgJobs
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(growable: false);
    }
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

    // activeToolCalls 是整体替换的实时快照，只补状态，不删除已经写入过程
    // 时间线的历史工具项；tool.updated 仍是输入/输出的主来源。
    final activeToolCalls = patch['activeToolCalls'];
    if (activeToolCalls is List) {
      state.reconcileActiveTools(
        _mapActiveToolCalls(activeToolCalls),
      );
      _notifyIfActive(state);
    }

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

  /// v4/telemetry/event：usage.delta 记 token；turn.terminal 回合收尾。
  /// telemetry 与 session/event 会复用 eventId，必须先去重，避免同一工具
  /// 生命周期把过程行写两次；它没有 session/event 的 seq，不能推进 lastSeq。
  void _handleTelemetry(Map params) {
    final sid = _nonEmpty(params['sessionId']);
    if (sid != null && _states[sid] == null) return; // 未知会话：忽略
    final state = sid == null ? _activeState : _states[sid];
    if (state == null) return;
    final eventId = _nonEmpty(params['eventId']);
    if (eventId != null && !state.rememberEvent(eventId)) return;

    final kind = _nonEmpty(params['kind']);
    if (kind == 'usage.delta') {
      state.lastInputTokens =
          _toIntOrNull(params['inputTokens']) ?? state.lastInputTokens;
      state.lastOutputTokens =
          _toIntOrNull(params['outputTokens']) ?? state.lastOutputTokens;
    } else if (kind == 'tool.lifecycle') {
      _applyToolLifecycleTelemetry(state, params);
      _notifyIfActive(state);
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

  /// model.streaming 的过程投影。工具参数与正文是不同的协议通道：
  /// tool_input_delta 只组装工具输入，绝不可当作 assistant 文本输出。
  void _applyModelStreaming(
    ZcodeSessionState state,
    Map payload, {
    String? turnId,
  }) {
    final kind = _nonEmpty(payload['kind']) ?? 'text_delta';
    final assistantId = _firstNonEmpty(
      payload,
      ['assistantMessageId', 'assistant_message_id', 'messageId'],
    );
    if (assistantId != null) {
      state.adoptStreamingProtoId(assistantId, turnId: turnId);
    }
    final delta = payload['delta'];
    switch (kind) {
      case 'text_delta':
        if (delta is String && delta.isNotEmpty) {
          state.appendTextDelta(
            delta,
            assistantMessageId: assistantId,
            turnId: turnId,
          );
        }
        return;
      case 'reasoning_delta':
        if (delta is String && delta.isNotEmpty) {
          state.appendThinkingDelta(
            delta,
            assistantMessageId: assistantId,
            turnId: turnId,
          );
        }
        return;
      case 'tool_input_start':
        final toolCallId = _nonEmpty(payload['toolCallId']);
        if (toolCallId == null) {
          debugPrint('[zcode-store] tool_input_start 缺少 toolCallId '
              'session=${state.sessionId}');
          return;
        }
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: state.streamingTool(toolCallId),
            lifecycle: 'input_streaming',
            input: '',
            hasInput: true,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'tool_input_delta':
        final toolCallId = _nonEmpty(payload['toolCallId']);
        if (toolCallId == null || delta is! String) {
          debugPrint('[zcode-store] tool_input_delta 形状不完整 '
              'session=${state.sessionId}');
          return;
        }
        final previous = state.streamingTool(toolCallId);
        final input = '${previous?.inputFull ?? ''}$delta';
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'input_streaming',
            input: input,
            hasInput: true,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'tool_input_end':
        final toolCallId = _nonEmpty(payload['toolCallId']);
        if (toolCallId == null) {
          debugPrint('[zcode-store] tool_input_end 缺少 toolCallId '
              'session=${state.sessionId}');
          return;
        }
        final previous = state.streamingTool(toolCallId);
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'input_ready',
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'tool_call':
        final toolCallId = _nonEmpty(payload['toolCallId']);
        if (toolCallId == null) {
          debugPrint('[zcode-store] tool_call 缺少 toolCallId '
              'session=${state.sessionId}');
          return;
        }
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: state.streamingTool(toolCallId),
            lifecycle: 'input_ready',
            input: payload['input'],
            hasInput: payload.containsKey('input'),
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      // 边界事件可能因协议过滤根本不抵达手机；已知但无内容的边界不记成
      // 未知协议，以免正常会话日志被噪声淹没。
      case 'start':
      case 'finish':
      case 'text_start':
      case 'text_end':
      case 'reasoning_start':
      case 'reasoning_end':
        return;
      case 'error':
        debugPrint('[zcode-store] model.streaming error '
            'session=${state.sessionId}');
        return;
      default:
        debugPrint('[zcode-store] model.streaming 未处理 kind=$kind '
            'session=${state.sessionId}');
        return;
    }
  }

  /// tool.updated 的生命周期更新。scheduled 是工具在过程流中的插入点；
  /// 后续事件只修改该 callId 的同一过程项，保持并发调用的原始顺序。
  void _applyToolUpdated(
    ZcodeSessionState state,
    Map payload, {
    String? turnId,
  }) {
    final kind = _nonEmpty(payload['kind']);
    if (kind == 'batch') {
      final ids = payload['toolCallIds'];
      if (ids is! List) {
        debugPrint('[zcode-store] tool.updated batch 缺少 toolCallIds '
            'session=${state.sessionId}');
        return;
      }
      final successCount = _toIntOrNull(payload['successCount']) ?? 0;
      final errorCount = _toIntOrNull(payload['errorCount']) ?? 0;
      for (final rawId in ids) {
        final id = _nonEmpty(rawId);
        if (id == null) continue;
        final previous = state.streamingTool(id);
        if (previous == null) continue;
        final allFailed = errorCount > 0 && successCount == 0;
        state.upsertStreamingTool(
          previous.copyWith(
            lifecycle: 'batch',
            status: allFailed && previous.status == ToolCallStatus.running
                ? ToolCallStatus.error
                : previous.status,
            isError: allFailed || previous.isError,
            outputSummary: allFailed && previous.outputSummary == null
                ? '工具批次执行失败，正在同步权威结果'
                : previous.outputSummary,
            outputFull: allFailed && previous.outputFull == null
                ? '工具批次执行失败，正在同步权威结果'
                : previous.outputFull,
          ),
          turnId: turnId,
        );
      }
      // batch 只是一个并行组边界，不等同整个回合完成。发起非收尾刷新可尽早
      // 用权威工具 part 回填；若尚未提交，随后 recovery 会再排一次刷新。
      unawaited(_refreshAuthoritative(state, finishTurn: false));
      return;
    }

    final toolCallId = _nonEmpty(payload['toolCallId']);
    if (toolCallId == null || kind == null) {
      debugPrint('[zcode-store] tool.updated 形状不完整 kind=$kind '
          'session=${state.sessionId}');
      return;
    }
    final assistantId = _nonEmpty(payload['assistantMessageId']);
    final previous = state.streamingTool(toolCallId);
    switch (kind) {
      case 'scheduled':
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'scheduled',
            input: payload['input'],
            hasInput: payload.containsKey('input'),
            status: ToolCallStatus.running,
            isError: false,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'started':
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'started',
            status: ToolCallStatus.running,
            isError: false,
            startedAt: _parseEventTime(payload['startedAt']),
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'progress':
        final tail = _firstNonEmpty(payload, ['stdoutTail', 'stderrTail']);
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'progress',
            status: ToolCallStatus.running,
            isError: false,
            elapsedMs: _toIntOrNull(payload['elapsedMs']),
            output: tail,
            hasOutput: tail != null && previous?.outputFull == null,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        return;
      case 'result':
        final result =
            payload['result'] is Map ? payload['result'] as Map : const {};
        final success = result['success'] == true;
        final output =
            success ? result['content'] : _toolErrorText(result['error']);
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'result',
            status: success ? ToolCallStatus.done : ToolCallStatus.error,
            isError: !success,
            output: output,
            hasOutput: output != null,
            elapsedMs: _toIntOrNull(payload['duration']) ??
                _toIntOrNull(result['duration']) ??
                _toIntOrNull(
                  (result['perf'] is Map)
                      ? (result['perf'] as Map)['totalMs']
                      : null,
                ),
            outputTruncated: result['truncated'] == true,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        unawaited(_refreshAuthoritative(state, finishTurn: false));
        return;
      case 'error':
        final error = _toolErrorText(payload['error']);
        state.upsertStreamingTool(
          _updatedTool(
            toolCallId: toolCallId,
            payload: payload,
            previous: previous,
            lifecycle: 'error',
            status: ToolCallStatus.error,
            isError: true,
            output: error,
            hasOutput: error != null,
          ),
          assistantMessageId: assistantId,
          turnId: turnId,
        );
        unawaited(_refreshAuthoritative(state, finishTurn: false));
        return;
      case 'raw':
        debugPrint('[zcode-store] tool.updated raw 已保留待权威回填 '
            'tool=$toolCallId session=${state.sessionId}');
        return;
      default:
        debugPrint('[zcode-store] tool.updated 未处理 kind=$kind '
            'tool=$toolCallId session=${state.sessionId}');
        return;
    }
  }

  void _applyPermissionRequested(
    ZcodeSessionState state,
    Map payload, {
    String? turnId,
  }) {
    final toolCallId = _nonEmpty(payload['toolCallId']);
    if (toolCallId == null) {
      debugPrint('[zcode-store] permission.requested 缺少 toolCallId '
          'session=${state.sessionId}');
      return;
    }
    state.upsertStreamingTool(
      _updatedTool(
        toolCallId: toolCallId,
        payload: payload,
        previous: state.streamingTool(toolCallId),
        lifecycle: 'permission_requested',
        status: ToolCallStatus.running,
        isError: false,
        input: payload['input'],
        hasInput: payload.containsKey('input'),
      ),
      assistantMessageId: _nonEmpty(payload['assistantMessageId']),
      turnId: turnId,
    );
  }

  void _applyPermissionResolved(
    ZcodeSessionState state,
    Map payload, {
    String? turnId,
  }) {
    final toolCallId = _nonEmpty(payload['toolCallId']);
    if (toolCallId == null) {
      debugPrint('[zcode-store] permission.resolved 缺少 toolCallId '
          'session=${state.sessionId}');
      return;
    }
    final denied = _nonEmpty(payload['decision']) == 'deny';
    final reason = _nonEmpty(payload['reason']);
    state.upsertStreamingTool(
      _updatedTool(
        toolCallId: toolCallId,
        payload: payload,
        previous: state.streamingTool(toolCallId),
        lifecycle: denied ? 'permission_denied' : 'permission_granted',
        status: denied ? ToolCallStatus.error : ToolCallStatus.running,
        isError: denied,
        output: denied ? reason : null,
        hasOutput: denied && reason != null,
      ),
      assistantMessageId: _nonEmpty(payload['assistantMessageId']),
      turnId: turnId,
    );
  }

  void _applyToolLifecycleTelemetry(ZcodeSessionState state, Map payload) {
    final toolCallId = _nonEmpty(payload['toolCallId']);
    final phase = _nonEmpty(payload['phase']);
    if (toolCallId == null || phase == null) {
      debugPrint('[zcode-store] telemetry tool.lifecycle 形状不完整 '
          'session=${state.sessionId}');
      return;
    }
    final previous = state.streamingTool(toolCallId);
    final completed = phase == 'completed';
    state.upsertStreamingTool(
      _updatedTool(
        toolCallId: toolCallId,
        payload: payload,
        previous: previous,
        lifecycle: 'telemetry_$phase',
        status: completed ? ToolCallStatus.done : ToolCallStatus.running,
        isError: false,
        elapsedMs: _toIntOrNull(payload['durationMs']) ??
            _toIntOrNull(payload['elapsedMs']),
        startedAt: _parseEventTime(payload['startedAt']),
      ),
      assistantMessageId: _nonEmpty(payload['assistantMessageId']),
      turnId: _nonEmpty(payload['turnId']),
    );
    if (completed) unawaited(_refreshAuthoritative(state, finishTurn: false));
  }

  List<ToolCallInfo> _mapActiveToolCalls(List raw) {
    final calls = <ToolCallInfo>[];
    for (final value in raw) {
      if (value is! Map) continue;
      final id = _nonEmpty(value['toolCallId']);
      final name = _toolName(value);
      if (id == null || name == null) {
        debugPrint('[zcode-store] activeToolCalls 条目不完整，已跳过');
        continue;
      }
      final rawStatus = _nonEmpty(value['status']);
      final failed = rawStatus == 'failed' || rawStatus == 'denied';
      calls.add(
        _updatedTool(
          toolCallId: id,
          payload: value,
          lifecycle: rawStatus == 'pending'
              ? 'scheduled'
              : rawStatus == 'denied'
                  ? 'permission_denied'
                  : rawStatus,
          status: failed
              ? ToolCallStatus.error
              : rawStatus == 'completed'
                  ? ToolCallStatus.done
                  : ToolCallStatus.running,
          isError: failed,
          startedAt: _parseEventTime(value['startedAt']),
        ),
      );
    }
    return calls;
  }

  ToolCallInfo _updatedTool({
    required String toolCallId,
    required Map payload,
    ToolCallInfo? previous,
    String? lifecycle,
    ToolCallStatus? status,
    bool? isError,
    dynamic input,
    bool hasInput = false,
    dynamic output,
    bool hasOutput = false,
    int? elapsedMs,
    DateTime? startedAt,
    bool? outputTruncated,
  }) {
    final inputMap = input is Map
        ? input
        : (payload['input'] is Map ? payload['input'] as Map : const {});
    final metadata =
        payload['metadata'] is Map ? payload['metadata'] as Map : const {};
    String? meta(List<String> keys) =>
        _firstNonEmpty(payload, keys) ??
        _firstNonEmpty(inputMap, keys) ??
        _firstNonEmpty(metadata, keys);
    final name = _toolName(payload) ?? previous?.toolName ?? 'Tool';
    final toolStatus = status ?? previous?.status ?? ToolCallStatus.running;
    final toolError =
        isError ?? previous?.isError ?? toolStatus == ToolCallStatus.error;
    final canRunParallel = payload['canRunParallel'] is bool
        ? payload['canRunParallel'] as bool
        : previous?.canRunParallel ?? false;
    final background = payload['background'] is bool
        ? payload['background'] as bool
        : previous?.background ?? false;
    return ToolCallInfo(
      toolCallId: toolCallId,
      toolName: name,
      inputSummary: hasInput ? _summaryOf(input) : previous?.inputSummary,
      outputSummary: hasOutput ? _summaryOf(output) : previous?.outputSummary,
      status: toolStatus,
      isError: toolError,
      inputFull: hasInput ? _fullOf(input) : previous?.inputFull,
      outputFull: hasOutput ? _fullOf(output) : previous?.outputFull,
      lifecycle: lifecycle ?? previous?.lifecycle,
      elapsedMs: elapsedMs ?? previous?.elapsedMs,
      startedAt: startedAt ?? previous?.startedAt,
      parallelGroupIndex: _toIntOrNull(payload['parallelGroupIndex']) ??
          previous?.parallelGroupIndex,
      canRunParallel: canRunParallel,
      subagentType:
          meta(['subagentType', 'subagent_type', 'agentType', 'agent_type']) ??
              previous?.subagentType,
      childSessionId: meta(['childSessionId', 'child_session_id']) ??
          previous?.childSessionId,
      parentToolCallId: meta(['parentToolCallId', 'parent_tool_call_id']) ??
          previous?.parentToolCallId,
      source: meta(['source']) ?? previous?.source,
      agentId: meta(['agentId', 'agent_id']) ?? previous?.agentId,
      background: background,
      description: meta(['description']) ?? previous?.description,
      outputTruncated: outputTruncated ?? previous?.outputTruncated ?? false,
      // 先败后成 = 已重试恢复：生命周期内见错即置位并随缓存持久化
      everError: toolError || (previous?.everError ?? false),
    );
  }

  String? _toolName(Map payload) {
    final direct = _firstNonEmpty(payload, ['toolName', 'tool_name', 'name']);
    if (direct != null) return direct;
    final tool = payload['tool'];
    if (tool is String && tool.isNotEmpty) return tool;
    if (tool is Map) return _firstNonEmpty(tool, ['name', 'toolName']);
    return null;
  }

  String? _toolErrorText(dynamic raw) {
    if (raw == null) return null;
    if (raw is String) return raw;
    if (raw is Map) {
      return _firstNonEmpty(raw, [
            'message',
            'detail',
            'underlyingErrorMessage',
            'underlyingErrorDetail',
          ]) ??
          _summaryOf(raw);
    }
    return _summaryOf(raw);
  }

  DateTime? _parseEventTime(dynamic raw) {
    final ms = _toIntOrNull(raw);
    if (ms != null && ms > 0) return DateTime.fromMillisecondsSinceEpoch(ms);
    if (raw is String) return DateTime.tryParse(raw);
    return null;
  }

  bool _isCommittedToolRecovery(Map payload) {
    final kind = _nonEmpty(payload['kind']);
    if (kind != 'tool_result' && kind != 'tool_error') return false;
    final committed = payload['committedToolCallIds'];
    return _nonEmpty(payload['resultPartId']) != null ||
        (committed is List && committed.isNotEmpty);
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
        state.noteTurnStart(turnId); // 回合代次：新回合开始即前进
        final messageId =
            _nonEmpty(payload['messageId']) ?? _nonEmpty(payload['message_id']);
        final input = payload['input'];
        if (messageId != null && input is String && input.isNotEmpty) {
          state.ensureUserMessage(
            protoId: messageId,
            content: input,
            turnId: turnId,
          );
        }
        _armPushWatchdog(state); // 桌面端发起的回合同样受看门狗保护
        _notifyIfActive(state);
        return;
      case 'model.streaming':
        state.isStreaming = true; // 收到流式增量即视作运行（含兜底收尾后恢复）
        _applyModelStreaming(state, payload, turnId: turnId);
        _notifyIfActive(state);
        return;
      case 'text_delta':
        state.isStreaming = true;
        final delta = payload['delta'];
        if (delta is String && delta.isNotEmpty) {
          state.appendTextDelta(delta, turnId: turnId);
          _notifyIfActive(state);
        }
        return;
      case 'reasoning_delta':
        state.isStreaming = true;
        final delta = payload['delta'];
        if (delta is String && delta.isNotEmpty) {
          state.appendThinkingDelta(delta, turnId: turnId);
          _notifyIfActive(state);
        }
        return;
      case 'tool.updated':
        state.isStreaming = true;
        _applyToolUpdated(state, payload, turnId: turnId);
        _notifyIfActive(state);
        return;
      case 'permission.requested':
        state.isStreaming = true;
        _applyPermissionRequested(state, payload, turnId: turnId);
        _notifyIfActive(state);
        return;
      case 'permission.resolved':
        _applyPermissionResolved(state, payload, turnId: turnId);
        _notifyIfActive(state);
        return;
      case 'streamRecovery.updated':
        // recovery 只证明某个工具结果已落入持久化历史；绝不拿其载荷覆盖
        // 文本/工具内容，权威 session/messages 才可原子替换过程列表。
        if (_isCommittedToolRecovery(payload)) {
          unawaited(_refreshAuthoritative(state, finishTurn: false));
        } else {
          debugPrint('[zcode-store] streamRecovery 状态更新 '
              'kind=${payload['kind']} session=${state.sessionId}');
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
  /// - 本地 response 只用于避免结束瞬间文本闪空；
  /// - 每个完成回合都拉取 session/messages，以正文/思考/工具的权威 part
  ///   数组取代实时投影，确保跨重启的顺序一致；
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
      // 有回合在途：核对回合身份（审查 P1-3 终端事件入口）。仅在能确定
      // 当前在途回合是「另一个」turnId 时判陈旧（本地新回合已发起但
      // turn.started 未到的窗口里 lastSeenTurnId 为 null，无法证明身份，
      // 保持原收尾路径；该窗口由 turn.started 随后到达自愈）——旧回合的
      // 迟到终态只补权威数据，绝不解除当前回合的流式状态。
      // finishTurn:false：补拉发生在当前回合在途时，若默认按发起时代次
      // 收尾，恰好等于当前代次会把 T2 错误判空闲。
      final currentTurnId = state.lastSeenTurnId;
      if (currentTurnId != null && currentTurnId != turnId) {
        if ((authoritativeText != null && authoritativeText.isNotEmpty) ||
            usage != null) {
          unawaited(_refreshAuthoritative(state, finishTurn: false));
        }
        return;
      }
    }
    _stopFallbackPollingFor(state.sessionId);
    state.isStreaming = false;
    state.isWaitingForResponse = false;
    state.finalizeStreaming(
      authoritativeText: authoritativeText,
      usage: usage,
    );
    // 每个完成回合都做增量权威刷新（评审 P1 修复）：纯文本回合此前只走
    // 本地收尾，session/messages 未确认 → 永远进不了 SQLite（persist 只收
    // synced），离线重开即丢最新问答。本地收尾保持即时（finalizeStreaming
    // 已做）；并发合并由 _refreshAuthoritative 的 single-flight 保证。
    unawaited(_refreshAuthoritative(state));
    // 任务完成本地通知（App 在后台也能感知；后台会话同样通知）
    _notifier.showTaskDone(
      status: status,
      tokens: tokenCount ?? (state.lastInputTokens + state.lastOutputTokens),
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
  /// 补放后仍流式但无任何新事件的会话：seq 不变≠回合已结束（模型思考/
  /// 工具执行期间可能长时间无事件），必须用 session/read 的权威状态确认，
  /// 不得直接推断空闲。
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
        // 断线期间没有任何事件：读权威状态确认回合是否真的已结束
        unawaited(_confirmTurnAfterReconnect(state));
      } else if (state.isStreaming &&
          !state.pushAvailable &&
          _isActive(state) &&
          _fallbackPollTimer == null) {
        _startFallbackPollingFor(state.sessionId);
      }
    }
  }

  /// 重连后确认在途回合（seq 无新事件路径）：running → 保留流式并恢复
  /// 看门狗/轮询；明确 idle → 权威刷新收尾；读取失败 → 按失败模式方向
  /// 「多等」：保留流式并武装看门狗，由轮询/后续事件继续兜底。
  Future<void> _confirmTurnAfterReconnect(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) return;
    // read 发起时的回合代次（2026-09-19 评审 P1）：确认在途期间旧回合可能
    // 结束、新回合已开始。迟到的「当时 idle」若按当前代次收尾会误清
    // 新回合的流式态——返回时代次已前进就只做数据合并，绝不收尾
    final generationAtConfirm = state.turnGeneration;
    String? status;
    try {
      final read = await client.request('session/read', {
        'sessionId': state.sessionId,
      });
      if (read is Map && read['projection'] is Map) {
        status = _nonEmpty((read['projection'] as Map)['status']);
      }
    } catch (_) {
      // 状态未知：走「多等」路径
    }
    if (status == 'running') {
      if (!state.pushAvailable) {
        if (_isActive(state)) _startFallbackPollingFor(state.sessionId);
      } else {
        _armPushWatchdog(state);
      }
      _notifyIfActive(state);
      return;
    }
    if (status != null && status != 'idle') {
      // 未知状态值：多等，不当成结束
      if (!state.pushAvailable) {
        if (_isActive(state)) _startFallbackPollingFor(state.sessionId);
      } else {
        _armPushWatchdog(state);
      }
      _notifyIfActive(state);
      return;
    }
    if (status == null) {
      // read 失败/形状异常：保留流式，看门狗+轮询兜底
      if (!state.pushAvailable) {
        if (_isActive(state)) _startFallbackPollingFor(state.sessionId);
      } else {
        _armPushWatchdog(state);
      }
      _notifyIfActive(state);
      return;
    }
    // 明确 idle：权威刷新收尾（finishTurn，代次守卫防误伤新回合）。
    // read 在途期间已有新回合开始：这份 idle 是旧回合采样，只合并数据
    if (state.turnGeneration == generationAtConfirm) {
      unawaited(_refreshAuthoritative(state));
    } else {
      unawaited(_refreshAuthoritative(state, finishTurn: false));
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
    // 实测与 state.updated 的 model 补丁同形状）；current 归会话容器
    final settings = map['settings'];
    if (settings is Map) {
      final modelPatch = settings['model'];
      _cacheModelCatalog(modelPatch);
      _applyCurrentModelRef(state, modelPatch);
    }
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
    // settings.model.available 播种可用模型缓存（与 resume 同形状）；
    // current 归会话容器
    final settings = read['settings'];
    if (settings is Map) {
      final modelPatch = settings['model'];
      _cacheModelCatalog(modelPatch);
      _applyCurrentModelRef(state, modelPatch);
    }
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

  /// 合并 session/messages 响应：服务端 messages 数组本身就是权威顺序。
  /// 每条 assistant 的完整 parts 数组会原子替换其同 id 的实时投影；绝不按
  /// 文本或工具位置做模糊合并，避免 reasoning/tool 的交错顺序被重排。
  void _mergeServerMessages(ZcodeSessionState state, Map map) {
    final raw = map['messages'];
    if (raw is! List) return;
    final incoming = <ZcodeSessionItem>[];
    for (final m in raw) {
      if (m is! Map) continue;
      final item = _mapProtocolItem(m);
      if (item != null) incoming.add(item);
    }
    if (incoming.isEmpty) return;
    _normalizeChronological(incoming);
    state.mergeAuthoritative(incoming);
    // 水位只由本批 session/messages 确认的数据推进；实时占位即使已有
    // assistantMessageId 也绝不能参与，否则 afterMessageId 会跳过最终版本。
    for (final it in incoming.reversed) {
      final id = it.protoId;
      if (id != null) {
        state.watermark = id;
        break;
      }
    }
  }

  /// 异常历史页兜底：正常 app-server 一律按升序返回。仅当时间比较明确表明
  /// 页面整体倒序时翻转消息列表；单条消息内的 processParts 永远不参与排序。
  void _normalizeChronological(List<ZcodeSessionItem> list) {
    if (list.length < 2) return;
    var ascending = 0;
    var descending = 0;
    for (var i = 1; i < list.length; i++) {
      final before = list[i - 1].message.createdAt;
      final after = list[i].message.createdAt;
      if (after.isAfter(before)) {
        ascending++;
      } else if (after.isBefore(before)) {
        descending++;
      }
    }
    if (descending > ascending) {
      final reversed = list.reversed.toList(growable: false);
      list
        ..clear()
        ..addAll(reversed);
    }
  }

  /// 请求一次会话权威刷新。相同会话的多个触发源合并为串行请求：当前拉取
  /// 尚未结束时只记一笔补拉，避免旧响应在新结果之后覆盖过程项。
  /// [finishTurn] 仅在 turn.completed/stop 等终端路径置位；工具结果提交时
  /// 的 recovery 刷新必须保留正在进行的回合。收尾绑定发起时的回合代次：
  /// 迟到的历史拉取绝不能收尾已开始的下一回合。
  Future<void> _refreshAuthoritative(
    ZcodeSessionState state, {
    bool finishTurn = true,
  }) {
    final sessionId = state.sessionId;
    if (finishTurn) _refreshFinishRequested[sessionId] = state.turnGeneration;
    final existing = _authoritativeRefreshes[sessionId];
    if (existing != null) {
      _queuedAuthoritativeRefreshes.add(sessionId);
      return existing;
    }

    final completer = Completer<void>();
    _authoritativeRefreshes[sessionId] = completer.future;
    unawaited(_runAuthoritativeRefresh(state, completer));
    return completer.future;
  }

  Future<void> _runAuthoritativeRefresh(
    ZcodeSessionState state,
    Completer<void> completer,
  ) async {
    final sessionId = state.sessionId;
    try {
      while (true) {
        _queuedAuthoritativeRefreshes.remove(sessionId);
        final client = _client;
        if (client != null && client.paired) {
          try {
            await _pullIncremental(state);
          } catch (e) {
            // 过程流仍保留在内存中；下一个 recovery/turn end 会再触发一次。
            debugPrint('[zcode-store] 权威过程刷新失败 session=$sessionId: $e');
          }
        }
        if (!_queuedAuthoritativeRefreshes.remove(sessionId)) break;
      }
    } finally {
      _authoritativeRefreshes.remove(sessionId);
      final finishGen = _refreshFinishRequested.remove(sessionId);
      if (finishGen != null) {
        if (finishGen == state.turnGeneration) {
          // 发起收尾的回合仍是最新回合：正常收尾（重连兜底/幂等重入）
          _finishTurnFlags(state);
          unawaited(_refreshListingsAfterTurn(state));
        } else {
          // 迟到的旧回合历史：期间已有新回合开始，只合并数据，
          // 绝不清新回合的 streaming/waiting/轮询（否则 T2 被错误判空闲）
          _notifyIfActive(state);
        }
      } else {
        _notifyIfActive(state);
      }
      unawaited(_persistSession(state));
      if (!completer.isCompleted) completer.complete();
    }
  }

  /// 回合结束后延迟刷新会话列表：引擎在首条消息被接受后才自动生成标题
  /// （2026-09-17 真机探针实测：create 后 title 为空，回合完成后 title=
  /// 首条消息文本）。不刷新则抽屉一直停留在「（无标题会话）」。
  Future<void> _refreshListingsAfterTurn(ZcodeSessionState state) async {
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    if (_connState != ZcodeConnState.matched) return;
    try {
      await refreshSessions();
    } catch (_) {
      // 列表刷新失败不影响会话视口；下次回合结束再试
    }
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
          .where((e) => e.dirty && e.protoId != null && e.synced)
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

  /// state.updated / resume / read 的 model 补丁 → 可用模型目录缓存
  /// （setModel 兜底用；节点级投影，全局共享）
  void _cacheModelCatalog(dynamic modelPatch) {
    if (modelPatch is! Map) return;
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
          // 引擎 reasoning 形状（实测）：{levels:[{value,label}...],
          // defaultLevel?}——档位取每项的 value；缺失/畸形一律视为无档位
          // （setModel 不带 options）
          final reasoning = m['reasoning'];
          String? levelOf(Object? e) {
            if (e is String) return e.isEmpty ? null : e;
            if (e is Map) {
              final v = e['value']?.toString();
              return (v == null || v.isEmpty) ? null : v;
            }
            return null;
          }

          final levels = reasoning is Map && reasoning['levels'] is List
              ? (reasoning['levels'] as List)
                  .map(levelOf)
                  .whereType<String>()
                  .toList(growable: false)
              : const <String>[];
          catalog.add(
            ZcodeModelInfo(
              providerId: providerId,
              modelId: modelId,
              label: _nonEmpty(m['label']),
              providerLabel: _nonEmpty(m['providerLabel']),
              contextWindow: m['contextWindow'] is num
                  ? (m['contextWindow'] as num).toInt()
                  : null,
              maxOutputTokens: m['maxOutputTokens'] is num
                  ? (m['maxOutputTokens'] as num).toInt()
                  : null,
              reasoningLevels: levels,
              reasoningDefaultLevel: levels.isEmpty
                  ? null
                  : (reasoning['defaultLevel']?.toString()),
            ),
          );
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

  /// settings.model.current（实测 {providerId, modelId}）→ 会话级选中模型。
  /// 只写 [state] 自己的容器，绝不写全局（后台会话补丁不串视口）。
  void _applyCurrentModelRef(ZcodeSessionState state, dynamic modelPatch) {
    if (modelPatch is! Map) return;
    final current = modelPatch['current'];
    if (current is! Map) return;
    final pid = _nonEmpty(current['providerId']);
    final mid = _nonEmpty(current['modelId']);
    if (pid != null && mid != null) state.modelRef = '$pid/$mid';
  }

  /// 设置会话模型（session/setModel）。实测契约（APP-SERVER.md 0.16.9）：
  /// model 为对象 {providerId, modelId, options?{reasoningLevel}}——
  /// imported 模型（Codex/DeepSeek 导入）**必填** reasoningLevel（取目录
  /// reasoning.levels 的 value），缺失即 -32603 "Reasoning level is
  /// required"。[reasoningLevel] 由调用方从目录条目解析（见
  /// NodeModelEntry.reasoningLevelForRequest）；无档位模型不传、不带 options。
  /// 乐观更新 currentModelRef；权威值以随后的 state.updated 快照回填为准。
  /// 返回是否成功（失败时 error 已置位）。
  Future<bool> setModel(
    String providerId,
    String modelId, {
    String? reasoningLevel,
  }) async {
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
        'model': {
          'providerId': providerId,
          'modelId': modelId,
          if (reasoningLevel != null && reasoningLevel.isNotEmpty)
            'options': {'reasoningLevel': reasoningLevel},
        },
      });
      // 会话级乐观回显：只写本会话容器，不串其他会话
      _stateFor(sessionId).modelRef = '$providerId/$modelId';
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

  /// 思考强度（session/setThoughtLevel；实测字段 thoughtLevel: string）。
  /// 枚举 2026-09-17 真机探针实测：low|high|max 通过，medium 被 -32603
  /// 拒（"Unsupported reasoning effort: medium"）。乐观更新，权威值以
  /// 快照回填为准。
  Future<bool> setThoughtLevel(String level) async {
    const allowed = ['low', 'high', 'max'];
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
      // 会话级乐观回显：只写本会话容器
      _stateFor(sessionId).thoughtLevel = level;
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
    final result =
        await client.request('session/usage', {'sessionId': sessionId});
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

  /// 调用轨迹（session/debug；引擎进程内快照——仅当前进程执行的模型请求
  /// 可见，引擎重启后历史轨迹不可回放）。返回 rounds 元素列表。
  Future<List<Map<String, dynamic>>> debugRounds(String sessionId) async {
    final client = _client;
    if (client == null || !client.paired) {
      throw Exception('未连接 ZCode');
    }
    final result =
        await client.request('session/debug', {'sessionId': sessionId});
    final rounds = result is Map ? result['rounds'] : null;
    if (rounds is! List) return const [];
    return [
      for (final r in rounds)
        if (r is Map) Map<String, dynamic>.from(r),
    ];
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
      final result =
          await client.request('session/fork', {'sessionId': sessionId});
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
      if (message.contains('checkpoint') ||
          message.contains('INVALID_STATE_TRANSITION')) {
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

  /// goal 快捷动作（官方 action 枚举实测：show/set/replace/pause/resume/
  /// clear）。状态面板 ▶/暂停按钮走 pause/resume；失败置 error 横幅。
  Future<bool> goalAction(String action) async {
    const allowed = ['pause', 'resume', 'clear'];
    if (!allowed.contains(action)) {
      _fail('未知目标动作：$action');
      return false;
    }
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return false;
    }
    try {
      await client.request('session/goal', {
        'sessionId': sessionId,
        'action': action,
      });
      return true;
    } catch (e) {
      _fail('目标操作失败：$e');
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
    final result =
        await client.request('session/subagents', {'sessionId': sessionId});
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
      state.pollFailureCount = 0;
      if (result is Map && result['events'] is List) {
        for (final ev in result['events'] as List) {
          if (ev is Map) _applySessionEvent(state, ev);
        }
      }
    } catch (e) {
      if (e is ZcodeRequestException && e.code == -32004) {
        // 会话已被其他运行时占用（运行时单归属，非故障）：停止轮询且不得
        // 重新物化抢占用，置占用标记交 UI 呈现（审查 P1-1 恢复方向）
        state.remoteActiveElsewhere = true;
        _stopFallbackPolling();
        if (_isActive(state)) notifyListeners();
        return;
      }
      // 轮询失败：连续达到阈值说明会话在当前引擎已不健康（重启/被 close），
      // 作废物化并自动重建，而不是无限静默重试（审查 P1-1）
      state.pollFailureCount++;
      if (state.pollFailureCount >= 3) {
        state.pollFailureCount = 0;
        _stopFallbackPolling();
        unawaited(_rematerializeAfterPollFailure(state));
      }
    }
  }

  /// 降级轮询连续失败后的自动重新物化：resume → 订阅 → 权威刷新。
  /// -32004（被其他运行时占用）按单归属语义呈现，不抢。
  Future<void> _rematerializeAfterPollFailure(ZcodeSessionState state) async {
    final client = _client;
    if (client == null || !client.paired) return;
    state.materialized = false;
    state.subscribed = false;
    state.pushAvailable = true;
    state.lastSeq = 0;
    try {
      await client.request('session/resume', {'sessionId': state.sessionId});
      state.remoteActiveElsewhere = false;
      state.materialized = true;
      await _ensureSubscribed(state);
      unawaited(_refreshAuthoritative(state));
      if (_isActive(state)) {
        state.insertHeadNotice('（与引擎的会话连接已重新建立）');
        notifyListeners();
      }
    } catch (e) {
      if (e is ZcodeRequestException && e.code == -32004) {
        state.remoteActiveElsewhere = true;
        state.isStreaming = false;
        state.isWaitingForResponse = false;
        if (_isActive(state)) notifyListeners();
        return;
      }
      // 仍失败：保持未物化，下次进入会话/刷新时走完整恢复流程
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

  /// 权威协议消息 → 会话条目。session/messages 的 parts 数组顺序是唯一的
  /// 历史顺序来源；本方法不按 type 重新排序、不丢弃 step/未知 part。
  ZcodeSessionItem? _mapProtocolItem(Map raw) {
    final info = raw['info'];
    if (info is! Map) return null;
    final message = _mapProtocolMessage(raw);
    if (message == null) return null;
    final messageId = _protocolMessageId(info);
    if (messageId == null) {
      debugPrint('[zcode-store] session/messages 消息缺少 message id，保留但不缓存');
    }
    return ZcodeSessionItem(
      message: message,
      protoId: messageId,
      turnId: _firstNonEmpty(info, ['turnId', 'turn_id']),
      synced: messageId != null,
    );
  }

  /// app-server 消息（info + parts）→ canonical ChatMessage。
  /// parts 数组顺序是唯一权威顺序；text/reasoning/tool 直接映射，
  /// step-start/step-finish 及未知类型保留 marker，绝不丢弃或重排。
  ChatMessage? _mapProtocolMessage(Map m) {
    final info = m['info'];
    if (info is! Map) return null;
    final rawParts = m['parts'];
    if (rawParts is! List) return null;

    final role =
        info['role'] == 'user' ? MessageRole.user : MessageRole.assistant;
    final processParts = <ChatProcessPart>[];
    for (final rawPart in rawParts) {
      if (rawPart is! Map) {
        debugPrint('[zcode-store] session/messages 包含非对象 part，已保留消息其余部分');
        continue;
      }
      final type = _nonEmpty(rawPart['type']) ?? 'unknown';
      final partId = _firstNonEmpty(rawPart, ['partId', 'id']);
      switch (type) {
        case 'text':
          final text = rawPart['text'];
          if (text is String) {
            processParts.add(ChatProcessPart.text(text, id: partId));
          } else {
            processParts.add(ChatProcessPart.marker(type, id: partId));
            debugPrint('[zcode-store] text part 缺少字符串 text，已保留 marker');
          }
          break;
        case 'reasoning':
          final text = rawPart['text'];
          if (text is String) {
            // 权威 part 自带 time{start,end}（probe-reasoning-part 实测）：
            // 历史思考耗时「持续了 N 秒」与实时同源，不再只依赖本地墙钟
            final time = rawPart['time'];
            processParts.add(
              ChatProcessPart.reasoning(
                text,
                id: partId,
                startedAtMs: time is Map ? _toIntOrNull(time['start']) : null,
                closedAtMs: time is Map ? _toIntOrNull(time['end']) : null,
              ),
            );
          } else {
            processParts.add(ChatProcessPart.marker(type, id: partId));
            debugPrint('[zcode-store] reasoning part 缺少字符串 text，已保留 marker');
          }
          break;
        case 'tool':
          processParts.add(
            ChatProcessPart.tool(_mapToolPart(rawPart), id: partId),
          );
          break;
        case 'step-start':
        case 'step-finish':
          // 结构性 step 边界：实时路径显式忽略（见 _applyModelStreaming），
          // 权威映射同样不保留——marker 会打断工具聚合，同一回合运行中
          // 成组、重进后拆组（运行时/历史不一致）。
          break;
        default:
          // file/subagent/retry 和未来类型不强行伪装成文本；保留 marker，
          // 以便缓存、调试与后续原生语义扩展可见（未知类型必须留观测）。
          processParts.add(ChatProcessPart.marker(type, id: partId));
      }
    }

    final tokens = info['tokens'];
    final usage = tokens is Map
        ? TokenUsage(
            inputTokens:
                _toIntOrNull(tokens['input'] ?? tokens['inputTokens']) ?? 0,
            outputTokens:
                _toIntOrNull(tokens['output'] ?? tokens['outputTokens']) ?? 0,
          )
        : null;
    final time = info['time'];
    final created = _parseCreatedTime(info);
    final completed = time is Map ? _parseEventTime(time['completed']) : null;
    final durationMs = created != null && completed != null
        ? completed.difference(created).inMilliseconds
        : null;
    final modelInfo = info['model'];
    final nestedModel = modelInfo is Map ? _joinModelRef(modelInfo) : null;

    return ChatMessage(
      role: role,
      processParts: List.unmodifiable(processParts),
      createdAt: created ?? DateTime.now(),
      usage: usage,
      model: _nonEmpty(info['modelID']) ?? nestedModel,
      agent: _nonEmpty(info['agent']),
      durationMs: durationMs,
    );
  }

  String? _protocolMessageId(Map info) =>
      _firstNonEmpty(info, ['id', 'messageId', 'message_id']);

  String? _joinModelRef(Map model) {
    final providerId = _firstNonEmpty(model, ['providerId', 'provider_id']);
    final modelId = _firstNonEmpty(model, ['modelId', 'model_id']);
    if (providerId == null || modelId == null) return null;
    return '$providerId/$modelId';
  }

  /// tool part → ToolCallInfo。支持当前 public lower-camel 投影与历史
  /// callID/sessionID/messageID 形态；输入/输出都来自 state，不猜顶层字段。
  ToolCallInfo _mapToolPart(Map p) {
    final tool = p['tool'];
    final name = _toolName(p) ?? 'Tool';
    final stateObj = p['state'];
    final state = stateObj is Map ? stateObj : const {};
    final statusStr = _nonEmpty(state['status']) ?? _nonEmpty(stateObj) ?? '';
    final input = stateObj is Map
        ? state['input']
        : p['input'] ?? (tool is Map ? tool['input'] : null);
    final output =
        stateObj is Map ? state['output'] : p['output'] ?? p['result'];
    final errorText = stateObj is Map ? _toolErrorText(state['error']) : null;
    final status = switch (statusStr) {
      'completed' || 'success' => ToolCallStatus.done,
      'error' || 'failed' || 'denied' || 'cancelled' => ToolCallStatus.error,
      _ => ToolCallStatus.running,
    };
    final time = state['time'];
    final startedAt = _parseEventTime(
      state['startedAt'] ?? (time is Map ? time['start'] : null),
    );
    final completedAt = _parseEventTime(
      state['completedAt'] ?? (time is Map ? time['end'] : null),
    );
    final elapsedMs = startedAt != null && completedAt != null
        ? completedAt.difference(startedAt).inMilliseconds
        : null;
    final inputMap = input is Map ? input : const {};
    final metadata =
        state['metadata'] is Map ? state['metadata'] as Map : const {};
    String? meta(List<String> keys) =>
        _firstNonEmpty(p, keys) ??
        _firstNonEmpty(inputMap, keys) ??
        _firstNonEmpty(metadata, keys);

    return ToolCallInfo(
      toolCallId: _firstNonEmpty(p, ['callId', 'callID', 'toolCallId']) ?? '',
      toolName: name,
      inputSummary: _summaryOf(input),
      outputSummary: errorText ?? _summaryOf(output),
      status: status,
      isError: status == ToolCallStatus.error,
      // 权威数据只有终态：error 终态即 everError（重试历史不可知，尽力而为）
      everError: status == ToolCallStatus.error,
      inputFull: _fullOf(input),
      outputFull: errorText ?? _fullOf(output),
      lifecycle: statusStr.isEmpty ? null : statusStr,
      elapsedMs: elapsedMs,
      startedAt: startedAt,
      parallelGroupIndex: _toIntOrNull(p['parallelGroupIndex']),
      canRunParallel: p['canRunParallel'] == true,
      subagentType:
          meta(['subagentType', 'subagent_type', 'agentType', 'agent_type']),
      childSessionId: meta(['childSessionId', 'child_session_id']),
      parentToolCallId: meta(['parentToolCallId', 'parent_tool_call_id']),
      source: meta(['source']),
      agentId: meta(['agentId', 'agent_id']),
      background: p['background'] == true,
      description: meta(['description']),
      outputTruncated: state['truncated'] == true || p['truncated'] == true,
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

  /// 全量形态（回合块工具行二级展开用；不截断——截断只发生在显示层）
  String? _fullOf(dynamic v) {
    if (v == null) return null;
    if (v is String) return v;
    try {
      return jsonEncode(v);
    } catch (_) {
      return v.toString();
    }
  }

  // ──────────────────────────────────────────────
  // 内部工具函数
  // ──────────────────────────────────────────────

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
  /// 仅测试使用：会话时间线条目（截断标记断言用）
  @visibleForTesting
  List<ZcodeSessionItem> debugItems(String sessionId) =>
      List.unmodifiable(_states[sessionId]?.items ?? const []);

  void debugSimulateRelayState(ZcodeRelayState state, bool paired) =>
      _onRelayStateChange(state, paired);

  @override
  void dispose() {
    _stopFallbackPolling();
    _rejectAllPendingReverse();
    _client = null;
    _permissionController.close();
    _askUserController.close();
    _uiNotices.close();
    super.dispose();
  }
}
