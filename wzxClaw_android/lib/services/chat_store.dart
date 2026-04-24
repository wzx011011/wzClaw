import 'dart:async';
import 'dart:convert';
import 'dart:math';

import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/ws_message.dart';
import 'chat_database.dart';
import 'connection_manager.dart';
import 'task_service.dart';

/// Permission request from the desktop agent.
class PermissionRequest {
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> input;

  const PermissionRequest({
    required this.toolCallId,
    required this.toolName,
    required this.input,
  });
}

/// AskUserQuestion request from the desktop agent.
class AskUserQuestion {
  final String questionId;
  final String question;
  final List<Map<String, String>> options; // [{label, description}]
  final bool multiSelect;

  const AskUserQuestion({
    required this.questionId,
    required this.question,
    required this.options,
    this.multiSelect = false,
  });
}

class ChatStore {
  static final ChatStore _instance = ChatStore._();
  static ChatStore get instance => _instance;
  ChatStore._() {
    _init();
  }

  // -- Reactive state --
  final _messagesController = StreamController<List<ChatMessage>>.broadcast();
  Stream<List<ChatMessage>> get messagesStream => _messagesController.stream;

  final _streamingController = StreamController<bool>.broadcast();
  Stream<bool> get streamingStream => _streamingController.stream;

  final _permissionController =
      StreamController<PermissionRequest?>.broadcast();
  Stream<PermissionRequest?> get permissionStream =>
      _permissionController.stream;

  final _waitingController = StreamController<bool>.broadcast();
  Stream<bool> get waitingStream => _waitingController.stream;

  final _planModeController =
      StreamController<Map<String, dynamic>?>.broadcast();
  Stream<Map<String, dynamic>?> get planModeStream =>
      _planModeController.stream;

  final _askUserController = StreamController<AskUserQuestion?>.broadcast();
  Stream<AskUserQuestion?> get askUserStream => _askUserController.stream;

  // -- Internal state --
  final List<ChatMessage> _messages = [];
  ChatMessage? _streamingMessage;
  bool _isStreaming = false;

  // Cached display list — rebuilt only when _messages or _streamingMessage changes.
  List<ChatMessage> _cachedDisplayMessages = const [];
  int _cachedMessagesLength = -1;
  bool _cachedHadStreaming = false;
  StreamSubscription<WsMessage>? _wsSubscription;
  String? _currentSessionId;
  bool _isBrowsingHistory = false; // true when viewing a historical session
  bool _isWaitingForResponse = false;
  String? _lastErrorText;
  DateTime? _lastErrorTime;
  final Map<String, bool> _pendingMessageIds = {}; // messageId tracking for ack

  // -- Clear guard: 防止 fetchSessions 延迟响应覆盖用户消息 --
  int _clearGeneration = 0;     // 每次 loadFetchedMessages([]) 清空时递增
  int _lastUserMsgGen = 0;      // 用户最后发消息时的 generation

  // -- Thinking state --
  static const _maxThinkingChars = 50000; // 约 50KB 上限，防止无限累积
  String _thinkingContent = '';
  String get thinkingContent => _thinkingContent;
  final _thinkingController = StreamController<String>.broadcast();
  Stream<String> get thinkingStream => _thinkingController.stream;

  // -- Todo state --
  List<Map<String, String>> _todos = [];
  List<Map<String, String>> get todos => List.unmodifiable(_todos);

  // -- Permission mode state --
  String _permissionMode = 'always-ask';
  String get permissionMode => _permissionMode;

  bool get isStreaming => _isStreaming;
  bool get isWaitingForResponse => _isWaitingForResponse;
  String? get currentSessionId => _currentSessionId;
  set currentSessionId(String? id) => _currentSessionId = id;
  bool get isBrowsingHistory => _isBrowsingHistory;

  List<ChatMessage> get messages => List.unmodifiable(_messages);

