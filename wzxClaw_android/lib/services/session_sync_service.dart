import 'dart:async';

import 'package:flutter/foundation.dart';

import 'node_catalog_service.dart';

import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/session_meta.dart';
import '../models/session_task_state.dart';
import '../models/ws_message.dart';
import 'app_restore_state.dart';
import 'chat_database.dart';
import 'chat_store.dart';
import 'connection_manager.dart';
import 'phone_session_index.dart';
import 'ws_transport.dart';

/// Workspace info pushed by the desktop when mobile connects.
class WorkspaceInfo {
  final String workspaceName;
  final String workspacePath;
  final String? activeSessionId;
  final int sessionCount;

  const WorkspaceInfo({
    required this.workspaceName,
    required this.workspacePath,
    this.activeSessionId,
    required this.sessionCount,
  });
}

/// A project folder bound to a workspace.
class WorkspaceProject {
  final String id;
  final String path;
  final String name;

  const WorkspaceProject({
    required this.id,
    required this.path,
    required this.name,
  });
}

/// 轻量级会话摘要，用于工作区选择器中展示会话列表。
class SessionSummary {
  final String id;
  final String title;
  final int updatedAt;
  final int messageCount;
  final bool isRunning;

  const SessionSummary({
    required this.id,
    required this.title,
    required this.updatedAt,
    required this.messageCount,
    this.isRunning = false,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> json) => SessionSummary(
        id: json['id'] as String? ?? '',
        title: json['title'] as String? ?? 'Untitled',
        updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
        messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
        isRunning: json['isRunning'] as bool? ?? false,
      );
}

class WorkspaceItem {
  final String id;
  final String title;
  final String? description;
  final List<WorkspaceProject> projects;
  final bool archived;
  final String? progressSummary;
  final int updatedAt;
  final List<SessionSummary> sessions;
  final String? activeSessionId;
  final List<String> runningSessionIds;
  final Map<String, SessionTaskState> taskStatuses;

  const WorkspaceItem({
    required this.id,
    required this.title,
    this.description,
    this.projects = const [],
    this.archived = false,
    this.progressSummary,
    required this.updatedAt,
    this.sessions = const [],
    this.activeSessionId,
    this.runningSessionIds = const [],
    this.taskStatuses = const {},
  });

  /// Convenience: first project's path (if any), for display
  String? get primaryPath => projects.isNotEmpty ? projects.first.path : null;
}

/// Singleton service that syncs session data from the desktop wzxClaw IDE.
///
/// Subscribes to [ConnectionManager.messageStream], exposes reactive streams,
/// and caches data locally in SQLite via [ChatDatabase].
class SessionSyncService {
  // -- Singleton --
  static final SessionSyncService _instance = SessionSyncService._();
  static SessionSyncService get instance => _instance;
  SessionSyncService._({WsTransport? transport})
      : _transport = transport ?? ConnectionManager.instance {
    _init();
  }

  /// 仅测试使用：创建一个独立的 SessionSyncService 实例，不使用全局单例。
  @visibleForTesting
  factory SessionSyncService.forTest({required WsTransport transport}) =>
      SessionSyncService._(transport: transport);

  final WsTransport _transport;

  // -- Reactive state streams --
  final _sessionsController = StreamController<List<SessionMeta>>.broadcast();
  Stream<List<SessionMeta>> get sessionsStream => _sessionsController.stream;

  final _activeSessionController = StreamController<String?>.broadcast();
  Stream<String?> get activeSessionStream => _activeSessionController.stream;

  final _workspaceInfoController = StreamController<WorkspaceInfo?>.broadcast();
  Stream<WorkspaceInfo?> get workspaceInfoStream =>
      _workspaceInfoController.stream;

  final _loadingController = StreamController<bool>.broadcast();
  Stream<bool> get loadingStream => _loadingController.stream;

  final _workspacesController =
      StreamController<List<WorkspaceItem>>.broadcast();
  Stream<List<WorkspaceItem>> get workspacesStream =>
      _workspacesController.stream;
  List<WorkspaceItem> _workspaces = [];
  List<WorkspaceItem> get workspaces => List.unmodifiable(_workspaces);

  // -- Internal state --
  List<SessionMeta> _sessions = [];
  String? _activeSessionId;
  WorkspaceInfo? _workspaceInfo;
  bool _isLoading = false;
  StreamSubscription<WsMessage>? _wsSubscription;
  StreamSubscription<WsConnectionState>? _stateSub;
  // ignore: unused_field — holds subscription reference to prevent GC
  StreamSubscription<String?>? _desktopOnlineSub;
  int _requestCounter = 0;
  int _fetchGeneration = 0; // 递增以丢弃过期的 fetchSessions 响应
  String? _currentListRequestId; // 最近一次 fetchSessions 发出的 requestId
  final Map<String, Completer<dynamic>> _pendingRequests = {};
  // 同一个 sessionId 的并发 loadAll 请求合并为一次，避免重复写 DB。
  final Map<String, Future<List<ChatMessage>>> _inflightLoadAll = {};

  // 清空会话后的冷却期：此期间内忽略对该会话的自动消息同步，
  // 防止清完立刻被 session:changed / fetchSessions 回填。
  String? _clearedSessionId;
  DateTime? _clearedAt;

  List<SessionMeta> get sessions => List.unmodifiable(_sessions);
  String? get activeSessionId => _activeSessionId;
  WorkspaceInfo? get workspaceInfo => _workspaceInfo;
  bool get isLoading => _isLoading;
  bool get _hasSelectedDesktopTarget => _transport.selectedDesktopId != null;

  void _init() {
    _wsSubscription = _transport.incoming.listen(_handleWsMessage);
    _stateSub = _transport.stateStream.listen(_handleConnectionState);
    _desktopOnlineSub =
        _transport.selectedDesktopIdStream.listen(_handleDesktopOnline);
    _loadCachedSessions();
  }

  // -- Connection state handler --
  void _handleConnectionState(WsConnectionState state) {
    if (state == WsConnectionState.connected) {
      if (!_hasSelectedDesktopTarget) {
        return;
      }
      // Small delay to let identity exchange happen first
      Future.delayed(const Duration(milliseconds: 800), () {
        if (_transport.state == WsConnectionState.connected &&
            _hasSelectedDesktopTarget) {
          refreshLocalSessions();
        }
      });
    } else if (state == WsConnectionState.disconnected) {
      // Clear workspace info when disconnected from relay
      _workspaceInfo = null;
      _workspaceInfoController.add(null);
    }
  }

