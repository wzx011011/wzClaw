import 'dart:async';

import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/session_meta.dart';
import '../models/ws_message.dart';
import 'chat_database.dart';
import 'chat_store.dart';
import 'connection_manager.dart';
import 'task_service.dart';

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

class WorkspaceItem {
  final String path;
  final String name;
  final bool isCurrent;

  const WorkspaceItem({
    required this.path,
    required this.name,
    required this.isCurrent,
  });
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
  StreamSubscription<bool>? _desktopOnlineSub;
  // ignore: unused_field — holds subscription reference to prevent GC
  StreamSubscription<String?>? _activeTaskSub;
  int _requestCounter = 0;
  int _fetchGeneration = 0; // 递增以丢弃过期的 fetchSessions 响应
  final Map<String, Completer<dynamic>> _pendingRequests = {};

  List<SessionMeta> get sessions => List.unmodifiable(_sessions);
  String? get activeSessionId => _activeSessionId;
  WorkspaceInfo? get workspaceInfo => _workspaceInfo;
  bool get isLoading => _isLoading;

  void _init() {
    _wsSubscription =
        ConnectionManager.instance.messageStream.listen(_handleWsMessage);
    _stateSub =
        ConnectionManager.instance.stateStream.listen(_handleConnectionState);
    _desktopOnlineSub =
        ConnectionManager.instance.desktopOnlineStream.listen(_handleDesktopOnline);
    // Gate session fetching on active task: when task changes, clear old
    // sessions and re-fetch if we are connected and desktop is online.
    _activeTaskSub =
        TaskService.instance.activeTaskIdStream.listen(_handleActiveTaskChanged);
    _loadCachedSessions();
  }

  // -- Connection state handler --
  void _handleConnectionState(WsConnectionState state) {
    if (state == WsConnectionState.connected) {
      // Only fetch sessions when a task is already selected.
      if (TaskService.instance.activeTaskId == null) return;
      // Small delay to let identity exchange happen first
      Future.delayed(const Duration(milliseconds: 800), () {
        if (ConnectionManager.instance.state == WsConnectionState.connected &&
            TaskService.instance.activeTaskId != null) {
          fetchSessions();
        }
      });
    } else if (state == WsConnectionState.disconnected) {
      // Clear workspace info when disconnected from relay
      _workspaceInfo = null;
      _workspaceInfoController.add(null);
    }
  }

  // -- Desktop online state handler --
  void _handleDesktopOnline(bool online) {
    if (!online) {
      // Desktop disconnected — clear stale workspace info
      _workspaceInfo = null;
      _workspaceInfoController.add(null);
      _sessions = [];
      _sessionsController.add([]);
    } else if (online &&
        ConnectionManager.instance.state == WsConnectionState.connected &&
        TaskService.instance.activeTaskId != null) {
      // Desktop came online — fetch sessions after a small delay
      Future.delayed(const Duration(milliseconds: 800), () {
        if (ConnectionManager.instance.desktopOnline &&
            TaskService.instance.activeTaskId != null) {
          fetchSessions();
        }
      });
    }
  }

  // -- Active task change handler --
  void _handleActiveTaskChanged(String? taskId) {
    // Clear current sessions immediately so stale list is not shown.
    _sessions = [];
    _activeSessionId = null;
    _sessionsController.add([]);
    _activeSessionController.add(null);

    // Clear chat messages — old task's messages should not be visible.
    ChatStore.instance.loadFetchedMessages([]);
    ChatStore.instance.currentSessionId = null;

    if (taskId != null &&
        ConnectionManager.instance.state == WsConnectionState.connected &&
        ConnectionManager.instance.desktopOnline) {
      // Task was selected and we are already connected — fetch right away.
      Future.delayed(const Duration(milliseconds: 300), () {
        if (TaskService.instance.activeTaskId != null &&
            ConnectionManager.instance.state == WsConnectionState.connected) {
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

  void _handleSessionListResponse(dynamic data) {
    if (data is! Map) return;
    final requestId = data['requestId'] as String? ?? '';
    final workspacePath = data['workspacePath'] as String? ?? '';
    final workspaceName = data['workspaceName'] as String? ?? '';
    final rawSessions = data['sessions'] as List? ?? [];

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

    _sessions = sessions;
    _isLoading = false;
    _sessionsController.add(List.unmodifiable(_sessions));
    _loadingController.add(false);

    // Cache to local DB
    ChatDatabase.instance.upsertSessions(sessions);

    // Auto-load the most recent session's messages so the user sees
    // the latest conversation instead of an empty chat.
    // 仅当此响应属于当前 generation 时才自动加载，防止过期响应覆盖用户输入。
    if (sessions.isNotEmpty && gen == _fetchGeneration) {
      final latestSession = sessions.first;
      _activeSessionId = latestSession.id;
      _activeSessionController.add(_activeSessionId);
      loadSessionMessages(latestSession.id).then((result) {
        // 二次检查：loadSessionMessages 是异步的，返回时 generation 可能已变
        if (gen != _fetchGeneration) return;
        final messages = result['messages'] as List<ChatMessage>;
        ChatStore.instance.loadFetchedMessages(messages);
        ChatStore.instance.currentSessionId = latestSession.id;
      });
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

    // Only auto-fetch sessions when a task is selected.
    if (TaskService.instance.activeTaskId != null) {
      fetchSessions();
    }
  }

  void _handleSessionActive(dynamic data) {
    if (data is! Map) return;
    final sessionId = data['sessionId'] as String?;
    if (sessionId != null) {
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
    final rawWorkspaces = data['workspaces'] as List? ?? [];
    _workspaces = rawWorkspaces.whereType<Map>().map((w) => WorkspaceItem(
      path: w['path'] as String? ?? '',
      name: w['name'] as String? ?? '',
      isCurrent: w['isCurrent'] as bool? ?? false,
    ),).toList();
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
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
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionListRequest,
      data: {
        'requestId': requestId,
        'activeTaskId': TaskService.instance.activeTaskId,
      },
    ),);
    // Timeout — also clean up pending request
    _pendingRequests[requestId] = Completer<dynamic>();
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
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
        'activeTaskId': TaskService.instance.activeTaskId,
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) return null;
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionCreateRequest,
      data: {'requestId': requestId, if (title != null) 'title': title,
        'activeTaskId': TaskService.instance.activeTaskId},
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) return false;
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionDeleteRequest,
      data: {'requestId': requestId, 'sessionId': sessionId,
        'activeTaskId': TaskService.instance.activeTaskId},
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) return false;
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.sessionRenameRequest,
      data: {'requestId': requestId, 'sessionId': sessionId, 'title': title,
        'activeTaskId': TaskService.instance.activeTaskId},
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
    if (ConnectionManager.instance.state != WsConnectionState.connected) return;
    final requestId = _nextRequestId();
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.workspaceListRequest,
      data: {'requestId': requestId},
    ),);
  }

  /// Switch the desktop to a different workspace.
  Future<bool> switchWorkspace(String workspacePath) async {
    if (ConnectionManager.instance.state != WsConnectionState.connected) return false;
    final requestId = _nextRequestId();
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.workspaceSwitchRequest,
      data: {'requestId': requestId, 'workspacePath': workspacePath},
    ),);

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
    if (cached.isNotEmpty && _sessions.isEmpty) {
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

    return ChatMessage(
      role: messageRole,
      content: json['content'] as String? ?? '',
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