  List<ChatMessage> get displayMessages {
    final hasStreaming = _streamingMessage != null;
    final msgLen = _messages.length;
    if (msgLen == _cachedMessagesLength && hasStreaming == _cachedHadStreaming) {
      return _cachedDisplayMessages;
    }
    _cachedMessagesLength = msgLen;
    _cachedHadStreaming = hasStreaming;
    if (hasStreaming) {
      _cachedDisplayMessages = [..._messages, _streamingMessage!];
    } else {
      _cachedDisplayMessages = List.unmodifiable(_messages);
    }
    return _cachedDisplayMessages;
  }

  void _init() {
    _wsSubscription =
        ConnectionManager.instance.messageStream.listen(_handleWsMessage);
    ConnectionManager.instance.stateStream.listen(_handleConnectionState);
  }

  void _handleConnectionState(WsConnectionState state) {
    if (state == WsConnectionState.disconnected) {
      // 断连时清理 pending，桌面端重启后这些 messageId 不会再被 ack
      _pendingMessageIds.clear();
    }
  }

  void _handleWsMessage(WsMessage wsMsg) {
    try {
      switch (wsMsg.event) {
        // -- stream:agent:* format --
        case WsEvents.agentText:
          _handleAgentText(wsMsg.data);
          break;
        case WsEvents.agentThinking:
          _handleAgentThinking(wsMsg.data);
          break;
        case WsEvents.agentToolCall:
          _handleAgentToolCall(wsMsg.data);
          break;
        case WsEvents.agentToolResult:
          _handleAgentToolResult(wsMsg.data);
          break;
        case WsEvents.agentDone:
          _handleAgentDone(wsMsg.data);
          break;
        case WsEvents.agentError:
          _handleAgentError(wsMsg.data);
          break;
        case WsEvents.agentCompacted:
          _handleAgentCompacted(wsMsg.data);
          break;
        case WsEvents.agentPermissionRequest:
          _handlePermissionRequest(wsMsg.data);
          break;
        case WsEvents.agentTurnEnd:
          _handleAgentTurnEnd();
          break;
        case WsEvents.agentPlanModeEntered:
          _handlePlanModeEntered(wsMsg.data);
          break;
        case WsEvents.agentPlanModeExited:
          _handlePlanModeExited(wsMsg.data);
          break;
        case WsEvents.streamRetrying:
          _handleRetrying(wsMsg.data);
          break;
        case WsEvents.agentAskUserQuestion:
          _handleAskUserQuestion(wsMsg.data);
          break;

        // -- Command ack --
        case WsEvents.commandAck:
          _handleCommandAck(wsMsg.data);
          break;

        // -- Todo updated --
        case WsEvents.todoUpdated:
          _handleTodoUpdated(wsMsg.data);
          break;

        // -- Permission mode --
        case WsEvents.permissionModeResponse:
          _handlePermissionModeResponse(wsMsg.data);
          break;
      }
    } catch (e) {
      // ignore: avoid_print
      print('[ChatStore] error handling ${wsMsg.event}: $e');
      _notifyListeners();
    }
  }

  // ── stream:agent:text ──────────────────────────────────────────────
  void _handleAgentText(dynamic data) {
    if (_isWrongSession(data)) return;
    final content = _extractContent(data);
    if (_streamingMessage == null) {
      _setWaiting(false);
      _streamingMessage = ChatMessage(
        role: MessageRole.assistant,
        content: content,
        createdAt: DateTime.now(),
        isStreaming: true,
      );
      _isStreaming = true;
    } else {
      _streamingMessage = _streamingMessage!.copyWith(
        content: _streamingMessage!.content + content,
      );
    }
    _notifyListeners();
  }