  // -- Desktop selection handler --
  void _handleDesktopOnline(String? selectedDesktopId) {
    if (selectedDesktopId == null) {
      _clearDesktopScopedState();
    } else if (_transport.state == WsConnectionState.connected) {
      unawaited(_restorePersistedSessionView());
      Future.delayed(const Duration(milliseconds: 800), () {
        if (_hasSelectedDesktopTarget) {
          refreshLocalSessions();
        }
      });
    }
  }

  // -- WS message router --
  void _handleWsMessage(WsMessage msg) {
    switch (msg.event) {
      case WsEvents.sessionListResponse:
        _handleSessionListResponse(msg.data);
        break;
      case WsEvents.sessionLoadResponse:
        _handleSessionLoadResponse(msg.data);
        break;
      case WsEvents.sessionWorkspaceInfo:
        _handleWorkspaceInfo(msg.data);
        break;
      case WsEvents.sessionActive:
        _handleSessionActive(msg.data);
        break;
      case WsEvents.desktopAgentStarted:
        _handleDesktopAgentStarted(msg.data);
        break;
      case WsEvents.sessionError:
        _handleSessionError(msg.data);
        break;
      case WsEvents.sessionCreateResponse:
        _handleSessionCreateResponse(msg.data);
        break;
      case WsEvents.sessionDeleteResponse:
        _handleSessionDeleteResponse(msg.data);
        break;
      case WsEvents.sessionRenameResponse:
        _handleSessionRenameResponse(msg.data);
        break;
      case WsEvents.workspaceListResponse:
        _handleWorkspaceListResponse(msg.data);
        break;
      case WsEvents.workspaceSwitchResponse:
        _handleWorkspaceSwitchResponse(msg.data);
        break;
      case WsEvents.sessionChanged:
        // 引擎会话有变动（新消息/新会话）——Option A：只刷本地索引展示，
        // 不再向引擎拉 session/list（避免桌面自建会话涌入抽屉列表）
        unawaited(refreshLocalSessions());
        break;
      case WsEvents.agentRunning:
        // Mobile reconnected while desktop agent is mid-stream — re-hydrate full
        // message history with pagination so we don't only keep streaming deltas.
        _handleAgentRunningSync(msg.data);
        break;
      case WsEvents.agentRunningChanged:
        // Per-session running state changed — update isRunning on the matching session.
        _handleAgentRunningChanged(msg.data);
        break;
      case WsEvents.sessionTaskStatus:
        _handleSessionTaskStatus(msg.data);
        break;
    }
  }

  /// 当桌面 agent 正在运行（手机重连场景），主动用分页重载该会话的全部历史，
  /// 否则只会有流式增量，错过此前的消息。
  void _handleAgentRunningSync(dynamic data) {
    if (data is! Map) return;
    final sessionId = data['sessionId'] as String?;
    if (sessionId == null || !_hasSelectedDesktopTarget) return;
    _fetchGeneration++;
    unawaited(_applySessionSelection(sessionId, _fetchGeneration));
  }

  void _handleSessionTaskStatus(dynamic data) {
    if (data is! Map) return;
    final state = SessionTaskState.fromJson(Map<String, dynamic>.from(data));
    if (state.sessionId.isEmpty) return;
    final idx = _sessions.indexWhere((s) => s.id == state.sessionId);
    if (idx != -1) {
      _sessions[idx] = _sessions[idx].copyWith(
        taskState: state,
        isRunning: state.isActive,
      );
      _sessionsController.add(List.unmodifiable(_sessions));
    }
    if (state.isTerminal && state.sessionId == _activeSessionId && _hasSelectedDesktopTarget) {
      final generation = ++_fetchGeneration;
      unawaited(_refreshSessionAfterInflight(state.sessionId, generation));
    }
  }

  /// Per-session running state changed — update the matching SessionMeta in the list.
  void _handleAgentRunningChanged(dynamic data) {
    if (data is! Map) return;
    final sessionId = data['sessionId'] as String?;
    final isRunning = data['isRunning'] as bool? ?? false;
    if (sessionId == null) return;
    final idx = _sessions.indexWhere((s) => s.id == sessionId);
    if (idx == -1) return;
    _sessions[idx] = _sessions[idx].copyWith(isRunning: isRunning);
    _sessionsController.add(List.unmodifiable(_sessions));
  }

  /// 引擎 session/list 响应 —— Option A 后仅服务「从引擎导入 / 工作区发现」
  /// 路径：解析 + 更新工作区信息 + 完成挂起请求。不再驱动抽屉列表与
  /// 视图选择（列表由手机本地索引 [refreshLocalSessions] 提供，避免引擎
  /// 侧桌面自建会话抢占手机视图）。
  void _handleSessionListResponse(dynamic data) async {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final workspacePath = data['workspacePath'] as String? ?? '';
    final workspaceName = data['workspaceName'] as String? ?? '';
    final rawSessions = data['sessions'] as List? ?? [];
    // 桌面端当前活跃会话（新增字段，旧桌面端可能为 null）
    final desktopActiveSessionId = data['activeSessionId'] as String?;
    // 桌面端正在运行的会话 ID 列表（Phase B，旧桌面端可能为 null）
    final runningSessionIds =
        (data['runningSessionIds'] as List?)?.whereType<String>().toSet() ??
            const <String>{};
    final taskStatuses = <String, SessionTaskState>{};
    final rawTaskStatuses = data['taskStatuses'];
    if (rawTaskStatuses is Map) {
      rawTaskStatuses.forEach((key, value) {
        if (key is String && value is Map) {
          taskStatuses[key] = SessionTaskState.fromJson(
            Map<String, dynamic>.from(value),
          );
        }
      });
    }

    // ignore: avoid_print
    print(
        '[SyncDiag] sessionListResponse req=$requestId workspace=$workspacePath '
        'sessions=${rawSessions.length} activeSession=$desktopActiveSessionId running=${runningSessionIds.length}');

    final sessions = rawSessions.whereType<Map>().map((s) {
      final meta = SessionMeta.fromDesktopJson(
        Map<String, dynamic>.from(s),
        workspacePath,
        workspaceName,
      );
      final taskState = taskStatuses[meta.id] ?? meta.taskState;
      if (taskState != null) {
        return meta.copyWith(taskState: taskState, isRunning: taskState.isActive);
      }
      return runningSessionIds.contains(meta.id)
          ? meta.copyWith(isRunning: true)
          : meta;
    }).toList();

    if (!_hasSelectedDesktopTarget) {
      _isLoading = false;
      _loadingController.add(false);
      _completePending(requestId, const <SessionMeta>[]);
      return;
    }

    if (workspacePath.isNotEmpty) {
      _workspaceInfo = WorkspaceInfo(
        workspaceName: workspaceName,
        workspacePath: workspacePath,
        activeSessionId: desktopActiveSessionId ?? _activeSessionId,
        sessionCount: sessions.length,
      );
      _workspaceInfoController.add(_workspaceInfo);
      AppRestoreState.setLastWorkspacePath(workspacePath);
    }

    _isLoading = false;
    _loadingController.add(false);
    _completePending(requestId, sessions);
  }

