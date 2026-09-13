// ============================================================
// zcode_chat_store — ZCode 远程控制状态管理（ChangeNotifier）
//
// 【契约文件】类签名是并行开发公共契约，实现者补全，公共 API 不得改动。
//
// 职责：配对持久化、会话列表、当前会话消息、流式渲染。
// 消息模型复用 models/chat_message.dart（与现有聊天 UI 兼容）。
//
// 实现说明（对照 relay/zcode/APP-SERVER.md 与 TS 参考实现）：
// - 流式正文不在 v4/telemetry 通知里（只有 chunk 长度），真正的增量通过
//   轮询 session/events 的 text_delta/reasoning_delta 拉取，按 eventId 去重。
// - turn.terminal 后用 session/messages 做权威刷新（工具调用结果只有权威
//   列表才有），并触发本地通知（zcode_notifier）。
// - 权限确认 / AskUser 通过客户端 onRequest 钩子接入：反向请求解析成功则
//   推流等待用户应答，应答结果由客户端作为响应帧回传（带原请求 id）；
//   解析失败抛错 → 客户端回默认拒绝 error 帧。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/chat_message.dart';
import '../services/chat_store.dart' show AskUserQuestion, PermissionRequest;
import 'zcode_notifier.dart';
import 'zcode_pairing.dart';
import 'zcode_relay_client.dart';

/// 配对持久化 key（shared_preferences）
const String _kPairingPrefsKey = 'wzxclaw-zcode-pairing';

/// 流式轮询间隔
const Duration _kPollInterval = Duration(milliseconds: 1200);

/// 权威刷新拉取的消息条数
const int _kAuthoritativeLimit = 200;

/// thinking 缓冲上限（超出保留后半部分，与 services/chat_store 一致）
const int _kMaxThinkingChars = 20000;

/// 连接状态
enum ZcodeConnState { idle, connecting, waiting, matched }

/// ZCode 会话元信息（session/list 条目）
class ZcodeSessionMeta {
  final String sessionId;
  final String title;
  final int updatedAt;
  final String? workspaceKey;
  final String? workspacePath;

  const ZcodeSessionMeta({
    required this.sessionId,
    required this.title,
    required this.updatedAt,
    this.workspaceKey,
    this.workspacePath,
  });
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
  ZcodeChatStore({ZcodeRelayClient? client /* 测试注入 */})
      : _injectedClient = client;

  /// 注入的测试替身（真机路径为 null，pair/restore 时构造真客户端）
  final ZcodeRelayClient? _injectedClient;

  ZcodeRelayClient? _client;

  // ---- 状态字段 ----
  ZcodePairingInfo? _pairing;
  ZcodeConnState _connState = ZcodeConnState.idle;
  String? _error;
  List<ZcodeSessionMeta> _sessions = [];
  bool _sessionsLoading = false;
  bool _sessionsAutoLoaded = false;
  String? _activeSessionId;
  List<ChatMessage> _messages = [];
  bool _isStreaming = false;
  bool _isWaitingForResponse = false;

  // ---- 流式渲染内部 ----
  Timer? _pollTimer;
  final Set<String> _appliedEventIds = {};

  /// 流式 assistant 占位在 _messages 中的下标；-1 表示当前没有占位
  int _streamingIndex = -1;
  String _streamingText = '';
  String _thinkingContent = '';
  int _lastInputTokens = 0;
  int _lastOutputTokens = 0;

  /// 复用最近会话的工作区（手机端不知道桌面路径，新建会话时复用）
  String? _defaultWorkspaceKey;
  String? _defaultWorkspacePath;

  // ---- 权限确认 / AskUser ----
  final StreamController<PermissionRequest?> _permissionController =
      StreamController<PermissionRequest?>.broadcast();
  final StreamController<AskUserQuestion?> _askUserController =
      StreamController<AskUserQuestion?>.broadcast();
  PermissionRequest? _activePermission;
  AskUserQuestion? _activeAskUser;

  /// 待应答反向请求：toolCallId / questionId → 挂起的 completer
  final Map<String, _PendingReverse> _pendingReverse = {};

  // ──────────────────────────────────────────────
  // 状态 getter（notifyListeners 驱动 UI）
  // ──────────────────────────────────────────────

