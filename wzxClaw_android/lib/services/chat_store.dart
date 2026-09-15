import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/chat_message.dart';
import '../models/connection_state.dart';
import '../models/session_task_state.dart';
import '../models/ws_message.dart';
import 'app_restore_state.dart';
import 'chat_database.dart';
import 'connection_manager.dart';
import 'ws_transport.dart';

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
  static ChatStore _instance = ChatStore._();
  static ChatStore get instance => _instance;
  ChatStore._({WsTransport? transport})
      : _transport = transport ?? ConnectionManager.instance {
    _init();
  }

  /// 仅测试使用：创建一个独立的 ChatStore 实例，不使用全局单例。
  @visibleForTesting
  factory ChatStore.forTest({required WsTransport transport}) =>
      ChatStore._(transport: transport);

  /// 仅测试使用：替换全局单例，让其它组件（如 SessionSyncService）通过
  /// `ChatStore.instance` 看到注入版本。
  @visibleForTesting
  static void setInstanceForTest(ChatStore store) {
    _instance = store;
  }

  /// 仅测试使用：恢复默认单例。
  @visibleForTesting
  static void resetInstanceForTest() {
    _instance = ChatStore._();
  }

  final WsTransport _transport;

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
  final Map<String, _LiveSessionState> _liveSessions = {};
  final Map<String, SessionTaskState> _taskStates = {};

  // Cached display list — rebuilt only when _messages or _streamingMessage changes.
  List<ChatMessage> _cachedDisplayMessages = const [];
  int _cachedMessagesLength = -1;
  StreamSubscription<WsMessage>? _wsSubscription;
  String? _currentSessionId;
  bool _isBrowsingHistory = false; // true when viewing a historical session
  bool _isWaitingForResponse = false;
  String? _lastErrorText;
  DateTime? _lastErrorTime;
  final Map<String, bool> _pendingMessageIds = {}; // messageId tracking for ack

  // -- Clear guard: 防止 fetchSessions 延迟响应覆盖用户消息 --
  int _clearGeneration = 0; // 每次 loadFetchedMessages([]) 清空时递增
  int _lastUserMsgGen = 0; // 用户最后发消息时的 generation

  // -- 用户主动切换追踪 --
  bool _userManuallySwitched = false; // 只有用户从 UI 主动点会话时为 true

  // -- Streaming text throttle --
  final StringBuffer _textBuffer = StringBuffer();
  Timer? _textFlushTimer;
  static const _textFlushInterval = Duration(milliseconds: 60); // ~16 FPS

  // -- Session loading state (切换会话时的加载占位) --
  bool _isSessionLoading = false;
  bool get isSessionLoading => _isSessionLoading;
  final _sessionLoadingController = StreamController<bool>.broadcast();
  Stream<bool> get sessionLoadingStream => _sessionLoadingController.stream;

  void _setSessionLoading(bool loading) {
    if (_isSessionLoading == loading) return;
    _isSessionLoading = loading;
    if (!_sessionLoadingController.isClosed) {
      _sessionLoadingController.add(loading);
    }
  }

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
  SessionTaskState? get currentTaskState =>
      _currentSessionId == null ? null : _taskStates[_currentSessionId];
  String? get currentSessionId => _currentSessionId;
  set currentSessionId(String? id) => _currentSessionId = id;
  bool get isBrowsingHistory => _isBrowsingHistory;
  bool get userManuallySwitched => _userManuallySwitched;

  List<ChatMessage> get messages =>
      List.unmodifiable(_messages.where((m) => !m.isSystemInjected));

  List<ChatMessage> get displayMessages {
    final hasStreaming = _streamingMessage != null;
    final msgLen = _messages.length;
    // 流式期间跳过缓存：_streamingMessage 的内容在变但 _messages.length 不变，
    // 原缓存逻辑只看 length 和 null 状态，导致流式时永远命中旧缓存。
    if (!hasStreaming && msgLen == _cachedMessagesLength) {
      return _cachedDisplayMessages;
    }
    _cachedMessagesLength = msgLen;
    if (hasStreaming) {
      _cachedDisplayMessages = [
        ..._messages.where((m) => !m.isSystemInjected),
        if (!_streamingMessage!.isSystemInjected) _streamingMessage!,
      ];
    } else {
      _cachedDisplayMessages = List.unmodifiable(
        _messages.where((m) => !m.isSystemInjected),
      );
    }
    return _cachedDisplayMessages;
  }

  void _init() {
    _wsSubscription = _transport.incoming.listen(_handleWsMessage);
    _transport.stateStream.listen(_handleConnectionState);
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
          _handleAgentTurnEnd(wsMsg.data);
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
        case WsEvents.agentRunning:
          _handleAgentRunning(wsMsg.data);
          break;
        case WsEvents.sessionTaskStatus:
          _handleSessionTaskStatus(wsMsg.data);
          break;
        case WsEvents.desktopUserMessage:
          _handleDesktopUserMessage(wsMsg.data);
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
  // 节流：text chunk 先写入 buffer，由定时器统一刷到 UI（~16 FPS），
  // 避免每个 token 都触发 setState + ListView rebuild。
  void _handleAgentText(dynamic data) {
    final content = _extractContent(data);
    if (content.isEmpty) return;
    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      _handleInactiveAgentText(inactiveSessionId, content);
      return;
    }

    if (_streamingMessage == null) {
      _setWaiting(false);
      _streamingMessage = ChatMessage(
        role: MessageRole.assistant,
        content: content,
        createdAt: DateTime.now(),
        isStreaming: true,
      );
      _isStreaming = true;
      _notifyListeners();
    } else {
      // 累积到 buffer，延迟刷新
      _textBuffer.write(content);
      _textFlushTimer ??= Timer(_textFlushInterval, _flushTextBuffer);
    }
  }

  /// 将 buffer 中的累积文本一次性刷到 _streamingMessage 并通知 UI
  void _flushTextBuffer() {
    _textFlushTimer = null;
    if (_textBuffer.isEmpty || _streamingMessage == null) return;
    final buffered = _textBuffer.toString();
    _textBuffer.clear();
    _streamingMessage = _streamingMessage!.copyWith(
      content: _streamingMessage!.content + buffered,
    );
    _notifyListeners();
  }

  // ── stream:agent:tool_call ─────────────────────────────────────────
  void _handleAgentToolCall(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final toolCallId = map['toolCallId'] as String? ?? '';
    final toolName = map['toolName'] as String? ?? 'Unknown';
    final input = map['input'] as Map<String, dynamic>?;

    // Build a human-readable input summary
    String? inputSummary;
    if (input != null) {
      inputSummary = _summarizeToolInput(toolName, input);
    }

    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      _finalizeInactiveStreamingMessage(inactiveSessionId);
      _liveStateFor(inactiveSessionId).messages.add(ChatMessage(
            role: MessageRole.tool,
            content: toolName,
            toolName: toolName,
            toolStatus: ToolCallStatus.running,
            toolCallId: toolCallId,
            toolInput: inputSummary,
            createdAt: DateTime.now(),
          ));
      return;
    }

    // Finalize any in-progress streaming text
    _finalizeStreamingMessage();
    _setWaiting(false);

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
    ChatDatabase.instance.insertMessage(
      toolMsg,
      sessionId: _currentSessionId,
      desktopId: _transport.selectedDesktopId,
    );
    _notifyListeners();
  }

  // ── stream:agent:tool_result ───────────────────────────────────────
  void _handleAgentToolResult(dynamic data) {
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final toolCallId = map['toolCallId'] as String? ?? '';
    final output = map['output'] as String? ?? '';
    final isError = map['isError'] as bool? ?? false;

    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      _updateInactiveToolResult(inactiveSessionId, toolCallId, output, isError);
      return;
    }

    // Find the matching tool message and update it
    for (int i = _messages.length - 1; i >= 0; i--) {
      if (_messages[i].role == MessageRole.tool &&
          _messages[i].toolCallId == toolCallId) {
        final truncatedOutput =
            output.length > 500 ? '${output.substring(0, 500)}…' : output;
        final summary = _extractResultSummary(
          _messages[i].toolName ?? '',
          output,
          isError,
        );
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

  // ── stream:agent:running ──────────────────────────────────────────
  // 桌面端 agent 正在运行时，手机重连后收到此通知。
  // 仅同步 streaming 状态，分页重载历史由 SessionSyncService 监听同事件触发。
  void _handleAgentRunning(dynamic data) {
    if (data is! Map<String, dynamic>) return;
    final sessionId = data['sessionId'] as String?;
    if (sessionId == null) return;
    // 串台防护：仅在用户未主动切换到其他会话时才同步 _currentSessionId。
    // 若强制覆盖，后续属于桌面会话 A 的流式事件会通过 _isWrongSession 检查，
    // 错误地被追加到手机正在显示的会话 B 的消息列表中。
    if (!_userManuallySwitched) {
      _currentSessionId = sessionId;
    }
    // 仅在事件属于当前会话时才更新 _isStreaming。
    // 若来自后台会话 B（用户正在看 A），_isStreaming 不应被污染，
    // 否则会话 A 的界面会错误地显示 loading spinner。
    if (sessionId == _currentSessionId) {
      _isStreaming = true;
      _streamingController.add(true);
    } else {
      // 后台会话：仅更新 liveState，不影响当前页面
      _liveStateFor(sessionId).isStreaming = true;
      _liveStateFor(sessionId).isWaiting = false;
    }
  }

  // ── session:task_status ───────────────────────────────────────────
  void _handleSessionTaskStatus(dynamic data) {
    if (data is! Map) return;
    final state = SessionTaskState.fromJson(Map<String, dynamic>.from(data));
    if (state.sessionId.isEmpty) return;
    _taskStates[state.sessionId] = state;

    if (state.sessionId == _currentSessionId) {
      final active = state.isActive;
      _isStreaming = active;
      _streamingController.add(active);
      _setWaiting(state.status == 'starting');
      if (state.isTerminal) {
        _finalizeStreamingMessage();
        _setWaiting(false);
      }
    }
    _notifyListeners();
  }

  // ── stream:desktop_user_message ───────────────────────────────────
  /// 桌面端用户发送的提问，手机端以用户气泡展示
  void _handleDesktopUserMessage(dynamic data) {
    if (data is! Map<String, dynamic>) return;
    final content = data['content'] as String?;
    if (content == null || content.isEmpty) return;
    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      final state = _liveStateFor(inactiveSessionId);
      if (state.messages.isNotEmpty &&
          state.messages.last.role == MessageRole.user &&
          state.messages.last.content == content) {
        return;
      }
      state.messages.add(ChatMessage(
        role: MessageRole.user,
        content: content,
        createdAt: DateTime.now(),
      ));
      state.isWaiting = true;
      return;
    }
    // 若最后一条消息已经是相同内容的用户气泡（手机会话加载时可能已存在），则跳过
    if (_messages.isNotEmpty &&
        _messages.last.role == MessageRole.user &&
        _messages.last.content == content) return;
    final msg = ChatMessage(
      role: MessageRole.user,
      content: content,
      createdAt: DateTime.now(),
    );
    _messages.add(msg);
    _setWaiting(true);
    _notifyListeners();
  }

  // ── stream:agent:done ──────────────────────────────────────────────
  void _handleAgentDone(dynamic data) {
    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      _finalizeInactiveStreamingMessage(inactiveSessionId);
      final state = _liveStateFor(inactiveSessionId);
      state.isStreaming = false;
      state.isWaiting = false;
      _markInactiveToolsDone(inactiveSessionId);
      return;
    }
    _finalizeStreamingMessage();
    _setWaiting(false);

    // Extract token usage and model name if available
    if (data is Map<String, dynamic>) {
      final usageMap = data['usage'] as Map<String, dynamic>?;
      final modelName = data['model'] as String?;
      if ((usageMap != null || modelName != null) && _messages.isNotEmpty) {
        TokenUsage? usage;
        if (usageMap != null) {
          usage = TokenUsage(
            inputTokens: (usageMap['inputTokens'] as num?)?.toInt() ?? 0,
            outputTokens: (usageMap['outputTokens'] as num?)?.toInt() ?? 0,
          );
        }
        // Attach usage + model to the last assistant message
        for (int i = _messages.length - 1; i >= 0; i--) {
          if (_messages[i].role == MessageRole.assistant) {
            _messages[i] = _messages[i].copyWith(
              usage: usage,
              model: modelName,
            );
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

    final inactiveSessionId = _inactiveSessionId(data);
    if (inactiveSessionId != null) {
      _handleInactiveAgentError(inactiveSessionId, errorText, recoverable);
      return;
    }

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
      ChatDatabase.instance.insertMessage(
        completed,
        sessionId: _currentSessionId,
        desktopId: _transport.selectedDesktopId,
      );
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
    if (_isWrongSession(data)) return;
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
    ChatDatabase.instance.insertMessage(
      msg,
      sessionId: _currentSessionId,
      desktopId: _transport.selectedDesktopId,
    );
    _notifyListeners();
  }

  // ── stream:agent:permission_request ────────────────────────────────
  void _handlePermissionRequest(dynamic data) {
    if (_isWrongSession(data)) return;
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
    final content =
        data is Map ? data['content'] as String? ?? '' : data?.toString() ?? '';
    if (_thinkingContent.length + content.length > _maxThinkingChars) {
      // 截断：保留后半部分（更新的内容更有价值）
      _thinkingContent =
          _thinkingContent.substring(_thinkingContent.length ~/ 2);
    }
    _thinkingContent += content;
    _thinkingController.add(_thinkingContent);
  }

  // ── stream:agent:turn_end ─────────────────────────────────────────
  void _handleAgentTurnEnd([dynamic data]) {
    if (data != null && _isWrongSession(data)) return;
    _thinkingContent = '';
    _thinkingController.add('');
  }

  /// 轻量级同步 sessionId（不重置消息列表），用于 session:active 事件。
  void syncSessionId(String? sessionId) {
    _currentSessionId = sessionId;
  }

  /// Send a permission response back to the desktop.
  void respondToPermission(String toolCallId, bool approved) {
    _transport.send(
      WsMessage(
        event: WsEvents.permissionResponse,
        data: {'toolCallId': toolCallId, 'approved': approved},
      ),
    );
    if (!_permissionController.isClosed) {
      _permissionController.add(null); // Clear the request
    }
  }

  // ── stream:agent:plan_mode_entered ────────────────────────────────
  void _handlePlanModeEntered(dynamic data) {
    if (_isWrongSession(data)) return;
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    if (!_planModeController.isClosed) {
      _planModeController.add(map);
    }
  }

  // ── stream:agent:plan_mode_exited ─────────────────────────────────
  void _handlePlanModeExited(dynamic data) {
    if (_isWrongSession(data)) return;
    if (!_planModeController.isClosed) {
      _planModeController.add(null); // null = plan mode ended
    }
  }

  // ── stream:retrying ───────────────────────────────────────────────
  void _handleRetrying(dynamic data) {
    if (_isWrongSession(data)) return;
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
    _transport.send(
      WsMessage(
        event: WsEvents.planDecision,
        data: {'approved': approved},
      ),
    );
    if (!_planModeController.isClosed) {
      _planModeController.add(null); // Clear plan mode bar
    }
  }

  // ── stream:agent:ask_user_question ──────────────────────────────────
  void _handleAskUserQuestion(dynamic data) {
    if (_isWrongSession(data)) return;
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    final options = (map['options'] as List<dynamic>? ?? []).map((o) {
      final m = o is Map<String, dynamic> ? o : <String, dynamic>{};
      return {
        'label': m['label'] as String? ?? '',
        'description': m['description'] as String? ?? '',
      };
    }).toList();
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
  void respondToAskUser(
    String questionId,
    List<String> selectedLabels, {
    String? customText,
  }) {
    _transport.send(
      WsMessage(
        event: WsEvents.askUserAnswer,
        data: {
          'questionId': questionId,
          'selectedLabels': selectedLabels,
          if (customText != null) 'customText': customText,
        },
      ),
    );
    if (!_askUserController.isClosed) {
      _askUserController.add(null); // Clear the question
    }
  }

  // ── todo:updated ────────────────────────────────────────────────────
  void _handleTodoUpdated(dynamic data) {
    if (_isWrongSession(data)) return;
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
    _transport.send(WsMessage(
      event: WsEvents.permissionGetModeRequest,
      data: {'requestId': '${DateTime.now().millisecondsSinceEpoch}'},
    ));
  }

  /// Set permission mode on desktop.
  void setPermissionMode(String mode) {
    _transport.send(WsMessage(
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
  /// [userInitiated]: true 当且仅当用户从 UI 主动点击了会话，false 表示系统自动切换。
  Future<void> switchToSession(String? sessionId,
      {bool userInitiated = false}) async {
    // 用户主动切换时立即更新标志（即使 same-session 提前返回也需生效）
    if (userInitiated) _userManuallySwitched = true;

    if (sessionId == _currentSessionId) return;

    // 切走运行中的会话时不要落库未完成 assistant；先暂存，之后切回来继续显示。
    if (_isStreaming) {
      _stashCurrentStreamingState();
    }

    // 系统切换时重置手动标志
    if (!userInitiated) _userManuallySwitched = false;

    // 完整重置所有流式和会话级状态（与 resetSessionScope 对齐）
    _isStreaming = false;
    _setWaiting(false);
    _streamingMessage = null;
    _thinkingContent = '';
    _todos = [];
    _pendingMessageIds.clear();
    if (!_permissionController.isClosed) {
      _permissionController.add(null);
    }
    if (!_planModeController.isClosed) {
      _planModeController.add(null);
    }
    if (!_askUserController.isClosed) {
      _askUserController.add(null);
    }
    _thinkingController.add('');

    _currentSessionId = sessionId;
    _messages.clear();
    _persistSessionView(sessionId);

    // 用户主动切换时，不从本地缓存加载——调用方会通过 loadFetchedMessages
    // 注入从桌面拉取的最新数据，避免先显示旧缓存再闪烁刷新。
    if (userInitiated && sessionId != null) {
      _setSessionLoading(true); // 显示加载占位，直到 loadFetchedMessages 回填
      _isBrowsingHistory = true;
      _restoreLiveSessionState(sessionId);
      _notifyListeners();
    } else if (sessionId != null) {
      _isBrowsingHistory = true;
      final messages = await ChatDatabase.instance.getSessionMessages(
        sessionId,
        limit: 100,
      );
      _messages.addAll(messages.where((m) => !m.isSystemInjected));
      _restoreLiveSessionState(sessionId);
      _notifyListeners();
    } else {
      _isBrowsingHistory = false;
      final messages = await ChatDatabase.instance.getMessages(
        desktopId: _transport.selectedDesktopId,
        limit: 100,
      );
      _messages.addAll(messages.where((m) => !m.isSystemInjected));
    }
    _notifyListeners();
  }

  /// Load messages fetched from desktop into the current view.
  /// 当传入空列表（清空操作）时递增 _clearGeneration，用于检测后续覆盖。
  /// 当传入非空列表时，如果用户在清空后已发过消息（_lastUserMsgGen > _clearGeneration），
  /// 则跳过覆盖以保护用户输入不被丢弃。
  ///
  /// [sessionId] 用于丢弃过期响应：用户快速切换会话时，
  /// 旧请求的响应如果 sessionId 不匹配当前会话，直接忽略。
  void loadFetchedMessages(String sessionId, List<ChatMessage> messages) {
    // 丢弃过期响应：用户已切换到其他会话
    if (sessionId != _currentSessionId) return;
    if (messages.isEmpty) {
      _clearGeneration++;
      _messages.clear();
      _setSessionLoading(false); // 空会话也要关闭 loading
      _notifyListeners();
      return;
    }
    // 用户在清空后已发过消息 → 不覆盖
    if (_lastUserMsgGen > _clearGeneration) return;
    final visibleMessages =
        messages.where((m) => !m.isSystemInjected).toList(growable: false);
    _messages.clear();
    _messages.addAll(visibleMessages);
    _restoreLiveSessionState(sessionId);
    _setSessionLoading(false); // 数据已到，关闭加载状态
    _notifyListeners();
  }

  /// Reset desktop-scoped chat state when the selected desktop/workspace is cleared.
  void resetSessionScope() {
    _clearGeneration++;
    _currentSessionId = null;
    _isBrowsingHistory = false;
    _setWaiting(false);
    _isStreaming = false;
    _streamingMessage = null;
    _liveSessions.clear();
    _thinkingContent = '';
    _todos = [];
    _pendingMessageIds.clear();
    _userManuallySwitched = false;
    _messages.clear();
    if (!_permissionController.isClosed) {
      _permissionController.add(null);
    }
    if (!_planModeController.isClosed) {
      _planModeController.add(null);
    }
    if (!_askUserController.isClosed) {
      _askUserController.add(null);
    }
    _thinkingController.add('');
    _notifyListeners();
  }

  Future<void> sendMessage(String text) async {
    // If browsing history, switch back to live mode
    if (_isBrowsingHistory) {
      _isBrowsingHistory = false;
    }

    // 记录用户发消息时的 generation，防止后续 fetch 响应覆盖
    // +1 确保 > 判断真正生效（= 永远不大于自身）
    _lastUserMsgGen = _clearGeneration + 1;
    _userManuallySwitched = false; // 发消息 = 回到实时模式，允许系统跟随桌面

    final messageId =
        '${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(1000000)}';
    final msg = ChatMessage(
      role: MessageRole.user,
      content: text,
      createdAt: DateTime.now(),
    );
    _messages.add(msg);
    await ChatDatabase.instance.insertMessage(
      msg,
      sessionId: _currentSessionId,
      desktopId: _transport.selectedDesktopId,
    );
    _pendingMessageIds[messageId] = true;
    // 防止累积：超过 100 条时清理最老的未确认条目
    if (_pendingMessageIds.length > 100) {
      _pendingMessageIds.remove(_pendingMessageIds.keys.first);
    }
    _transport.send(
      WsMessage(
        event: WsEvents.commandSend,
        data: {
          'content': text,
          'messageId': messageId,
          if (_currentSessionId != null) 'sessionId': _currentSessionId,
        },
      ),
      priority: 10,
    );
    _setWaiting(true);
    _notifyListeners();
  }

  void stopGeneration() {
    _transport.send(WsMessage(
      event: WsEvents.commandStop,
      data: {if (_currentSessionId != null) 'sessionId': _currentSessionId},
    ));
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
    _liveSessions.clear();
    _notifyListeners();
  }

  /// 清空当前会话的消息（仅本地，桌面端由 WS 事件单独通知）
  Future<void> clearCurrentSessionMessages() async {
    if (_currentSessionId != null) {
      await ChatDatabase.instance.clearSessionMessages(_currentSessionId!);
    }
    _messages.clear();
    _streamingMessage = null;
    _isStreaming = false;
    if (_currentSessionId != null) {
      _liveSessions.remove(_currentSessionId);
    }
    _notifyListeners();
  }

  Future<void> loadHistory() async {
    _messages.clear();
    final messages = await ChatDatabase.instance.getMessages(
      desktopId: _transport.selectedDesktopId,
      limit: 100,
    );
    _messages.addAll(messages.where((m) => !m.isSystemInjected));
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
        desktopId: _transport.selectedDesktopId,
        limit: 100,
        offset: _messages.length,
      );
    }
    if (older.isEmpty) return;
    _messages.insertAll(0, older.where((m) => !m.isSystemInjected));
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
      return firstLine.length > 60
          ? '${firstLine.substring(0, 57)}...'
          : firstLine;
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
        return firstLine.length > 50
            ? '${firstLine.substring(0, 47)}...'
            : firstLine;
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
        return firstLine.length > 50
            ? '${firstLine.substring(0, 47)}...'
            : firstLine;
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
    // 先刷完 buffer 中残留的文本
    _textFlushTimer?.cancel();
    _textFlushTimer = null;
    if (_textBuffer.isNotEmpty && _streamingMessage != null) {
      _streamingMessage = _streamingMessage!.copyWith(
        content: _streamingMessage!.content + _textBuffer.toString(),
      );
      _textBuffer.clear();
    }
    if (_streamingMessage != null) {
      final completed = _streamingMessage!.copyWith(isStreaming: false);
      _messages.add(completed);
      ChatDatabase.instance.insertMessage(
        completed,
        sessionId: _currentSessionId,
        desktopId: _transport.selectedDesktopId,
      );
      _streamingMessage = null;
    }
  }

  _LiveSessionState _liveStateFor(String sessionId) =>
      _liveSessions.putIfAbsent(sessionId, _LiveSessionState.new);

  void _handleInactiveAgentText(String sessionId, String content) {
    final state = _liveStateFor(sessionId);
    if (state.streamingMessage == null) {
      state.streamingMessage = ChatMessage(
        role: MessageRole.assistant,
        content: content,
        createdAt: DateTime.now(),
        isStreaming: true,
      );
    } else {
      state.streamingMessage = state.streamingMessage!.copyWith(
        content: state.streamingMessage!.content + content,
      );
    }
    state.isStreaming = true;
    state.isWaiting = false;
  }

  void _finalizeInactiveStreamingMessage(String sessionId) {
    final state = _liveSessions[sessionId];
    if (state?.streamingMessage == null) return;
    state!.messages.add(state.streamingMessage!.copyWith(isStreaming: false));
    state.streamingMessage = null;
  }

  void _updateInactiveToolResult(
    String sessionId,
    String toolCallId,
    String output,
    bool isError,
  ) {
    final state = _liveStateFor(sessionId);
    for (int i = state.messages.length - 1; i >= 0; i--) {
      final message = state.messages[i];
      if (message.role == MessageRole.tool && message.toolCallId == toolCallId) {
        final truncatedOutput =
            output.length > 500 ? '${output.substring(0, 500)}…' : output;
        state.messages[i] = message.copyWith(
          toolStatus: isError ? ToolCallStatus.error : ToolCallStatus.done,
          toolOutput: truncatedOutput,
          toolResultSummary:
              _extractResultSummary(message.toolName ?? '', output, isError),
        );
        break;
      }
    }
  }

  void _markInactiveToolsDone(String sessionId) {
    final state = _liveSessions[sessionId];
    if (state == null) return;
    for (int i = 0; i < state.messages.length; i++) {
      if (state.messages[i].role == MessageRole.tool &&
          state.messages[i].toolStatus == ToolCallStatus.running) {
        state.messages[i] =
            state.messages[i].copyWith(toolStatus: ToolCallStatus.done);
      }
    }
  }

  void _handleInactiveAgentError(
    String sessionId,
    String errorText,
    bool recoverable,
  ) {
    final state = _liveSessions[sessionId];
    if (recoverable && state?.streamingMessage == null) return;
    if (state?.streamingMessage != null) {
      state!.messages.add(state.streamingMessage!.copyWith(
        content: state.streamingMessage!.content +
            (errorText.isNotEmpty ? '\n\n⚠ Error: $errorText' : ''),
        isStreaming: false,
      ));
      state.streamingMessage = null;
    } else {
      _liveStateFor(sessionId).messages.add(ChatMessage(
        role: MessageRole.assistant,
        content: '⚠ Error: $errorText',
        createdAt: DateTime.now(),
      ));
    }
    _liveStateFor(sessionId).isStreaming = false;
    _liveStateFor(sessionId).isWaiting = false;
  }

  void _stashCurrentStreamingState() {
    _textFlushTimer?.cancel();
    _textFlushTimer = null;
    if (_textBuffer.isNotEmpty && _streamingMessage != null) {
      _streamingMessage = _streamingMessage!.copyWith(
        content: _streamingMessage!.content + _textBuffer.toString(),
      );
      _textBuffer.clear();
    }
    if (_currentSessionId == null || _streamingMessage == null) {
      _finalizeStreamingMessage();
      return;
    }
    final state = _liveStateFor(_currentSessionId!);
    state.streamingMessage = _streamingMessage;
    state.isStreaming = true;
    state.isWaiting = _isWaitingForResponse;
    _streamingMessage = null;
  }

  void _restoreLiveSessionState(String sessionId) {
    final state = _liveSessions.remove(sessionId);
    if (state == null) return;
    for (final message in state.messages) {
      if (!_hasEquivalentMessage(message)) {
        _messages.add(message);
      }
    }
    if (state.streamingMessage != null) {
      _streamingMessage = state.streamingMessage;
    }
    _isStreaming = state.isStreaming || _streamingMessage != null;
    _setWaiting(state.isWaiting);
    _streamingController.add(_isStreaming);
  }

  bool _hasEquivalentMessage(ChatMessage candidate) => _messages.any(
        (message) =>
            message.role == candidate.role &&
            message.content == candidate.content &&
            message.toolCallId == candidate.toolCallId,
      );

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

  String? _inactiveSessionId(dynamic data) {
    if (data is! Map) return null;
    final incoming = data['sessionId'] as String?;
    if (incoming == null || _currentSessionId == null) return null;
    return incoming == _currentSessionId ? null : incoming;
  }

  /// Build a human-readable one-line summary of tool input.
  String _summarizeToolInput(String toolName, Map<String, dynamic> input) {
    switch (toolName) {
      case 'Bash':
        return input['command'] as String? ?? '';
      case 'Read':
      case 'file-read':
        return input['file_path'] as String? ??
            input['filePath'] as String? ??
            '';
      case 'Write':
      case 'file-write':
        final path =
            input['file_path'] as String? ?? input['filePath'] as String? ?? '';
        return path;
      case 'Edit':
      case 'file-edit':
        return input['file_path'] as String? ??
            input['filePath'] as String? ??
            '';
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

  void _persistSessionView(String? sessionId) {
    final desktopId = _transport.selectedDesktopId;
    if (desktopId == null) return;

    unawaited(AppRestoreState.setLastViewedSession(
      desktopId: desktopId,
      sessionId: sessionId,
    ));
  }

  void dispose() {
    _textFlushTimer?.cancel();
    _wsSubscription?.cancel();
    _messagesController.close();
    _streamingController.close();
    _permissionController.close();
    _waitingController.close();
    _planModeController.close();
    _askUserController.close();
    _sessionLoadingController.close();
  }
}

class _LiveSessionState {
  final List<ChatMessage> messages = [];
  ChatMessage? streamingMessage;
  bool isStreaming = false;
  bool isWaiting = false;
}