  void _handleSessionLoadResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final sessionId = data['sessionId'] as String? ?? '';
    final rawMessages = data['messages'] as List? ?? [];
    final total = data['total'] as int? ?? 0;
    final offset = data['offset'] as int? ?? 0;
    final hasMore = data['hasMore'] as bool? ?? false;

    // ignore: avoid_print
    print('[SyncDiag] sessionLoadResponse req=$requestId session=$sessionId '
        'offset=$offset got=${rawMessages.length} total=$total hasMore=$hasMore');

    if (!_hasSelectedDesktopTarget) {
      _completePending(requestId, {
        'messages': <ChatMessage>[],
        'total': 0,
        'offset': offset,
        'hasMore': false,
      });
      return;
    }

    // Transform desktop messages to ChatMessage
    final messages = <ChatMessage>[];
    for (final raw in rawMessages) {
      if (raw is Map) {
        final message = _fromDesktopMessage(Map<String, dynamic>.from(raw));
        // 系统注入提醒 + 空助手占位行都不进时间线
        if (!message.isSystemInjected && !message.isEmptyAssistant) {
          messages.add(message);
        }
      }
    }

    // 注意：不要在此处写 DB。多页响应 + 多触发路径并发会导致缓存重复写入
    // （观察到同一条消息被插入 8~12 次）。
    // DB 缓存的写入由 [loadAllSessionMessages] 在 await 链上序列化处理。

    _completePending(requestId, {
      'messages': messages,
      'total': total,
      'offset': offset,
      'hasMore': hasMore,
    });
  }

  void _handleWorkspaceInfo(dynamic data) {
    if (data is! Map) return;
    if (!_hasSelectedDesktopTarget) return;
    final newPath = data['workspacePath'] as String? ?? '';

    // Clear old sessions if workspace changed
    if (_workspaceInfo != null && _workspaceInfo!.workspacePath != newPath) {
      _sessions = [];
      _sessionsController.add([]);
    }

    _workspaceInfo = WorkspaceInfo(
      workspaceName: data['workspaceName'] as String? ?? '',
      workspacePath: newPath,
      activeSessionId: data['activeSessionId'] as String?,
      sessionCount: (data['sessionCount'] as num?)?.toInt() ?? 0,
    );
    _workspaceInfoController.add(_workspaceInfo);

    if (_hasSelectedDesktopTarget) {
      refreshLocalSessions();
    }
  }