  // ── stream:agent:tool_call ─────────────────────────────────────────
  void _handleAgentToolCall(dynamic data) {
    if (_isWrongSession(data)) return;
    // Finalize any in-progress streaming text
    _finalizeStreamingMessage();
    _setWaiting(false);

    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final toolCallId = map['toolCallId'] as String? ?? '';
    final toolName = map['toolName'] as String? ?? 'Unknown';
    final input = map['input'] as Map<String, dynamic>?;

    // Build a human-readable input summary
    String? inputSummary;
    if (input != null) {
      inputSummary = _summarizeToolInput(toolName, input);
    }

    final toolMsg = ChatMessage(
      role: MessageRole.tool,
      content: toolName,
      toolName: toolName,
      toolStatus: ToolCallStatus.running,
      toolCallId: toolCallId,
      toolInput: inputSummary,
      createdAt: DateTime.now(),
    );
    _messages.add(toolMsg);
    ChatDatabase.instance.insertMessage(toolMsg);
    _notifyListeners();
  }

  // ── stream:agent:tool_result ───────────────────────────────────────
  void _handleAgentToolResult(dynamic data) {
    if (_isWrongSession(data)) return;
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final toolCallId = map['toolCallId'] as String? ?? '';
    final output = map['output'] as String? ?? '';
    final isError = map['isError'] as bool? ?? false;

    // Find the matching tool message and update it
    for (int i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role == MessageRole.tool &&
          _messages[i].toolCallId == toolCallId) {
        final truncatedOutput =
            output.length > 500 ? '${output.substring(0, 500)}…' : output;
        final summary = _extractResultSummary(
            _messages[i].toolName ?? '', output, isError,);
        _messages[i] = _messages[i].copyWith(
          toolStatus: isError ? ToolCallStatus.error : ToolCallStatus.done,
          toolOutput: truncatedOutput,
          toolResultSummary: summary,
        );
        ChatDatabase.instance.updateMessage(_messages[i]);
        break;
      }
    }
    _notifyListeners();
  }

  // ── stream:agent:done ──────────────────────────────────────────────
  void _handleAgentDone(dynamic data) {
    if (_isWrongSession(data)) return;
    _finalizeStreamingMessage();
    _setWaiting(false);

    // Extract token usage if available
    if (data is Map<String, dynamic>) {
      final usageMap = data['usage'] as Map<String, dynamic>?;
      if (usageMap != null && _messages.isNotEmpty) {
        final usage = TokenUsage(
          inputTokens: (usageMap['inputTokens'] as num?)?.toInt() ?? 0,
          outputTokens: (usageMap['outputTokens'] as num?)?.toInt() ?? 0,
        );
        // Attach usage to the last assistant message
        for (int i = _messages.length - 1; i >= 0; i--) {
          if (_messages[i].role == MessageRole.assistant) {
            _messages[i] = _messages[i].copyWith(usage: usage);
            ChatDatabase.instance.updateMessage(_messages[i]);
            break;
          }
        }
      }
    }

    // Mark any remaining "running" tools as done
    for (int i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role == MessageRole.tool &&
          _messages[i].toolStatus == ToolCallStatus.running) {
        _messages[i] = _messages[i].copyWith(toolStatus: ToolCallStatus.done);
        ChatDatabase.instance.updateMessage(_messages[i]);
      }
    }

    _isStreaming = false;
    _notifyListeners();
  }

  // ── stream:agent:error ─────────────────────────────────────────────
  void _handleAgentError(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final errorText = map['error'] as String? ?? data.toString();
    final recoverable = map['recoverable'] as bool? ?? false;

    _setWaiting(false);

    // Skip recoverable errors silently
    if (recoverable && _streamingMessage == null) return;

    // Dedup: skip identical errors within 5 seconds
    final now = DateTime.now();
    if (_lastErrorText == errorText &&
        _lastErrorTime != null &&
        now.difference(_lastErrorTime!).inSeconds < 5) {
      return;
    }
    _lastErrorText = errorText;
    _lastErrorTime = now;

    if (_streamingMessage != null) {
      final completed = _streamingMessage!.copyWith(
        content: _streamingMessage!.content +
            (errorText.isNotEmpty ? '\n\n⚠ Error: $errorText' : ''),
        isStreaming: false,
      );
      _messages.add(completed);
      ChatDatabase.instance.insertMessage(completed);
      _streamingMessage = null;
    } else {
      // Standalone error — show but don't persist to avoid clutter on restart
      final errorMsg = ChatMessage(
        role: MessageRole.assistant,
        content: '⚠ Error: $errorText',
        createdAt: DateTime.now(),
      );
      _messages.add(errorMsg);
    }
    _isStreaming = false;
    _notifyListeners();
  }

  // ── stream:agent:compacted ─────────────────────────────────────────
  void _handleAgentCompacted(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final before = map['beforeTokens'] as int? ?? 0;
    final after = map['afterTokens'] as int? ?? 0;
    final auto = map['auto'] as bool? ?? false;

    final msg = ChatMessage(
      role: MessageRole.assistant,
      content:
          '🗜 Context compacted: $before → $after tokens${auto ? ' (auto)' : ''}',
      createdAt: DateTime.now(),
    );
    _messages.add(msg);
    ChatDatabase.instance.insertMessage(msg);
    _notifyListeners();
  }

  // ── stream:agent:permission_request ────────────────────────────────
  void _handlePermissionRequest(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final request = PermissionRequest(
      toolCallId: map['toolCallId'] as String? ?? '',
      toolName: map['toolName'] as String? ?? '',
      input: map['input'] as Map<String, dynamic>? ?? {},
    );
    if (!_permissionController.isClosed) {
      _permissionController.add(request);
    }
  }

  // ── stream:agent:thinking ─────────────────────────────────────────
  void _handleAgentThinking(dynamic data) {
    if (_isWrongSession(data)) return;
    final content = data is Map ? data['content'] as String? ?? '' : data?.toString() ?? '';
    if (_thinkingContent.length + content.length > _maxThinkingChars) {
      // 截断：保留后半部分（更新的内容更有价值）
      _thinkingContent = _thinkingContent.substring(_thinkingContent.length ~/ 2);
    }
    _thinkingContent += content;
    _thinkingController.add(_thinkingContent);
  }

  // ── stream:agent:turn_end ─────────────────────────────────────────
  void _handleAgentTurnEnd() {
    _thinkingContent = '';
    _thinkingController.add('');
  }

  /// Send a permission response back to the desktop.
  void respondToPermission(String toolCallId, bool approved) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.permissionResponse,
      data: {'toolCallId': toolCallId, 'approved': approved},
    ),);
    if (!_permissionController.isClosed) {
      _permissionController.add(null); // Clear the request
    }
  }

  // ── stream:agent:plan_mode_entered ────────────────────────────────
  void _handlePlanModeEntered(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    if (!_planModeController.isClosed) {
      _planModeController.add(map);
    }
  }

  // ── stream:agent:plan_mode_exited ─────────────────────────────────
  void _handlePlanModeExited(dynamic data) {
    if (!_planModeController.isClosed) {
      _planModeController.add(null); // null = plan mode ended
    }
  }

  // ── stream:retrying ───────────────────────────────────────────────
  void _handleRetrying(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final attempt = map['attempt'] as int? ?? 1;
    final max = map['maxAttempts'] as int? ?? 3;
    final msg = ChatMessage(
      role: MessageRole.assistant,
      content: '↻ Retrying ($attempt/$max)...',
      createdAt: DateTime.now(),
    );
    _messages.add(msg);
    _notifyListeners();
  }

  /// Send a plan approval/rejection decision back to the desktop.
  void respondToPlan(bool approved) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.planDecision,
      data: {'approved': approved},
    ),);
    if (!_planModeController.isClosed) {
      _planModeController.add(null); // Clear plan mode bar
    }
  }

  // ── stream:agent:ask_user_question ──────────────────────────────────
  void _handleAskUserQuestion(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final options = (map['options'] as List<dynamic>? ?? [])
        .map((o) {
          final m = o is Map<String, dynamic> ? o : <String, dynamic>{};
          return {
            'label': m['label'] as String? ?? '',
            'description': m['description'] as String? ?? '',
          };
        })
        .toList();
    final question = AskUserQuestion(
      questionId: map['questionId'] as String? ?? '',
      question: map['question'] as String? ?? '',
      options: options,
      multiSelect: map['multiSelect'] as bool? ?? false,
    );
    if (!_askUserController.isClosed) {
      _askUserController.add(question);
    }
  }

  /// Send an answer to an AskUserQuestion back to the desktop.
  void respondToAskUser(String questionId, List<String> selectedLabels,
      {String? customText,}) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.askUserAnswer,
      data: {
        'questionId': questionId,
        'selectedLabels': selectedLabels,
        if (customText != null) 'customText': customText,
      },
    ),);
    if (!_askUserController.isClosed) {
      _askUserController.add(null); // Clear the question
    }
  }

  // ── todo:updated ────────────────────────────────────────────────────
  void _handleTodoUpdated(dynamic data) {
    if (data is! Map) return;
    final todosList = data['todos'] as List<dynamic>?;
    if (todosList == null) return;
    _todos = todosList.map((t) {
      final m = t is Map<String, dynamic> ? t : <String, dynamic>{};
      return {
        'content': m['content'] as String? ?? '',
        'status': m['status'] as String? ?? 'pending',
        'activeForm': m['activeForm'] as String? ?? '',
      };
    }).toList();
    _notifyListeners();
  }

  // ── permission:mode:response ───────────────────────────────────────
  void _handlePermissionModeResponse(dynamic data) {
    if (data is! Map) return;
    final mode = data['mode'] as String? ?? 'always-ask';
    _permissionMode = mode;
    _notifyListeners();
  }

  /// Request current permission mode from desktop.
  void requestPermissionMode() {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.permissionGetModeRequest,
      data: {'requestId': '${DateTime.now().millisecondsSinceEpoch}'},
    ));
  }

  /// Set permission mode on desktop.
  void setPermissionMode(String mode) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.permissionSetModeRequest,
      data: {
        'requestId': '${DateTime.now().millisecondsSinceEpoch}',
        'mode': mode,
      },
    ));
    _permissionMode = mode;
    _notifyListeners();
  }

  // ── command:ack ────────────────────────────────────────────────────
  void _handleCommandAck(dynamic data) {
    if (data is! Map) return;
    final messageId = data['messageId'] as String?;
    if (messageId == null) return;
    // Remove from pending — ack received means desktop got our message.
    _pendingMessageIds.remove(messageId);
  }

  // ── Public API ─────────────────────────────────────────────────────

  /// Switch to a specific session (for browsing history).
  /// Pass null to return to the live/default chat.
  Future<void> switchToSession(String? sessionId) async {
    if (sessionId == _currentSessionId) return;

    // Finalize any in-progress streaming before switching
    if (_isStreaming && sessionId != _currentSessionId) {
      _finalizeStreamingMessage();
    }

    _currentSessionId = sessionId;
    _messages.clear();
    _streamingMessage = null;

    if (sessionId != null) {
      _isBrowsingHistory = true;
      final messages = await ChatDatabase.instance.getSessionMessages(
        sessionId,
        limit: 100,
      );
      _messages.addAll(messages);
    } else {
      _isBrowsingHistory = false;
      _messages.addAll(await ChatDatabase.instance.getMessages(limit: 100));
    }
    _notifyListeners();
  }

  /// Load messages fetched from desktop into the current view.
  /// 当传入空列表（清空操作）时递增 _clearGeneration，用于检测后续覆盖。
  /// 当传入非空列表时，如果用户在清空后已发过消息（_lastUserMsgGen > _clearGeneration），
  /// 则跳过覆盖以保护用户输入不被丢弃。
  void loadFetchedMessages(List<ChatMessage> messages) {
    if (messages.isEmpty) {
      _clearGeneration++;
      _messages.clear();
      _notifyListeners();
      return;
    }
    // 用户在清空后已发过消息 → 不覆盖
    if (_lastUserMsgGen > _clearGeneration) return;
    _messages.clear();
    _messages.addAll(messages);
    _notifyListeners();
  }

  Future<void> sendMessage(String text) async {
    // If browsing history, switch back to live mode
    if (_isBrowsingHistory) {
      _isBrowsingHistory = false;
    }

    // 记录用户发消息时的 generation，防止后续 fetch 响应覆盖
    _lastUserMsgGen = _clearGeneration;

    final messageId = '${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(1000000)}';
    final msg = ChatMessage(
      role: MessageRole.user,
      content: text,
      createdAt: DateTime.now(),
    );
    _messages.add(msg);
    await ChatDatabase.instance.insertMessage(msg, sessionId: _currentSessionId);
    _pendingMessageIds[messageId] = true;
    // 防止累积：超过 100 条时清理最老的未确认条目
    if (_pendingMessageIds.length > 100) {
      _pendingMessageIds.remove(_pendingMessageIds.keys.first);
    }
    ConnectionManager.instance.send(
      WsMessage(event: WsEvents.commandSend, data: {
        'content': text,
        'messageId': messageId,
        if (_currentSessionId != null) 'sessionId': _currentSessionId,
        if (TaskService.instance.activeTaskId != null)
          'activeTaskId': TaskService.instance.activeTaskId,
      },),
      priority: 10,
    );
    _setWaiting(true);
    _notifyListeners();
  }

  void stopGeneration() {
    ConnectionManager.instance.send(const WsMessage(event: WsEvents.commandStop));
    _finalizeStreamingMessage();
    _isStreaming = false;
    _setWaiting(false);
    _notifyListeners();
  }

  Future<void> clearSession() async {
    await ChatDatabase.instance.clearAll();
    _messages.clear();
    _streamingMessage = null;
    _isStreaming = false;
    _notifyListeners();
  }

  Future<void> loadHistory() async {
    _messages.clear();
    _messages.addAll(await ChatDatabase.instance.getMessages(limit: 100));
    _cleanupStaleTools();
    _notifyListeners();
  }

  Future<void> loadMoreMessages() async {
    List<ChatMessage> older;
    if (_currentSessionId != null) {
      older = await ChatDatabase.instance.getSessionMessages(
        _currentSessionId!,
        limit: 100,
        offset: _messages.length,
      );
    } else {
      older = await ChatDatabase.instance.getMessages(
        limit: 100,
        offset: _messages.length,
      );
    }
    if (older.isEmpty) return;
    _messages.insertAll(0, older);
    _notifyListeners();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  void _setWaiting(bool value) {
    if (_isWaitingForResponse == value) return;
    _isWaitingForResponse = value;
    if (!_waitingController.isClosed) {
      _waitingController.add(value);
    }
  }

  /// Extract a short one-line summary from tool output for collapsed display.
  String? _extractResultSummary(String toolName, String output, bool isError) {
    if (output.isEmpty) return null;
    if (isError) {
      // First line of error, truncated
      final firstLine = output.split('\n').first.trim();
      return firstLine.length > 60 ? '${firstLine.substring(0, 57)}...' : firstLine;
    }
    switch (toolName) {
      case 'Read':
      case 'file-read':
        final lines = '\n'.allMatches(output).length + 1;
        return '$lines lines';
      case 'Bash':
        // Show exit status or first meaningful line
        final trimmed = output.trim();
        if (trimmed.isEmpty) return 'done';
        final firstLine = trimmed.split('\n').first.trim();
        return firstLine.length > 50 ? '${firstLine.substring(0, 47)}...' : firstLine;
      case 'Grep':
        final matches = '\n'.allMatches(output).length + 1;
        return '$matches matches';
      case 'Glob':
        final files = '\n'.allMatches(output).length + 1;
        return '$files files';
      case 'Write':
      case 'file-write':
        return 'written';
      case 'Edit':
      case 'file-edit':
        return 'applied';
      case 'WebSearch':
      case 'web-search':
        final results = '\n'.allMatches(output).length + 1;
        return '$results results';
      default:
        final firstLine = output.split('\n').first.trim();
        if (firstLine.isEmpty) return null;
        return firstLine.length > 50 ? '${firstLine.substring(0, 47)}...' : firstLine;
    }
  }

  /// Mark any tool messages stuck in "running" for > 2 minutes as done.
  /// Called on app startup / history load to clean up missed tool_result events.
  void _cleanupStaleTools() {
    final now = DateTime.now();
    for (int i = 0; i < _messages.length; i++) {
      if (_messages[i].role == MessageRole.tool &&
          _messages[i].toolStatus == ToolCallStatus.running &&
          now.difference(_messages[i].createdAt).inSeconds > 120) {
        _messages[i] = _messages[i].copyWith(toolStatus: ToolCallStatus.done);
        ChatDatabase.instance.updateMessage(_messages[i]);
      }
    }
  }

  void _finalizeStreamingMessage() {
    if (_streamingMessage != null) {
      final completed = _streamingMessage!.copyWith(isStreaming: false);
      _messages.add(completed);
      ChatDatabase.instance.insertMessage(completed);
      _streamingMessage = null;
    }
  }

  String _extractContent(dynamic data) {
    if (data is Map) return data['content'] as String? ?? '';
    return data?.toString() ?? '';
  }

  /// 串台防护：若事件携带的 sessionId 与当前会话不匹配，返回 true 并应丢弃该事件。
  /// 若事件无 sessionId（老台面版本）或当前未加载会话，不拦截。
  bool _isWrongSession(dynamic data) {
    if (data is! Map) return false;
    final incoming = data['sessionId'] as String?;
    if (incoming == null || _currentSessionId == null) return false;
    return incoming != _currentSessionId;
  }

  /// Build a human-readable one-line summary of tool input.
  String _summarizeToolInput(String toolName, Map<String, dynamic> input) {
    switch (toolName) {
      case 'Bash':
        return input['command'] as String? ?? '';
      case 'Read':
      case 'file-read':
        return input['file_path'] as String? ?? input['filePath'] as String? ?? '';
      case 'Write':
      case 'file-write':
        final path = input['file_path'] as String? ?? input['filePath'] as String? ?? '';
        return path;
      case 'Edit':
      case 'file-edit':
        return input['file_path'] as String? ?? input['filePath'] as String? ?? '';
      case 'Glob':
        return input['pattern'] as String? ?? '';
      case 'Grep':
        return input['pattern'] as String? ?? '';
      case 'WebSearch':
      case 'web-search':
        return input['query'] as String? ?? '';
      case 'WebFetch':
      case 'web-fetch':
        return input['url'] as String? ?? '';
      default:
        // Generic: show first string value
        for (final v in input.values) {
          if (v is String && v.isNotEmpty) {
            return v.length > 100 ? '${v.substring(0, 100)}…' : v;
          }
        }
        return jsonEncode(input).length > 100
            ? '${jsonEncode(input).substring(0, 100)}…'
            : jsonEncode(input);
    }
  }

  void _notifyListeners() {
    if (!_messagesController.isClosed) {
      _messagesController.add(displayMessages);
    }
    if (!_streamingController.isClosed) {
      _streamingController.add(_isStreaming);
    }
  }

  void dispose() {
    _wsSubscription?.cancel();
    _messagesController.close();
    _streamingController.close();
    _permissionController.close();
    _waitingController.close();
    _planModeController.close();
    _askUserController.close();
  }
}
