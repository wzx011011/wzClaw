import 'dart:async';

import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/session_meta.dart';
import '../models/ws_message.dart';
import 'app_restore_state.dart';
import 'chat_database.dart';
import 'chat_store.dart';
import 'connection_manager.dart';

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

  const SessionSummary({
    required this.id,
    required this.title,
    required this.updatedAt,
    required this.messageCount,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> json) => SessionSummary(
        id: json['id'] as String? ?? '',
        title: json['title'] as String? ?? 'Untitled',
        updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
        messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
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
  SessionSyncService._() {
    _init();
  }

  // -- Reactive state streams --
  final _sessionsController =
      StreamController<List<SessionMeta>>.broadcast();
  Stream<List<SessionMeta>> get sessionsStream => _sessionsController.stream;

  final _activeSessionController = StreamController<String?>.broadcast();
  Stream<String?> get activeSessionStream => _activeSessionController.stream;

  final _workspaceInfoController =
      StreamController<WorkspaceInfo?>.broadcast();
  Stream<WorkspaceInfo?> get workspaceInfoStream =>
      _workspaceInfoController.stream;

  final _loadingController = StreamController<bool>.broadcast();
  Stream<bool> get loadingStream => _loadingController.stream;

  final _workspacesController = StreamController<List<WorkspaceItem>>.broadcast();
  Stream<List<WorkspaceItem>> get workspacesStream => _workspacesController.stream;
  List<WorkspaceItem> _workspaces = [];
  List<WorkspaceItem> get workspaces => List.unmodifiable(_workspaces);

  // -- Internal state --
  List<SessionMeta> _sessions = [];
  String? _activeSessionId;
  WorkspaceInfo? _workspaceInfo;
  bool _isLoading = false;
  DateTime? _lastSessionFetchTime;
  StreamSubscription<WsMessage>? _wsSubscription;
  StreamSubscription<WsConnectionState>? _stateSub;
  // ignore: unused_field — holds subscription reference to prevent GC
  StreamSubscription<String?>? _desktopOnlineSub;
  int _requestCounter = 0;
  int _fetchGeneration = 0; // 递增以丢弃过期的 fetchSessions 响应
  final Map<String, Completer<dynamic>> _pendingRequests = {};

  List<SessionMeta> get sessions => List.unmodifiable(_sessions);
  String? get activeSessionId => _activeSessionId;
  WorkspaceInfo? get workspaceInfo => _workspaceInfo;
  bool get isLoading => _isLoading;
  bool get _hasSelectedDesktopTarget =>
      ConnectionManager.instance.selectedDesktopId != null;

  void _init() {
    _wsSubscription =
        ConnectionManager.instance.messageStream.listen(_handleWsMessage);
    _stateSub =
        ConnectionManager.instance.stateStream.listen(_handleConnectionState);
    _desktopOnlineSub =
        ConnectionManager.instance.selectedDesktopIdStream.listen(_handleDesktopOnline);
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
        if (ConnectionManager.instance.state == WsConnectionState.connected &&
            _hasSelectedDesktopTarget) {
          fetchSessions();
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
    } else if (ConnectionManager.instance.state == WsConnectionState.connected) {
      unawaited(_restorePersistedSessionView());
      Future.delayed(const Duration(milliseconds: 800), () {
        if (_hasSelectedDesktopTarget) {
          fetchSessions();
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
        // Desktop pushed a session change — refresh the list
        fetchSessions();
        break;
    }
  }

  // -- Response handlers --

  void _handleSessionListResponse(dynamic data) async {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final workspacePath = data['workspacePath'] as String? ?? '';
    final workspaceName = data['workspaceName'] as String? ?? '';
    final rawSessions = data['sessions'] as List? ?? [];
    // 桌面端当前活跃会话（新增字段，旧桌面端可能为 null）
    final desktopActiveSessionId = data['activeSessionId'] as String?;
    final desktopId = ConnectionManager.instance.selectedDesktopId;

    // 快照当前 generation，用于后续判断响应是否过期
    final gen = _fetchGeneration;

    final sessions = rawSessions
        .whereType<Map>()
        .map((s) => SessionMeta.fromDesktopJson(
              Map<String, dynamic>.from(s),
              workspacePath,
              workspaceName,
            ),)
        .toList();

    if (!_hasSelectedDesktopTarget || desktopId == null) {
      _isLoading = false;
      _loadingController.add(false);
      _completePending(requestId, const <SessionMeta>[]);
      return;
    }

    _workspaceInfo = WorkspaceInfo(
      workspaceName: workspaceName,
      workspacePath: workspacePath,
      activeSessionId: desktopActiveSessionId ??
          _activeSessionId ??
          (sessions.isNotEmpty ? sessions.first.id : null),
      sessionCount: sessions.length,
    );
    _workspaceInfoController.add(_workspaceInfo);

    // 在更新 _sessions 之前保存旧的 messageCount 映射，用于后续判断是否有新消息
    final oldMessageCounts = Map.fromEntries(
      _sessions.map((s) => MapEntry(s.id, s.messageCount)),
    );

    _sessions = sessions;
    _isLoading = false;
    _sessionsController.add(List.unmodifiable(_sessions));
    _loadingController.add(false);

    // 持久化工作区路径，用于自动恢复
    if (workspacePath.isNotEmpty) {
      AppRestoreState.setLastWorkspacePath(workspacePath);
    }

    // Cache to local DB
    ChatDatabase.instance.upsertSessions(sessions);

    final currentSessionId = ChatStore.instance.currentSessionId;
    final currentSessionStillExists = currentSessionId != null &&
        sessions.any((session) => session.id == currentSessionId);
    final restoreState = await AppRestoreState.getLastViewedSession(
      desktopId: desktopId,
    );

    if (gen != _fetchGeneration) {
      _completePending(requestId, sessions);
      return;
    }

    if (currentSessionId != null && !currentSessionStillExists) {
      await ChatStore.instance.switchToSession(null);
      if (gen != _fetchGeneration) {
        _completePending(requestId, sessions);
        return;
      }
    }

    if (currentSessionStillExists) {
      _activeSessionId = currentSessionId;
      _activeSessionController.add(_activeSessionId);

      // 若当前会话消息数量有变化（桌面端新增了消息），且当前不在流式状态，
      // 则强制从桌面重新拉取消息，确保手机端展示最新内容。
      if (gen == _fetchGeneration && !ChatStore.instance.isStreaming) {
        final newSession = sessions.firstWhere(
          (s) => s.id == currentSessionId,
          orElse: () => sessions.first,
        );
        final oldCount = oldMessageCounts[currentSessionId];
        if (oldCount == null || newSession.messageCount != oldCount) {
          try {
            final result = await loadSessionMessages(
              currentSessionId!,
              forceRefresh: true,
            );
            if (gen == _fetchGeneration) {
              ChatStore.instance.loadFetchedMessages(
                result['messages'] as List<ChatMessage>,
              );
            }
          } catch (e) {
            // WR-03修复: async void 函数内异常不再静默丢弃；
            // 保留现有消息可见，不影响用户体验。
            // ignore: avoid_print
            print('[SessionSync] force-refresh failed: $e');
          }
        }
      }

      _completePending(requestId, sessions);
      return;
    }

    final restoredSessionId = restoreState.sessionId;
    if (restoreState.hasSavedSelection) {
      if (restoredSessionId == null) {
        _activeSessionId = null;
        _activeSessionController.add(null);
        _completePending(requestId, sessions);
        return;
      }

      if (sessions.any((session) => session.id == restoredSessionId)) {
        await _applySessionSelection(restoredSessionId, gen);
        _completePending(requestId, sessions);
        return;
      }
    }

    // Auto-load the most recent session's messages so the user sees
    // the latest conversation instead of an empty chat.
    // 仅当此响应属于当前 generation 时才自动加载，防止过期响应覆盖用户输入。
    // 串台修复: 若手机已在浏览某个会话 (currentSessionId != null)，不自动跳转，
    // 避免桌面切换/新建会话时强制覆盖手机用户当前视图。
    if (sessions.isNotEmpty && gen == _fetchGeneration) {
      await _applySessionSelection(sessions.first.id, gen);
    }

    // Resolve pending request if any
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
        messages.add(_fromDesktopMessage(Map<String, dynamic>.from(raw)));
      }
    }

    // Cache messages locally
    if (offset == 0) {
      // First page: clear existing and insert fresh
      ChatDatabase.instance.clearSessionMessages(sessionId).then((_) {
        ChatDatabase.instance.insertSessionMessages(sessionId, messages);
        if (!hasMore) {
          ChatDatabase.instance.markSessionSynced(sessionId);
        }
      });
    } else {
      // Subsequent pages: append
      ChatDatabase.instance.insertSessionMessages(sessionId, messages);
      if (!hasMore) {
        ChatDatabase.instance.markSessionSynced(sessionId);
      }
    }

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
      fetchSessions();
    }
  }

  void _handleSessionActive(dynamic data) {
    if (data is! Map) return;
    if (!_hasSelectedDesktopTarget) return;
    final sessionId = data['sessionId'] as String?;
    // 同步 ChatStore 的 sessionId，防止 _isWrongSession 误判丢弃流式事件
    if (sessionId != null) {
      ChatStore.instance.syncSessionId(sessionId);
      _activeSessionId = sessionId;
      _activeSessionController.add(_activeSessionId);
    }
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
    if (sessionData is Map) {
      final session = SessionMeta(
        id: sessionData['id'] as String? ?? '',
        title: sessionData['title'] as String? ?? 'New Session',
        createdAt: (sessionData['createdAt'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        updatedAt: (sessionData['updatedAt'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch,
        messageCount: (sessionData['messageCount'] as num?)?.toInt() ?? 0,
        workspacePath: _workspaceInfo?.workspacePath ?? '',
        workspaceName: _workspaceInfo?.workspaceName ?? '',
      );
      _sessions.insert(0, session);
      _sessionsController.add(List.unmodifiable(_sessions));
      ChatDatabase.instance.upsertSessions([session]);
    }
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
      // New format: workspace objects from WorkspaceStore
      if (w.containsKey('id') && w.containsKey('title')) {
        final rawProjects = w['projects'] as List? ?? [];
        final projects = rawProjects.whereType<Map>().map((p) => WorkspaceProject(
          id: p['id'] as String? ?? '',
          path: p['path'] as String? ?? '',
          name: p['name'] as String? ?? '',
        )).toList();
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
              .map((s) => SessionSummary.fromJson(Map<String, dynamic>.from(s)))
              .toList(),
          activeSessionId: w['activeSessionId'] as String?,
        );
      }
      // Old format: folder paths (fallback)
      return WorkspaceItem(
        id: w['path'] as String? ?? '',
        title: w['name'] as String? ?? '',
        projects: w['path'] != null ? [WorkspaceProject(id: '', path: w['path'] as String, name: w['name'] as String? ?? '')] : [],
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

  /// Request session list from the connected desktop.
  void fetchSessions() {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return;
    }
    // Dedup: skip if fetched within last 2 seconds.
    final now = DateTime.now();
    if (_lastSessionFetchTime != null &&
        now.difference(_lastSessionFetchTime!) < const Duration(seconds: 2)) {
      return;
    }
    _lastSessionFetchTime = now;
    _fetchGeneration++; // 递增使过期响应可被检测

    _isLoading = true;
    _loadingController.add(true);
    final requestId = _nextRequestId();
    // Bug3修复: 先注册 Completer，再发送消息，避免极速响应到达时找不到对应 requestId
    _pendingRequests[requestId] = Completer<dynamic>();
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionListRequest,
      data: {
        'requestId': requestId,
      },
    ),);
    // Timeout — also clean up pending request
    Future.delayed(const Duration(seconds: 5), () {
      if (_isLoading) {
        _isLoading = false;
        _loadingController.add(false);
        final completer = _pendingRequests.remove(requestId);
        if (completer != null && !completer.isCompleted) {
          completer.completeError('Timeout fetching sessions');
        }
      }
    });
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
        return {
          'messages': messages,
          'total': messages.length,
          'offset': 0,
          'hasMore': false,
        };
      }
    }

    // Request from desktop
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
      !_hasSelectedDesktopTarget) {
      // Fallback to whatever is cached
      final messages =
          await ChatDatabase.instance.getSessionMessages(sessionId);
      return {
        'messages': messages,
        'total': messages.length,
        'offset': 0,
        'hasMore': false,
      };
    }

    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionLoadRequest,
      data: {
        'requestId': requestId,
        'sessionId': sessionId,
        'offset': offset,
        'limit': limit,
      },
    ),);

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
    return {'messages': <ChatMessage>[], 'total': 0, 'offset': 0, 'hasMore': false};
  }

  /// Set the active session ID (when user taps a session).
  void setActiveSession(String? sessionId) {
    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);
  }

  /// Create a new session on the desktop.
  Future<Map<String, dynamic>?> createSession({String? title}) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return null;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionCreateRequest,
      data: {'requestId': requestId, if (title != null) 'title': title},
    ),);

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

  /// Delete a session on the desktop.
  Future<bool> deleteSession(String sessionId) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return false;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionDeleteRequest,
      data: {'requestId': requestId, 'sessionId': sessionId},
    ),);

    Future.delayed(const Duration(seconds: 5), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout deleting session');
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

  /// Rename a session on the desktop.
  Future<bool> renameSession(String sessionId, String title) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return false;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionRenameRequest,
      data: {'requestId': requestId, 'sessionId': sessionId, 'title': title},
    ),);

    Future.delayed(const Duration(seconds: 5), () {
      if (!completer.isCompleted) {
        _pendingRequests.remove(requestId);
        completer.completeError('Timeout renaming session');
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

  /// Fetch list of recent workspaces from the desktop.
  Future<void> fetchWorkspaces() async {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return;
    }
    final requestId = _nextRequestId();
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.workspaceListRequest,
      data: {'requestId': requestId},
    ),);
  }

  /// Switch the desktop to a different workspace.
  Future<bool> switchWorkspace(String workspacePath) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected ||
        !_hasSelectedDesktopTarget) {
      return false;
    }
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.workspaceSwitchRequest,
      data: {'requestId': requestId, 'workspacePath': workspacePath},
    ),);

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
    final cached = await ChatDatabase.instance.getSessions();
    if (_hasSelectedDesktopTarget && cached.isNotEmpty && _sessions.isEmpty) {
      _sessions = cached;
      _sessionsController.add(List.unmodifiable(_sessions));
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
    _lastSessionFetchTime = null;
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
    if (generation != _fetchGeneration) return;

    _activeSessionId = sessionId;
    _activeSessionController.add(_activeSessionId);
    await ChatStore.instance.switchToSession(sessionId);

    if (generation != _fetchGeneration) return;

    final result = await loadSessionMessages(sessionId);
    if (generation != _fetchGeneration) return;

    final messages = result['messages'] as List<ChatMessage>;
    ChatStore.instance.loadFetchedMessages(messages);
  }

  Future<void> _restorePersistedSessionView() async {
    final desktopId = ConnectionManager.instance.selectedDesktopId;
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
    List<ToolCallInfo>? toolCalls;
    if (json['toolCalls'] is List) {
      toolCalls = (json['toolCalls'] as List)
          .whereType<Map>()
          .map((tc) {
        final tcMap = Map<String, dynamic>.from(tc);
        return ToolCallInfo(
          toolCallId: tcMap['id'] as String? ?? '',
          toolName: tcMap['name'] as String? ?? '',
          inputSummary: _summarizeToolInput(
              tcMap['name'] as String?, tcMap['input'],),
          status: ToolCallStatus.done,
        );
      }).toList();
    }

    TokenUsage? usage;
    if (json['usage'] is Map) {
      final u = Map<String, dynamic>.from(json['usage'] as Map);
      usage = TokenUsage(
        inputTokens: (u['inputTokens'] as num?)?.toInt() ?? 0,
        outputTokens: (u['outputTokens'] as num?)?.toInt() ?? 0,
      );
    }

    final timestamp = json['timestamp'] as int? ??
        DateTime.now().millisecondsSinceEpoch;

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