  /// 处理手机发起的 agent 指令回执（`session:active`）。
  ///
  /// 该事件由桌面端在**手机发起**的 agent 执行路径中发回，
  /// 语义是"桌面已接受指令，将在该 sessionId 上执行"。
  /// 此时手机已经主动切换到该 session，故此处只需同步 _activeSessionId。
  ///
  /// 旧版桌面端在桌面自发 agent 时也发此事件 —— 手机通过新建的
  /// [_handleDesktopAgentStarted] 处理 `desktop:agent:started`；
  /// 对于旧版桌面端的兼容回退不切换视图（保守处理）。
  void _handleSessionActive(dynamic data) {
    if (data is! Map) return;
    if (!_hasSelectedDesktopTarget) return;
    final sessionId = data['sessionId'] as String?;
    if (sessionId == null) return;

    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);
    // Option A：索引条目刷新活跃时间（列表排序贴合真实使用）
    unawaited(
      PhoneSessionIndex.instance.touch(sessionId).then((_) {
        if (_hasSelectedDesktopTarget) refreshLocalSessions();
      }),
    );
    // 竞争窗口：手机发消息 → 用户立刻切走 → session:active 到达，
    // 若此时无条件 syncSessionId，会把 _currentSessionId 改回 A，
    // 导致 A 的流式事件通过 _isWrongSession 写入 B 的视图。
    if (!ChatStore.instance.userManuallySwitched ||
        ChatStore.instance.currentSessionId == sessionId) {
      ChatStore.instance.syncSessionId(sessionId);
    }
  }

  /// 桌面自发的 agent 启动通知（Phase 1 新协议：`desktop:agent:started`）。
  ///
  /// 与旧 `session:active` 的关键区别：
  /// - 不强制切换手机视图，不论手机当前在哪个会话。
  /// - 只更新 [_activeSessionId]，并让 ChatStore 知道即将到来的流式属于哪个 session，
  ///   防止 _isWrongSession 过度丢弃流式事件。
  void _handleDesktopAgentStarted(dynamic data) {
    if (data is! Map) return;
    if (!_hasSelectedDesktopTarget) return;
    final sessionId = data['sessionId'] as String?;
    if (sessionId == null) return;

    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);

    // 将 ChatStore 的内部 sessionId 同步为 桌面 agent 会话，
    // 这样 _isWrongSession 就能正确判断流式事件。
    // 注意：只有手机当前显示的就是该 session 时才同步，
    //       否则手机可能在看其他会话，不应更改其 currentSessionId。
    final currentId = ChatStore.instance.currentSessionId;
    if (currentId == sessionId) {
      // 手机和桌面在同一个会话 — 直接同步即可
      ChatStore.instance.syncSessionId(sessionId);
    }
    // 如果手机在其他会话，不动 ChatStore，流式事件将被 _isWrongSession 正确过滤。
  }

  void _handleSessionError(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final error = data['error'] as String? ?? 'Unknown error';
    final code = data['code'] as String? ?? '';
    _isLoading = false;
    _loadingController.add(false);
    // Log for debugging — errors with no pending request were silently dropped
    // ignore: avoid_print
    print('[SessionSync] error: $error (code=$code, requestId=$requestId)');
    _completePending(requestId, null, error: error);
  }

  void _handleSessionCreateResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final sessionData = data['session'];
    // Option A：新建会话的索引写入由 startNewConversation 统一负责
    //（首条消息发出时），此处仅完成挂起请求。
    _completePending(requestId, sessionData);
  }

  void _handleSessionDeleteResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final success = data['success'] as bool? ?? false;
    if (success) {
      // Refresh the list
      fetchSessions();
    }
    _completePending(requestId, {'success': success});
  }

  void _handleSessionRenameResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final success = data['success'] as bool? ?? false;
    if (success) {
      fetchSessions();
    }
    _completePending(requestId, {'success': success});
  }

  void _handleWorkspaceListResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    if (!_hasSelectedDesktopTarget) {
      _completePending(requestId, const <WorkspaceItem>[]);
      return;
    }
    // Support both old format ({workspaces: [{path,name}]}) and new format ({tasks: [{id,title,projects}]})
    final rawWorkspaces = (data['workspaces'] ?? data['tasks']) as List? ?? [];
    _workspaces = rawWorkspaces.whereType<Map>().map((w) {
      final runningSessionIds =
          (w['runningSessionIds'] as List?)?.whereType<String>().toList() ??
              const <String>[];
      final taskStatuses = <String, SessionTaskState>{};
      final rawTaskStatuses = w['taskStatuses'];
      if (rawTaskStatuses is Map) {
        rawTaskStatuses.forEach((key, value) {
          if (key is String && value is Map) {
            taskStatuses[key] = SessionTaskState.fromJson(
              Map<String, dynamic>.from(value),
            );
          }
        });
      }

      // New format: workspace objects from WorkspaceStore
      if (w.containsKey('id') && w.containsKey('title')) {
        final rawProjects = w['projects'] as List? ?? [];
        final projects = rawProjects
            .whereType<Map>()
            .map((p) => WorkspaceProject(
                  id: p['id'] as String? ?? '',
                  path: p['path'] as String? ?? '',
                  name: p['name'] as String? ?? '',
                ),)
            .toList();
        return WorkspaceItem(
          id: w['id'] as String? ?? '',
          title: w['title'] as String? ?? '',
          description: w['description'] as String?,
          projects: projects,
          archived: w['archived'] as bool? ?? false,
          progressSummary: w['progressSummary'] as String?,
          updatedAt: w['updatedAt'] as int? ?? 0,
          sessions: (w['sessions'] as List? ?? [])
              .whereType<Map>()
              .map((s) {
                final summary =
                    SessionSummary.fromJson(Map<String, dynamic>.from(s));
                final taskState = taskStatuses[summary.id];
                return SessionSummary(
                  id: summary.id,
                  title: summary.title,
                  updatedAt: summary.updatedAt,
                  messageCount: summary.messageCount,
                  isRunning: summary.isRunning ||
                      runningSessionIds.contains(summary.id) ||
                      (taskState?.isActive ?? false),
                );
              })
              .toList(),
          activeSessionId: w['activeSessionId'] as String?,
          runningSessionIds: runningSessionIds,
          taskStatuses: taskStatuses,
        );
      }
      // Old format: folder paths (fallback)
      return WorkspaceItem(
        id: w['path'] as String? ?? '',
        title: w['name'] as String? ?? '',
        projects: w['path'] != null
            ? [
                WorkspaceProject(
                    id: '',
                    path: w['path'] as String,
                    name: w['name'] as String? ?? '',),
              ]
            : [],
        updatedAt: 0,
      );
    }).toList();
    _workspacesController.add(List.unmodifiable(_workspaces));
    _completePending(requestId, _workspaces);
  }

  void _handleWorkspaceSwitchResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    _completePending(requestId, data);
  }

  // -- Public API --

  /// 请求引擎的 session/list（旧事件语义保留）。
  ///
  /// Option A 后这不是抽屉列表的数据源——仅被「从引擎导入」「工作区发现」
  /// 等显式入口使用；结果通过 [fetchEngineSessions] 的返回值消费。
  void fetchSessions() {
    unawaited(fetchEngineSessions());
  }

  /// 拉取引擎侧会话列表并返回（供「从引擎导入」选择器使用）。
  Future<List<SessionMeta>> fetchEngineSessions(
      {Duration timeout = const Duration(seconds: 8),}) async {
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return const <SessionMeta>[];
    }
    // Dedup: skip if a request is already inflight.
    if (_isLoading) return const <SessionMeta>[];
    _fetchGeneration++; // 递增使过期响应可被检测

    _isLoading = true;
    _loadingController.add(true);
    final requestId = _nextRequestId();
    _currentListRequestId = requestId;
    // Bug3修复: 先注册 Completer，再发送消息，避免极速响应到达时找不到对应 requestId
    _pendingRequests[requestId] = Completer<dynamic>();
    _transport.send(
      WsMessage(
        event: WsEvents.sessionListRequest,
        data: {
          'requestId': requestId,
        },
      ),
    );
    try {
      final future = _pendingRequests[requestId]!.future;
      final result = await future.timeout(timeout);
      return result is List<SessionMeta> ? result : const <SessionMeta>[];
    } catch (_) {
      return const <SessionMeta>[];
    } finally {
      // 超时/异常路径兜底清理（正常路径已由响应处理器完成）
      _pendingRequests.remove(requestId);
      if (_currentListRequestId == requestId) _currentListRequestId = null;
      _isLoading = false;
      _loadingController.add(false);
    }
  }

  // -- 手机本地会话索引（Option A「会话独立」）--

  /// 用手机本地索引刷新会话列表（连接成功 / 切换设备 / 索引变更 /
  /// 引擎 session:changed 都走这里，不再向引擎拉 session/list）。
  Future<void> refreshLocalSessions() async {
    final desktopId = _transport.selectedDesktopId;
    if (desktopId == null) return;
    final gen = ++_fetchGeneration;
    final entries =
        await PhoneSessionIndex.instance.sessionsForDevice(desktopId);
    if (gen != _fetchGeneration) return; // 期间已有新刷新
    _sessions = [
      for (final e in entries)
        SessionMeta(
          id: e.sessionId,
          title: e.title,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          messageCount: 0,
          workspacePath: e.workspacePath ?? '',
          workspaceName: _wsBasename(e.workspacePath),
        ),
    ];
    // 工作区展示以本地每设备记忆为准（引擎推送值仅在没有记忆时作废回填）
    final ws = await PhoneSessionIndex.instance.workspaceFor(desktopId);
    if (gen != _fetchGeneration) return;
    if (ws != null) {
      _workspaceInfo = WorkspaceInfo(
        workspaceName: ws.displayName,
        workspacePath: ws.workspacePath,
        activeSessionId: _activeSessionId,
        sessionCount: _sessions.length,
      );
      _workspaceInfoController.add(_workspaceInfo);
      AppRestoreState.setLastWorkspacePath(ws.workspacePath);
    }
    _isLoading = false;
    _sessionsController.add(List.unmodifiable(_sessions));
    _loadingController.add(false);
    await _applyLocalSelection(gen);
  }

  /// 本地列表加载后的视图选择（仅限手机自己的会话）：
  /// 已在会话中则保持（不因索引缺条目而踢出——引擎会话/导入前会话
  /// 可能尚不在索引里）；否则恢复上次浏览；再否则停在欢迎态。
  Future<void> _applyLocalSelection(int gen) async {
    if (gen != _fetchGeneration) return;
    final currentSessionId = ChatStore.instance.currentSessionId;
    if (currentSessionId != null) {
      _activeSessionId = currentSessionId;
      _activeSessionController.add(_activeSessionId);
      return;
    }
    final desktopId = _transport.selectedDesktopId;
    if (desktopId == null) return;
    final restoreState =
        await AppRestoreState.getLastViewedSession(desktopId: desktopId);
    if (gen != _fetchGeneration) return;
    if (restoreState.hasSavedSelection) {
      final restored = restoreState.sessionId;
      if (restored == null) {
        _activeSessionId = null;
        _activeSessionController.add(null);
        return;
      }
      if (_sessions.any((s) => s.id == restored)) {
        await _applySessionSelection(restored, gen);
        return;
      }
    }
    // 没有恢复目标时停在欢迎态（「新任务」页），不自动跳进旧会话
    _activeSessionId = null;
    _activeSessionController.add(null);
  }

  static String _wsBasename(String? path) {
    if (path == null || path.isEmpty) return '';
    final seg = path.replaceAll('\\', '/').split('/').where((s) => s.isNotEmpty);
    return seg.isEmpty ? path : seg.last;
  }

  /// 进入「新建任务」欢迎态：清空视图与恢复点，不创建引擎会话——
  /// 引擎会话在首条消息发出时才创建（参考 ZCode 移动端「新任务」页）。
  Future<void> enterNewConversation() async {
    setActiveSession(null);
    ChatStore.instance.resetSessionScope();
    final desktopId = _transport.selectedDesktopId;
    if (desktopId != null) {
      await AppRestoreState.setLastViewedSession(
          desktopId: desktopId, sessionId: null,);
    }
  }

  /// 新建任务并发送首条消息：引擎建会话 → 应用节点默认模型（companion
  /// x/model/configure 落盘的偏好；失败不阻断建会话，引擎用其自身默认）→
  /// 写本地索引 → 切换视图 → 发消息。返回 false = 创建失败（调用方提示用户）。
  Future<bool> startNewConversation(String firstMessage) async {
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return false;
    }
    final result = await createSession();
    final sessionId = result?['id'] as String?;
    if (sessionId == null || sessionId.isEmpty) return false;
    await _applyNodeDefaultModel(sessionId);
    final desktopId = _transport.selectedDesktopId!;
    final now = DateTime.now().millisecondsSinceEpoch;
    final ws = await PhoneSessionIndex.instance.workspaceFor(desktopId);
    await PhoneSessionIndex.instance.upsert(
      PhoneSessionEntry(
        sessionId: sessionId,
        deviceSid: desktopId,
        title: PhoneSessionIndex.deriveTitle(firstMessage),
        firstMessage: firstMessage,
        createdAt: now,
        updatedAt: now,
        workspaceKey: ws?.workspaceKey,
        workspacePath: ws?.workspacePath ?? _workspaceInfo?.workspacePath,
      ),
    );
    setActiveSession(sessionId);
    await ChatStore.instance.switchToSession(sessionId, userInitiated: true);
    // 新会话无历史，关闭切换骨架屏；空列表会推进 _clearGeneration，
    // 随后 sendMessage 设置的 _lastUserMsgGen 更大，用户消息不会被覆盖。
    ChatStore.instance.loadFetchedMessages(sessionId, const []);
    unawaited(refreshLocalSessions());
    ChatStore.instance.sendMessage(firstMessage);
    return true;
  }

  /// 把节点默认模型应用到新建会话。旧 companion 无 x/model/* 扩展或目录
  /// 拉取失败时静默跳过（引擎自身默认仍可用），只留观测日志。
  Future<void> _applyNodeDefaultModel(String sessionId) async {
    try {
      final catalog = await NodeCatalogService.instance.modelCatalog();
      final def = catalog.defaultModel;
      if (def == null) return;
      await ConnectionManager.instance.zcodeRequest('session/setModel', {
        'sessionId': sessionId,
        'model': {
          'providerId': def.providerId,
          'modelId': def.modelId,
        },
      });
    } catch (e) {
      debugPrint('[session-sync] 应用节点默认模型失败（继续用引擎默认）: $e');
    }
  }

  /// 从引擎导入一条会话到本地索引（兜底入口：打开桌面端创建过的会话）。
  Future<bool> importEngineSession(SessionMeta meta) async {
    final desktopId = _transport.selectedDesktopId;
    if (desktopId == null || meta.id.isEmpty) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    await PhoneSessionIndex.instance.upsert(
      PhoneSessionEntry(
        sessionId: meta.id,
        deviceSid: desktopId,
        title: meta.title.isNotEmpty ? meta.title : '（无标题会话）',
        createdAt: meta.createdAt > 0 ? meta.createdAt : now,
        updatedAt: meta.updatedAt > 0 ? meta.updatedAt : now,
        workspacePath: meta.workspacePath.isNotEmpty ? meta.workspacePath : null,
      ),
    );
    await refreshLocalSessions();
    return true;
  }

  /// Load messages for a session from the desktop (with pagination).
  ///
  /// Returns a map with keys: messages, total, offset, hasMore.
  /// If cached locally and [forceRefresh] is false, returns from cache.
  Future<Map<String, dynamic>> loadSessionMessages(
    String sessionId, {
    int offset = 0,
    int limit = 50,
    bool forceRefresh = false,
  }) async {
    // Check local cache first (only for first page and when not forcing)
    if (offset == 0 && !forceRefresh) {
      final cached = _sessions.where((s) => s.id == sessionId).toList();
      if (cached.isNotEmpty && cached.first.isSynced) {
        final messages =
            await ChatDatabase.instance.getSessionMessages(sessionId);
        // 缓存校验：本地实际行数必须与桌面通报的 messageCount 一致，
        // 否则视为缓存损坏/过期，直接从桌面端拉取最新内容。
        final desktopCount = cached.first.messageCount;
        final localCount = messages.length;
        final cacheLooksValid = localCount == desktopCount ||
            // desktopCount 可能为 0（旧数据/未上报），此时仅作消息非空兜底
            (desktopCount == 0 && localCount > 0);
        if (cacheLooksValid) {
          return {
            'messages': messages,
            'total': messages.length,
            'offset': 0,
            'hasMore': false,
            'fromCache': true,
          };
        }
        // 缓存与桌面计数不符 → 标记未同步，落库后走在线拉取分支。
        await ChatDatabase.instance.markSessionUnsynced(sessionId);
      }
    }

    // Request from desktop
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      // Fallback to whatever is cached
      final messages =
          await ChatDatabase.instance.getSessionMessages(sessionId);
      return {
        'messages': messages,
        'total': messages.length,
        'offset': 0,
        'hasMore': false,
        'fromCache': true,
      };
    }

    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    _transport.send(
      WsMessage(
        event: WsEvents.sessionLoadRequest,
        data: {
          'requestId': requestId,
          'sessionId': sessionId,
          'offset': offset,
          'limit': limit,
        },
      ),
    );

    // Timeout
    Future.delayed(const Duration(seconds: 10), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout loading session messages');
      }
    });

    final result = await completer.future;
    if (result is Map<String, dynamic>) {
      return result;
    }
    return {
      'messages': <ChatMessage>[],
      'total': 0,
      'offset': 0,
      'hasMore': false,
      'fromCache': false,
    };
  }

  /// 拉取一个会话的"全部"消息：在线分页循环，直到桌面返回 hasMore=false。
  ///
  /// 修复：旧实现只取 `loadSessionMessages` 的第 1 页（默认 limit=50），
  /// 长会话超过 50 条时手机就会缺消息。本方法保证手机收到与桌面一致的完整列表。
  ///
  /// 同一 sessionId 的并发调用会被合并到同一个 Future，避免多个调用方
  /// （applySessionSelection / listResponse / drawer tap 等）同时写库造成重复行。
  ///
  /// [forceRefresh] 透传到第一页：true 表示绕过本地缓存校验。
  Future<List<ChatMessage>> loadAllSessionMessages(
    String sessionId, {
    bool forceRefresh = false,
    bool bypassInflightDedup = false,
    int pageSize = 200,
  }) {
    final existing = _inflightLoadAll[sessionId];
    if (existing != null && !bypassInflightDedup) {
      // ignore: avoid_print
      print('[SyncDiag] loadAll dedup hit for session=$sessionId');
      return existing;
    }
    final fut = _loadAllSessionMessagesImpl(
      sessionId,
      forceRefresh: forceRefresh,
      pageSize: pageSize,
    ).whenComplete(() {
      _inflightLoadAll.remove(sessionId);
    });
    _inflightLoadAll[sessionId] = fut;
    return fut;
  }

  Future<List<ChatMessage>> _loadAllSessionMessagesImpl(
    String sessionId, {
    required bool forceRefresh,
    required int pageSize,
  }) async {
    final all = <ChatMessage>[];
    var offset = 0;
    var page = 0;
    var didClear = false;
    while (true) {
      final result = await loadSessionMessages(
        sessionId,
        offset: offset,
        limit: pageSize,
        forceRefresh: forceRefresh && page == 0,
      );
      final pageMessages = (result['messages'] as List).cast<ChatMessage>();
      final hasMore = result['hasMore'] as bool? ?? false;
      // ignore: avoid_print
      print(
          '[SyncDiag] loadAll page=$page offset=$offset got=${pageMessages.length} '
          'hasMore=$hasMore total=${result['total']} session=$sessionId');

      // 仅当确实是从桌面拉取（offset 在响应里跟请求一致）且第一页时清空旧缓存。
      // 缓存命中分支会返回 offset=0/hasMore=false 且消息已是本地内容，跳过清空。
      final responseOffset = result['offset'] as int? ?? 0;
      final fromCache = result['fromCache'] as bool? ?? false;
      final fromDesktop = !fromCache && responseOffset == offset;
      if (page == 0 && !didClear && fromDesktop) {
        await ChatDatabase.instance.clearSessionMessages(sessionId);
        didClear = true;
      }
      if (didClear && pageMessages.isNotEmpty) {
        await ChatDatabase.instance
            .insertSessionMessages(sessionId, pageMessages);
      }

      all.addAll(pageMessages);
      if (!hasMore || pageMessages.isEmpty) break;
      offset += pageMessages.length;
      page++;
      // 分页提供方无视 offset（换芯栈尾窗语义：响应 offset 恒 0）时，
      // 继续翻页只会把同一个最新窗口反复累积成重复时间线——立即终止。
      // 内容在第 0 页已入库，无需补写。真分页待 afterMessageId 实测后另接。
      if (!fromCache && responseOffset != offset) {
        // ignore: avoid_print
        print('[SyncDiag] loadAll aborted: provider ignored offset '
            '($offset != $responseOffset) for $sessionId');
        break;
      }
      // 安全护栏：避免无限循环
      if (page > 200) {
        // ignore: avoid_print
        print('[SyncDiag] loadAll aborted: too many pages for $sessionId');
        break;
      }
    }
    if (didClear) {
      await ChatDatabase.instance.markSessionSynced(sessionId);
    }
    return all;
  }

  /// 打开会话（统一入口）：活跃位 → 立即切窗（骨架屏）→ 全量分页拉取。
  /// 抽屉与工作区弹层两条「点会话」入口共用——只 setActiveSession 不切内容
  /// 会造成标题是新会话、消息与发送目标还是旧会话的半切换（回归锚：
  /// project_drawer._onSessionTap 与 workspace_switcher_sheet.onSessionTap）。
  Future<void> openSession(String sessionId) async {
    setActiveSession(sessionId);
    ChatStore.instance.switchToSession(sessionId, userInitiated: true);
    try {
      final messages =
          await loadAllSessionMessages(sessionId, forceRefresh: true);
      ChatStore.instance.loadFetchedMessages(sessionId, messages);
    } catch (_) {
      // 拉取失败也要关掉骨架屏，避免 loading 永久显示
      ChatStore.instance.loadFetchedMessages(sessionId, []);
    }
  }

  /// Set the active session ID (when user taps a session).
  void setActiveSession(String? sessionId) {
    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);
  }

  /// 清空手机端本地的全部缓存（消息 + 会话元数据），重置内存状态，
  /// 并在已连接桌面时立即重新拉取最新数据。
  ///
  /// 用于"消息和桌面对不上"的兜底：手动触发以保证下一次显示一定来自桌面。
  Future<void> clearLocalCache() async {
    // ignore: avoid_print
    print('[SyncDiag] clearLocalCache: start');

    // 1. 清空 SQLite 缓存
    try {
      await ChatDatabase.instance.clearAll();
    } catch (e) {
      // ignore: avoid_print
      print('[SyncDiag] clearLocalCache: db error $e');
    }

    // 2. 失效内存中的会话与活动会话
    _fetchGeneration++; // 让任何在途的 fetch 响应作废
    _currentListRequestId = null; // 让任何旧 requestId 的响应被拒绝
    _sessions = const [];
    _activeSessionId = null;
    _sessionsController.add(const []);
    _activeSessionController.add(null);

    // 3. 清空 ChatStore 视图，让 UI 立刻显示空白
    ChatStore.instance.resetSessionScope();

    // 4. 不自动 fetchSessions — 用户清缓存就是为了清空，
    //    下次手动切换会话或重连时自然会重新拉取。
    _isLoading = false;
    // ignore: avoid_print
    print('[SyncDiag] clearLocalCache: done, cache cleared without auto-sync');
  }

  /// 设置清空会话后的冷却标记，5 秒内忽略对该会话的自动消息同步。
  void setClearCooldown(String sessionId) {
    _clearedSessionId = sessionId;
    _clearedAt = DateTime.now();
  }

  /// App 从后台切回前台时调用：刷新当前会话消息。
  ///
  /// Bug fix: 旧版只调了 loadAllSessionMessages（写 DB），
  /// 没调 ChatStore.loadFetchedMessages（更新 UI），
  /// 导致重连后消息"丢失"（DB 有但 UI 空）。
  void onAppForegrounded() {
    final currentId = ChatStore.instance.currentSessionId;
    if (currentId == null || ChatStore.instance.isStreaming) return;
    unawaited(_onAppForegroundedImpl(currentId));
  }

  Future<void> _onAppForegroundedImpl(String sessionId) async {
    // 清空会话后的冷却期（5 秒）：前台刷新不得立刻回填刚清掉的内容
    final inCooldown = _clearedSessionId == sessionId &&
        _clearedAt != null &&
        DateTime.now().difference(_clearedAt!).inSeconds < 5;
    if (inCooldown) return;
    final messages =
        await loadAllSessionMessages(sessionId, forceRefresh: true);
    // 推到 ChatStore UI — 如果用户在加载期间切换了会话，不覆盖
    if (ChatStore.instance.currentSessionId == sessionId) {
      ChatStore.instance.loadFetchedMessages(sessionId, messages);
    }
  }

  /// Create a new session on the desktop.
  Future<Map<String, dynamic>?> createSession({String? title}) async {
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return null;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    _transport.send(
      WsMessage(
        event: WsEvents.sessionCreateRequest,
        data: {'requestId': requestId, if (title != null) 'title': title},
      ),
    );

    Future.delayed(const Duration(seconds: 5), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout creating session');
      }
    });

    try {
      final result = await completer.future;
      if (result is Map) return Map<String, dynamic>.from(result);
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 删除会话 —— Option A：仅删手机本地索引与消息缓存，引擎侧副本保留。
  Future<bool> deleteSession(String sessionId) async {
    await PhoneSessionIndex.instance.remove(sessionId);
    _sessions.removeWhere((s) => s.id == sessionId);
    _sessionsController.add(List.unmodifiable(_sessions));
    ChatDatabase.instance.deleteSessionAndMessages(sessionId);
    // BUG-6 修复：删除的是当前会话 → 切换到空状态，避免显示僵尸 UI
    if (sessionId == ChatStore.instance.currentSessionId) {
      await enterNewConversation();
    }
    return true;
  }

  /// 重命名会话 —— Option A：本地索引改名，不触碰引擎侧标题。
  Future<bool> renameSession(String sessionId, String title) async {
    await PhoneSessionIndex.instance.rename(sessionId, title);
    final idx = _sessions.indexWhere((s) => s.id == sessionId);
    if (idx != -1) {
      _sessions[idx] = _sessions[idx].copyWith(title: title);
      _sessionsController.add(List.unmodifiable(_sessions));
    }
    return true;
  }

  /// Fetch list of recent workspaces from the desktop.
  Future<void> fetchWorkspaces() async {
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return;
    }
    final requestId = _nextRequestId();
    _transport.send(
      WsMessage(
        event: WsEvents.workspaceListRequest,
        data: {'requestId': requestId},
      ),
    );
  }

  /// Switch the desktop to a different workspace.
  Future<bool> switchWorkspace(String workspacePath) async {
    if (_transport.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return false;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    _transport.send(
      WsMessage(
        event: WsEvents.workspaceSwitchRequest,
        data: {'requestId': requestId, 'workspacePath': workspacePath},
      ),
    );

    // 持久化工作区路径，用于自动恢复
    AppRestoreState.setLastWorkspacePath(workspacePath);

    Future.delayed(const Duration(seconds: 10), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout switching workspace');
      }
    });

    try {
      final result = await completer.future;
      if (result is Map) return result['success'] as bool? ?? false;
      return false;
    } catch (_) {
      return false;
    }
  }

  // -- Local cache --
  Future<void> _loadCachedSessions() async {
    // Option A：启动时直接读手机本地索引（不再读引擎会话的 DB 缓存，
    // 避免桌面端旧会话闪现后又被本地列表顶掉）
    if (_hasSelectedDesktopTarget) {
      await refreshLocalSessions();
    }
  }

  // -- Helpers --

  String _nextRequestId() {
    _requestCounter++;
    return 'req_${DateTime.now().millisecondsSinceEpoch}_$_requestCounter';
  }

  void _completePending(String requestId, dynamic result, {String? error}) {
    final completer = _pendingRequests.remove(requestId);
    if (completer != null && !completer.isCompleted) {
      if (error != null) {
        completer.completeError(error);
      } else {
        completer.complete(result);
      }
    }
  }

  void _clearDesktopScopedState() {
    _fetchGeneration++;
    _isLoading = false;
    _loadingController.add(false);
    _workspaceInfo = null;
    _workspaceInfoController.add(null);
    _sessions = [];
    _activeSessionId = null;
    _sessionsController.add([]);
    _activeSessionController.add(null);
    _workspaces = [];
    _workspacesController.add([]);
    ChatStore.instance.resetSessionScope();
  }

  Future<void> _applySessionSelection(String sessionId, int generation) async {
    await _applySessionSelectionImpl(sessionId, generation);
  }

  Future<void> _refreshSessionAfterInflight(
    String sessionId,
    int generation,
  ) async {
    final inflight = _inflightLoadAll[sessionId];
    if (inflight != null) {
      try {
        await inflight;
      } catch (_) {
        // 后续强制刷新会重新向桌面拉取，旧 inflight 的错误不应阻断终态刷新。
      }
    }
    await _applySessionSelectionImpl(
      sessionId,
      generation,
      bypassInflightDedup: true,
    );
  }

  Future<void> _applySessionSelectionImpl(
    String sessionId,
    int generation, {
    bool bypassInflightDedup = false,
  }) async {
    if (generation != _fetchGeneration) return;

    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);
    await ChatStore.instance.switchToSession(sessionId);

    if (generation != _fetchGeneration) return;

    // ignore: avoid_print
    print(
        '[SyncDiag] applySessionSelection start session=$sessionId gen=$generation',);
    final allMessages = await loadAllSessionMessages(
      sessionId,
      forceRefresh: true,
      bypassInflightDedup: bypassInflightDedup,
    );
    if (generation != _fetchGeneration) return;

    // ignore: avoid_print
    print(
        '[SyncDiag] applySessionSelection done session=$sessionId loaded=${allMessages.length}',);
    ChatStore.instance.loadFetchedMessages(sessionId, allMessages);
  }

  Future<void> _restorePersistedSessionView() async {
    final desktopId = _transport.selectedDesktopId;
    if (desktopId == null) return;

    final restoreState = await AppRestoreState.getLastViewedSession(
      desktopId: desktopId,
    );
    if (!restoreState.hasSavedSelection) return;

    _activeSessionId = restoreState.sessionId;
    _activeSessionController.add(_activeSessionId);
    await ChatStore.instance.switchToSession(restoreState.sessionId);
  }

  /// Transform a desktop JSONL message to a mobile [ChatMessage].
  ChatMessage _fromDesktopMessage(Map<String, dynamic> json) {
    final role = json['role'] as String? ?? 'assistant';
    MessageRole messageRole;
    switch (role) {
      case 'user':
        messageRole = MessageRole.user;
        break;
      case 'tool_result':
        messageRole = MessageRole.tool;
        break;
      default:
        messageRole = MessageRole.assistant;
    }

    // Handle tool calls embedded in assistant messages
    // 双词表：桌面 legacy 行用 toolCalls/{id,name,input}；引擎行
    // （翻译层 _mapEngineMessage）用 tool_calls/{toolCallId,toolName,inputSummary}。
    // 引擎行的助手消息可只含工具 part（无文本），丢键即渲染成空气泡。
    List<ToolCallInfo>? toolCalls;
    final rawToolCalls = json['toolCalls'] is List
        ? json['toolCalls'] as List
        : json['tool_calls'] is List ? json['tool_calls'] as List : null;
    if (rawToolCalls != null) {
      toolCalls = rawToolCalls.whereType<Map>().map((tc) {
        final tcMap = Map<String, dynamic>.from(tc);
        final name = (tcMap['name'] ?? tcMap['toolName'] ?? '').toString();
        final statusRaw = tcMap['status']?.toString();
        final status = switch (statusRaw) {
          'running' => ToolCallStatus.running,
          'error' => ToolCallStatus.error,
          'done' || 'completed' => ToolCallStatus.done,
          _ => ToolCallStatus.done,
        };
        return ToolCallInfo(
          toolCallId: (tcMap['id'] ?? tcMap['toolCallId'] ?? '').toString(),
          toolName: name,
          // 引擎行直接给 inputSummary 字符串；legacy 行给 input 对象现场摘要
          inputSummary: _summarizeToolInput(
            name,
            tcMap['input'] ?? tcMap['inputSummary'],
          ),
          status: status,
        );
      }).toList();
    }

    TokenUsage? usage;
    if (json['usage'] is Map) {
      final u = Map<String, dynamic>.from(json['usage'] as Map);
      final inTok = u['inputTokens'] ?? u['input_tokens'];
      final outTok = u['outputTokens'] ?? u['output_tokens'];
      usage = TokenUsage(
        inputTokens: inTok is num ? inTok.toInt() : 0,
        outputTokens: outTok is num ? outTok.toInt() : 0,
      );
    }

    final tsRaw = json['timestamp'] ?? json['created_at'];
    final timestamp = tsRaw is int
        ? tsRaw
        : DateTime.now().millisecondsSinceEpoch;

    // 提取文本内容：优先使用 content 字段；若为空，从 contentBlocks 中拼接 text 块
    // 这是 Anthropic interleaved 格式的兼容处理
    String content = json['content'] as String? ?? '';
    if (content.isEmpty && json['contentBlocks'] is List) {
      final blocks = json['contentBlocks'] as List;
      final textParts = blocks
          .whereType<Map>()
          .where((b) => b['type'] == 'text')
          .map((b) => (b['text'] as String?) ?? '')
          .where((t) => t.isNotEmpty)
          .toList();
      if (textParts.isNotEmpty) {
        content = textParts.join('\n');
      }
    }

    return ChatMessage(
      role: messageRole,
      content: content,
      createdAt: DateTime.fromMillisecondsSinceEpoch(timestamp),
      toolCalls: toolCalls,
      usage: usage,
      toolCallId: json['toolCallId'] as String?,
      toolName: role == 'tool_result' ? (json['toolName'] as String?) : null,
      toolInput: null,
      toolOutput: role == 'tool_result' ? (json['content'] as String?) : null,
      toolStatus: role == 'tool_result'
          ? (json['isError'] == true
              ? ToolCallStatus.error
              : ToolCallStatus.done)
          : null,
      // 子智能体归属（翻译层从引擎 info.agent 透传）；主时间线为 null
      agent: json['agent'] as String?,
    );
  }

  String? _summarizeToolInput(String? toolName, dynamic input) {
    if (input == null) return null;
    if (input is! Map) return input.toString();
    final map = Map<String, dynamic>.from(input);
    switch (toolName) {
      case 'Bash':
        return map['command'] as String?;
      case 'Read':
        return map['file_path'] as String?;
      case 'Write':
        return map['file_path'] as String?;
      case 'Edit':
        return map['file_path'] as String?;
      case 'Grep':
        return map['pattern'] as String?;
      case 'Glob':
        return map['pattern'] as String?;
      default:
        return map.keys.take(2).join(', ');
    }
  }

  void dispose() {
    _wsSubscription?.cancel();
    _stateSub?.cancel();
    _sessionsController.close();
    _activeSessionController.close();
    _workspaceInfoController.close();
    _loadingController.close();
    _workspacesController.close();
  }
}