  ZcodePairingInfo? get pairing => _pairing;

  ZcodeConnState get connState => _connState;

  String? get error => _error;

  List<ZcodeSessionMeta> get sessions => _sessions;

  bool get sessionsLoading => _sessionsLoading;

  String? get activeSessionId => _activeSessionId;

  List<ChatMessage> get messages => _messages;

  bool get isStreaming => _isStreaming; // 会话运行中（新文本会持续到达）

  bool get isWaitingForResponse => _isWaitingForResponse;

  /// 当前回合的 thinking 内容（流式 reasoning_delta 拼接；回合结束清空）。
  /// ChatMessage 模型没有 thinking 字段，与 services/chat_store 一致由
  /// store 层管理渲染状态。
  String get thinkingContent => _thinkingContent;

  /// 当前待处理的权限请求（供 UI 渲染权限条）
  PermissionRequest? get activePermission => _activePermission;

  /// 当前待处理的 AskUser 问题（供 UI 渲染问题条）
  AskUserQuestion? get activeAskUser => _activeAskUser;

  /// 权限请求流（null 表示清除当前请求）
  Stream<PermissionRequest?> get permissionStream => _permissionController.stream;

  /// AskUser 问题流（null 表示清除当前问题）
  Stream<AskUserQuestion?> get askUserStream => _askUserController.stream;

  /// 通知器（单例，测试可注入替身）
  ZcodeNotifier get _notifier => ZcodeNotifier.instance;

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
    return true;
  }

  /// 解除配对（清持久化 + 断开）
  void unpair() {
    _stopPolling();
    _rejectAllPendingReverse();
    _client?.close();
    _client = null;
    _pairing = null;
    _connState = ZcodeConnState.idle;
    _sessions = [];
    _sessionsLoading = false;
    _sessionsAutoLoaded = false;
    _activeSessionId = null;
    _messages = [];
    _resetTurnState();
    _appliedEventIds.clear();
    _isStreaming = false;
    _isWaitingForResponse = false;
    _error = null;
    notifyListeners();
    unawaited(_clearPersistedPairing());
  }

  /// 启动时恢复已保存的配对（自动重连）
  Future<void> restore() async {
    if (_pairing != null) return; // 已配对
    final ZcodePairingInfo? saved;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_kPairingPrefsKey);
      if (raw == null || raw.isEmpty) return;
      final decoded = jsonDecode(raw);
      saved = ZcodePairingInfo.fromJson(
        decoded is Map ? decoded.cast<String, dynamic>() : null,
      );
    } catch (_) {
      return; // 持久化损坏：按未配对处理
    }
    if (saved == null) return;
    _pairing = saved;
    _connState = ZcodeConnState.connecting;
    notifyListeners();
    _attachClient();
    // 连接稳定后自动拉一次会话列表（注入替身时 paired 立即为真）
    await refreshSessions();
  }

  /// 构造/挂载客户端：测试注入的替身直接使用；真机路径用 pairing 构造
  void _attachClient() {
    final info = _pairing;
    if (info == null) return;
    _stopPolling();

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

  /// relay 状态 → 连接状态映射；配对成功时自动拉一次会话列表
  void _onRelayStateChange(ZcodeRelayState state, bool paired) {
    final wasMatched = _connState == ZcodeConnState.matched;
    _connState = _relayStateToConn(state, paired);
    if (paired && !wasMatched && !_sessionsAutoLoaded) {
      _sessionsAutoLoaded = true;
      unawaited(refreshSessions());
    }
    if (!paired) {
      // 重置一次性自动拉取标记：重连 matched 后重新自动刷新会话列表
      _sessionsAutoLoaded = false;
      _stopPolling();
      _setStreaming(false);
    }
    notifyListeners();
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

  /// 打开会话（resume + parts→ChatMessage 映射；running 则启动流式轮询）
  Future<void> openSession(String sessionId) async {
    final client = _client;
    if (client == null || !client.paired) {
      _fail('尚未连接 ZCode，无法打开会话');
      return;
    }
    _stopPolling();
    _rejectAllPendingReverse();
    _activeSessionId = sessionId;
    _messages = [];
    _resetTurnState();
    _appliedEventIds.clear();
    _isStreaming = false;
    _isWaitingForResponse = false;
    notifyListeners();

    try {
      final result = await client.request('session/resume', {'sessionId': sessionId});
      final map = result is Map ? result : const {};
      _messages = _mapProtocolMessages(map);

      // companion 截断标记：仅保留了尾部消息（relay 1MiB 帧上限），头部加提示
      if (map['messagesTruncated'] == true && _messages.isNotEmpty) {
        _messages = List.of(_messages)
          ..insert(
            0,
            ChatMessage(
              role: MessageRole.assistant,
              content: '（历史较长，已截断，仅显示最近消息）',
              createdAt: _messages.first.createdAt,
            ),
          );
      }

      // 记住该会话的工作区（新建会话复用）
      final session = map['session'];
      if (session is Map) {
        final ws = session['workspace'];
        if (ws is Map) {
          final key = _nonEmpty(ws['workspaceKey']);
          final path = _nonEmpty(ws['workspacePath']);
          if (key != null && path != null) {
            _defaultWorkspaceKey = key;
            _defaultWorkspacePath = path;
          }
        }
      }

      // 会话仍在运行：置流式并继续轮询增量
      final projection = map['projection'];
      final status = projection is Map ? projection['status'] : null;
      if (status == 'running') {
        _isStreaming = true;
        _startPolling();
      } else {
        _isStreaming = false;
      }
    } catch (e) {
      _activeSessionId = null; // 打开失败：回到列表
      _fail('打开会话失败：$e');
      return;
    }
    notifyListeners();
  }

  /// 新建会话（复用最近会话的 workspace；无可用工作区则报错提示）
  Future<void> newSession() async {
    final client = _client;
    if (client == null || !client.paired) {
      _fail('尚未连接 ZCode，无法新建会话');
      return;
    }
    // 复用最近会话的 workspace（手机端不知道桌面路径）
    if (_defaultWorkspaceKey == null || _defaultWorkspacePath == null) {
      await refreshSessions(); // 刷一次列表以获得可复用工作区
    }
    final wsKey = _defaultWorkspaceKey;
    final wsPath = _defaultWorkspacePath;
    if (wsKey == null || wsPath == null) {
      _fail('没有可复用的工作区，请先在桌面端创建一个会话');
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

  /// 关闭会话视图回到列表
  void closeSessionView() {
    _stopPolling();
    _rejectAllPendingReverse();
    _activeSessionId = null;
    _messages = [];
    _resetTurnState();
    _isStreaming = false;
    _isWaitingForResponse = false;
    notifyListeners();
  }

  // ──────────────────────────────────────────────
  // 聊天
  // ──────────────────────────────────────────────

  /// 发送消息：本地追加 user 消息 + 流式 assistant 占位，session/send
  Future<void> sendMessage(String content) async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _fail('未连接 ZCode 或未打开会话');
      return;
    }
    final text = content.trim();
    if (text.isEmpty) return;

    // 本地立即追加 user 消息 + 流式 assistant 占位（乐观更新）
    _finalizeStreaming(); // 终结上一回合的占位（若有）
    _resetTurnState();
    _messages = List.of(_messages)
      ..add(ChatMessage(
        role: MessageRole.user,
        content: text,
        createdAt: DateTime.now(),
      ),);
    _ensureStreamingPlaceholder();
    _appliedEventIds.clear();
    _isStreaming = true;
    _isWaitingForResponse = true;
    _error = null;
    notifyListeners();

    try {
      await client.request('session/send', {'sessionId': sessionId, 'content': text});
      // 成功后启动流式轮询（首个 tick 立即执行）
      _startPolling();
    } catch (e) {
      _isWaitingForResponse = false;
      _setStreaming(false);
      _fail('发送失败：$e');
    }
  }

  /// 停止生成（session/stop + 刷新权威消息）
  Future<void> stopGeneration() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null) return;
    try {
      await client.request('session/stop', {'sessionId': sessionId});
    } catch (_) {
      // 停止请求失败也继续拉权威消息
    }
    await _refreshAuthoritative();
  }

  // ──────────────────────────────────────────────
  // 权限确认 / AskUser
  // ──────────────────────────────────────────────

  /// 应答权限请求：结果由客户端作为反向请求响应帧回传（带原请求 id）
  void respondToPermission(String toolCallId, {required bool approved, bool remember = false}) {
    final pending = _pendingReverse.remove(toolCallId);
    if (pending == null) return; // 没有对应待处理请求（可能已应答/已断开）
    if (_activePermission?.toolCallId == toolCallId) {
      _activePermission = null;
      if (!_permissionController.isClosed) _permissionController.add(null); // 清除权限条
    }
    pending.completer.complete({
      'toolCallId': toolCallId,
      'approved': approved,
      if (remember) 'remember': remember,
    });
    notifyListeners();
  }

  /// 应答 AskUser 问题：结果由客户端作为反向请求响应帧回传（带原请求 id）
  void respondToAskUser(String questionId, List<String> answers, {String? customText}) {
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
  /// - method 含 permission → 解析 PermissionRequest 推流，等待用户应答
  /// - method 含 interaction / askUser 且带 options/question → AskUserQuestion 推流
  /// - 解析失败或未知 method → 抛错（客户端回默认拒绝 error 帧，安全优先）
  Future<dynamic> _handleReverseRequest(ZcodeFrame frame) {
    final method = frame.method ?? '';
    final params = frame.params is Map ? frame.params as Map : const {};
    final lower = method.toLowerCase();

    if (lower.contains('permission')) {
      final request = _parsePermissionRequest(params, fallbackId: frame.id?.toString());
      if (request == null) {
        throw Exception('无法解析权限请求: $method');
      }
      return _awaitReverseResponse(
        key: request.toolCallId,
        frameId: frame.id,
        onRegistered: () {
          _activePermission = request;
          if (!_permissionController.isClosed) _permissionController.add(request);
          notifyListeners();
        },
      );
    }

    if (lower.contains('interaction') || lower.contains('askuser') || lower.contains('ask_user')) {
      final question = _parseAskUserQuestion(params, fallbackId: frame.id?.toString());
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
    final completer = Completer<dynamic>();
    _pendingReverse[key] = _PendingReverse(frameId: frameId, completer: completer);
    onRegistered();
    return completer.future;
  }

  /// 解析权限请求（ZCode 侧字段未实测，按 wzxClaw 自家 ws 形状做最大兼容）：
  /// toolCallId/tool_call_id/callId/requestId/id；
  /// toolName/tool_name/tool/name；input/params/arguments
  PermissionRequest? _parsePermissionRequest(Map params, {String? fallbackId}) {
    final toolCallId =
        _firstNonEmpty(params, ['toolCallId', 'tool_call_id', 'callId', 'requestId', 'id']) ??
            fallbackId;
    final toolName =
        _firstNonEmpty(params, ['toolName', 'tool_name', 'tool', 'name']);
    if (toolCallId == null || toolCallId.isEmpty) return null;
    if (toolName == null || toolName.isEmpty) return null;

    dynamic input = params['input'];
    if (input is! Map) input = params['params'];
    if (input is! Map) input = params['arguments'];
    return PermissionRequest(
      toolCallId: toolCallId,
      toolName: toolName,
      input: input is Map ? Map<String, dynamic>.from(input) : {},
    );
  }

  /// 解析 AskUser 问题（同上，多字段名兜底）：
  /// questionId/question_id/callId/id；question/text/prompt；
  /// options/choices: [{label, description}]；multiSelect/multi_select
  AskUserQuestion? _parseAskUserQuestion(Map params, {String? fallbackId}) {
    final questionId =
        _firstNonEmpty(params, ['questionId', 'question_id', 'callId', 'id']) ?? fallbackId;
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
  /// 以拒绝结果完成（客户端会回传响应帧，避免桌面端 -32022 超时挂起）
  void _rejectAllPendingReverse() {
    if (_pendingReverse.isEmpty) return;
    final entries = List.of(_pendingReverse.entries);
    _pendingReverse.clear();
    for (final e in entries) {
      if (!e.value.completer.isCompleted) {
        e.value.completer.complete(const <String, dynamic>{'rejected': true});
      }
    }
    _activePermission = null;
    _activeAskUser = null;
    if (!_permissionController.isClosed) _permissionController.add(null);
    if (!_askUserController.isClosed) _askUserController.add(null);
  }

  // ──────────────────────────────────────────────
  // 内部：通知帧处理 + 流式轮询（1.2s，按 eventId 去重）
  // ──────────────────────────────────────────────

  /// 通知帧处理：
  /// - state.updated：patch.status running→isStreaming=true / idle→false
  /// - v4/telemetry/event：
  ///   - usage.delta → 记 token 数
  ///   - turn.terminal → 停轮询 + 本地通知 + 拉权威消息刷新
  ///   - stream.chunk → 通知只有长度没有内容，确保轮询在跑（正文走 session/events）
  void _handleNotifyFrame(ZcodeFrame frame) {
    final sessionId = _activeSessionId;
    if (sessionId == null) return;
    final method = frame.method;
    final params = frame.params;

    if (method == 'state.updated') {
      final patch = params is Map ? params['patch'] : null;
      final status = patch is Map ? patch['status'] : null;
      if (status == 'running') {
        _setStreaming(true);
      } else if (status == 'idle') {
        _setStreaming(false);
      }
    } else if (method == 'v4/telemetry/event') {
      if (params is! Map) return;
      final kind = params['kind'];
      if (kind == 'usage.delta') {
        _lastInputTokens = _toIntOrNull(params['inputTokens']) ?? _lastInputTokens;
        _lastOutputTokens = _toIntOrNull(params['outputTokens']) ?? _lastOutputTokens;
      } else if (kind == 'turn.terminal') {
        _handleTurnTerminal(params);
      } else if (kind == 'stream.chunk') {
        _startPolling();
      }
    }
  }

  /// 回合结束：停轮询 + 本地通知 + 权威刷新（工具调用结果只有权威列表才有）
  void _handleTurnTerminal(Map params) {
    _stopPolling();
    final status = params['status']?.toString() ?? 'success';
    final tokenCount = _toIntOrNull(params['tokenCount']) ??
        (_lastInputTokens + _lastOutputTokens);
    _setStreaming(false);
    _isWaitingForResponse = false;
    // 任务完成本地通知（App 在后台也能感知；标题按 status 二分）
    _notifier.showTaskDone(status: status, tokens: tokenCount, sessionId: _activeSessionId);
    // 拉权威消息刷新
    unawaited(_refreshAuthoritative());
  }

  void _startPolling() {
    if (_pollTimer != null) return; // 已在轮询
    if (_client?.paired != true) return;
    unawaited(_pollOnce()); // 立即拉一次
    _pollTimer = Timer.periodic(_kPollInterval, (_) => unawaited(_pollOnce()));
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// 轮询 session/events：payload.kind
  /// text_delta→追加流式消息、reasoning_delta→thinking 字段；按 eventId 去重
  Future<void> _pollOnce() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null || !client.paired) {
      _stopPolling();
      return;
    }
    try {
      final result = await client.request('session/events', {
        'sessionId': sessionId,
        'limit': 100,
      });
      final map = result is Map ? result : const {};
      final events = map['events'];
      if (events is! List) return;
      for (final ev in events) {
        if (ev is! Map) continue;
        final eventId = ev['eventId']?.toString();
        if (eventId == null || eventId.isEmpty) continue;
        if (!_appliedEventIds.add(eventId)) continue; // 已应用过（去重）
        final payload = ev['payload'];
        if (payload is! Map) continue;
        final kind = payload['kind'];
        if (kind == 'text_delta') {
          final delta = payload['delta'];
          if (delta is String && delta.isNotEmpty) _appendTextDelta(delta);
        } else if (kind == 'reasoning_delta') {
          final delta = payload['delta'];
          if (delta is String && delta.isNotEmpty) _appendThinkingDelta(delta);
        }
      }
    } catch (_) {
      // 轮询失败静默，下一轮重试
    }
  }

  /// turn.terminal / stopGeneration 后的权威刷新：
  /// session/messages 重建消息列表（工具调用结果只有权威列表才有）
  Future<void> _refreshAuthoritative() async {
    final client = _client;
    final sessionId = _activeSessionId;
    if (client == null || sessionId == null) return;
    try {
      final result = await client.request('session/messages', {
        'sessionId': sessionId,
        'limit': _kAuthoritativeLimit,
      });
      final map = result is Map ? result : const {};
      _messages = _mapProtocolMessages(map);
    } catch (_) {
      // 权威刷新失败：保留现有流式内容，仅结束流式标记
    }
    _stopPolling();
    _finalizeStreaming();
    _isStreaming = false;
    _isWaitingForResponse = false;
    notifyListeners();
  }

  // ──────────────────────────────────────────────
  // 内部：流式消息维护
  // ──────────────────────────────────────────────

  void _setStreaming(bool value) {
    if (!value) _finalizeStreaming();
    _isStreaming = value;
    notifyListeners();
  }

  /// 确保尾部存在流式 assistant 占位（ChatMessage.isStreaming = true）
  void _ensureStreamingPlaceholder() {
    if (_streamingIndex >= 0 && _streamingIndex < _messages.length) return;
    _messages = List.of(_messages)
      ..add(ChatMessage(
        role: MessageRole.assistant,
        content: '',
        createdAt: DateTime.now(),
        isStreaming: true,
      ),);
    _streamingIndex = _messages.length - 1;
  }

  void _appendTextDelta(String delta) {
    _streamingText += delta;
    _ensureStreamingPlaceholder();
    if (_streamingIndex >= 0 && _streamingIndex < _messages.length) {
      _messages[_streamingIndex] =
          _messages[_streamingIndex].copyWith(content: _streamingText);
    }
    if (_isWaitingForResponse) _isWaitingForResponse = false; // 首个增量已到达
    notifyListeners();
  }

  void _appendThinkingDelta(String delta) {
    if (_thinkingContent.length + delta.length > _kMaxThinkingChars) {
      // 截断：保留后半部分（更新的内容更有价值），与 services/chat_store 一致
      _thinkingContent = _thinkingContent.substring(_thinkingContent.length ~/ 2);
    }
    _thinkingContent += delta;
    notifyListeners();
  }

  /// 终结流式占位（标记 isStreaming=false、清空游标与 thinking）
  void _finalizeStreaming() {
    if (_streamingIndex >= 0 && _streamingIndex < _messages.length) {
      final m = _messages[_streamingIndex];
      if (m.isStreaming) {
        _messages[_streamingIndex] = m.copyWith(isStreaming: false);
      }
    }
    _streamingIndex = -1;
    _streamingText = '';
    _thinkingContent = '';
  }

  /// 新回合 / 切换会话时重置流式游标与 token 计数
  void _resetTurnState() {
    _streamingIndex = -1;
    _streamingText = '';
    _thinkingContent = '';
    _lastInputTokens = 0;
    _lastOutputTokens = 0;
  }

  // ──────────────────────────────────────────────
  // 内部：协议消息映射
  // ──────────────────────────────────────────────

  /// result.messages → List<ChatMessage>
  List<ChatMessage> _mapProtocolMessages(Map map) {
    final raw = map['messages'];
    if (raw is! List) return [];
    final out = <ChatMessage>[];
    for (final m in raw) {
      if (m is! Map) continue;
      final msg = _mapProtocolMessage(m);
      if (msg != null) out.add(msg);
    }
    return out;
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

  /// tool part → ToolCallInfo；工具结果（output/result）映射到 outputSummary
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

    final state = p['state']?.toString() ?? '';
    final ToolCallStatus status;
    switch (state) {
      case 'running':
        status = ToolCallStatus.running;
        break;
      case 'completed':
        status = ToolCallStatus.done;
        break;
      default: // failed / errored / 其他一律视为 error
        status = ToolCallStatus.error;
    }

    return ToolCallInfo(
      toolCallId: p['callId']?.toString() ?? '',
      toolName: name,
      inputSummary: _summaryOf(p['input'] ?? (tool is Map ? tool['input'] : null)),
      outputSummary: _summaryOf(p['output'] ?? p['result']),
      status: status,
      isError: p['isError'] == true || status == ToolCallStatus.error,
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

  @override
  void dispose() {
    _stopPolling();
    _rejectAllPendingReverse();
    _client?.close();
    _client = null;
    _permissionController.close();
    _askUserController.close();
    super.dispose();
  }
}
