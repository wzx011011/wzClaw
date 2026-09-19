// ============================================================
// zcode_session_state — 每会话状态容器（同步层数据结构）
//
// 职责：单会话的 canonical 消息窗（user/assistant + 有序 processParts）、
// 事件去重（eventId）、seq 水位、订阅/物化标记与回合（流式）状态。
// 本类只做纯数据变更，网络 I/O、持久化与通知（notifyListeners）由
// ZcodeChatStore 编排。
//
// 设计要点（对照 relay/zcode/APP-SERVER.md 同步层实测）：
// - 所有入站帧按自带 sessionId 路由到对应容器（含后台会话）；
// - eventId 去重；每会话单调 seq → 断线补放游标；
// - watermark（消息水位）只由 session/messages 响应推进；
// - 实时过程是临时投影：reasoning/text 增量落到当前流式消息的尾部
//   同类过程行；工具按 toolCallId 原位更新，绝不因结果晚到而移动位置。
//   权威 session/messages 返回后按 info.id 原子替换整条消息。
// ============================================================

import 'dart:collection';

import '../models/chat_message.dart';

/// 事件去重集合上限（超出裁剪最旧一半，防止长会话内存膨胀）
const int _kMaxAppliedEventIds = 4000;

/// 单条会话消息条目。
///
/// protoId 为 app-server 侧的消息标识（session/messages 的 info.id，
/// 或流式事件的 assistantMessageId）；null 表示尚无协议 id 的本地消息。
/// synced 标记该条是否已被服务端权威数据确认（本地乐观消息与流式
/// 占位即使采纳了 protoId 仍是未确认，会被权威合并原位消解）。
class ZcodeSessionItem {
  ZcodeSessionItem({
    required this.message,
    this.protoId,
    this.turnId,
    this.synced = false,
    this.dirty = true,
  });

  ChatMessage message;

  /// app-server 消息 id；null 表示本地乐观消息
  String? protoId;

  /// 事件附带的 turnId。历史接口不保证回传，故可为空；只用作本地回合归属，
  /// 绝不作为消息水位或权威身份。
  String? turnId;

  /// 是否已被服务端权威数据确认（false = 本地未同步，可被消解）
  bool synced;

  /// 是否有待写入本地缓存的变更（增量持久化，避免每次全量重写）
  bool dirty;
}

/// 每会话状态容器：消息、去重集合、游标与回合状态。
///
/// 一个容器对应一个 sessionId，生命周期独立于视口（切走不移除，
/// 后台会话继续按帧归属收事件进缓存）。
class ZcodeSessionState {
  ZcodeSessionState(this.sessionId, {DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;

  /// 所属会话 id
  final String sessionId;

  /// 时钟源（计时/采样统一走它；测试注入受控时钟，生产为墙钟）
  final DateTime Function() _clock;

  /// 渲染消息（按时间序；尾部为最新）
  final List<ZcodeSessionItem> items = [];

  /// 已应用事件的 eventId 集合（跨重连/双通道去重）
  final LinkedHashSet<String> appliedEventIds = LinkedHashSet<String>();

  /// 每会话事件单调序号水位（session/event 的 seq；断线补放游标）
  int lastSeq = 0;

  /// 权威消息水位：最后一条经 session/messages 确认的消息 id。
  /// 仅由服务端响应推进（保守策略，见文件头注释）。
  String? watermark;

  /// 本连接生命周期内是否 materialize（resume/create）过
  bool materialized = false;

  /// 该会话当前正被桌面端应用运行（resume 报 -32004）：手机端无法实时
  /// 查看其流式过程，也无法读取服务端消息（运行时单归属设计）
  bool remoteActiveElsewhere = false;

  /// 订阅是否已建立（materialize 时建立，切走不移除；重连后重置）
  bool subscribed = false;

  /// 推送通道是否可用（session/subscribe 失败 → 降级轮询）
  bool pushAvailable = true;

  /// 最近一次 openSession 的纪元（旧纪元的在途结果丢弃）
  int epoch = 0;

  // ---- 回合（流式）状态 ----

  /// 会话运行中（新文本会持续到达）
  bool isStreaming = false;

  /// 已发送等待首个增量
  bool isWaitingForResponse = false;

  /// 流式 assistant 占位在 items 中的下标；-1 表示当前没有占位
  int streamingIndex = -1;

  /// 当前流式消息的 assistantMessageId（占位条目的 protoId）
  String? streamingProtoId;

  /// 当前实时事件所属回合。仅用于把同一回合的过程项落在正确消息上，
  /// 消息的权威身份始终是 session/messages 的 info.id。
  String? streamingTurnId;

  /// 最近一次 usage.delta 的 token 计数（回合收尾通知用）
  int lastInputTokens = 0;
  int lastOutputTokens = 0;

  /// 已收尾的回合 id（session/event 与 telemetry 双通道幂等去重）
  final Set<String> endedTurnIds = {};

  /// 最近一次收到该会话推送帧的时间（推送看门狗判活用；
  /// 降级轮询的拉取结果不计入——只有真实推送能证明通道活着）
  DateTime? lastPushAt;

  /// 会话权限模式（session/setMode；plan|build|edit|yolo|auto）。
  /// null = 未知（未设置、或尚未收到 state.updated 的 mode patch）。
  /// 由 setMode 乐观更新，权威值以 patch.mode.current 回填为准。
  String? mode;

  /// 视口渲染用消息快照（每次访问生成新列表）。
  /// 过滤：系统注入提醒（引擎把 TodoWrite 等提示以 user-role 入库）+
  /// 空助手占位行；流式中的占位是活消息，不过滤。
  List<ChatMessage> get chatMessages => items
      .map((e) => e.message)
      .where((m) => !m.isSystemInjected && !m.isEmptyAssistant)
      .toList(growable: false);

  /// 尾部最后一条**已确认（synced）**的协议消息 id（缓存恢复时推导水位用）。
  /// 未确认条目（本地乐观消息/流式占位）即使采纳了 protoId 也不计入——
  /// 水位语义是「最后一条经服务端 session/messages 确认的消息 id」，
  /// 让占位推进水位会使 afterMessageId 增量永久跳过该消息的最终版本。
  String? get lastProtoId {
    for (final it in items.reversed) {
      if (it.synced && it.protoId != null) return it.protoId;
    }
    return null;
  }

  /// 是否有回合在途（流式占位或等待标志）
  bool get hasTurnInFlight =>
      isStreaming || isWaitingForResponse || streamingIndex >= 0;

  /// 当前未确认过程里是否已有仅靠 model.response 无法表达的内容。工具、
  /// 思考和 marker 必须等 session/messages 回填，纯 text 回合可沿用旧的
  /// 本地收尾快速路径。
  bool get hasNonTextStreamingProcess => items.any((item) {
        if (item.synced || item.message.role != MessageRole.assistant) {
          return false;
        }
        return item.message.processParts
            .any((part) => part.kind != ChatProcessPartKind.text);
      });

  /// 思维链面板数据源：当前流式消息最近一段 reasoning 的实时内容
  /// （正文在其后到达时仍返回最近思考段；canonical parts 是唯一存储）。
  String get liveThinkingText {
    if (streamingIndex < 0 || streamingIndex >= items.length) return '';
    for (final part in items[streamingIndex].message.processParts.reversed) {
      if (part.kind == ChatProcessPartKind.reasoning) return part.text ?? '';
    }
    return '';
  }

  // ──────────────────────────────────────────────
  // 事件去重与游标
  // ──────────────────────────────────────────────

  /// 记录 eventId；已在集合中（重复事件）返回 false
  bool rememberEvent(String eventId) {
    if (!appliedEventIds.add(eventId)) return false;
    if (appliedEventIds.length > _kMaxAppliedEventIds) {
      final drop = appliedEventIds.take(appliedEventIds.length ~/ 2).toList();
      appliedEventIds.removeAll(drop);
    }
    return true;
  }

  /// 推进 seq 水位（单调，只增不减）
  void advanceSeq(int? seq) {
    if (seq != null && seq > lastSeq) lastSeq = seq;
  }

  // ──────────────────────────────────────────────
  // 消息维护（乐观追加 / 流式 / 权威合并）
  // ──────────────────────────────────────────────

  /// 本地乐观追加 user 消息（sendMessage 时；protoId 为 null）
  void appendLocalUserMessage(String text) {
    items.add(
      ZcodeSessionItem(
        message: ChatMessage(
          role: MessageRole.user,
          processParts: [ChatProcessPart.text(text)],
          createdAt: _clock(),
        ),
      ),
    );
  }

  /// 确保指定 assistantMessageId 有一个未确认的流式消息。
  ///
  /// 同一回合可出现多个 assistantMessageId；新 id 不能覆写前一条过程，
  /// 否则 `tool -> reasoning -> text` 会被错误压扁。没有 id 时沿用当前占位。
  int ensureStreamingPlaceholder({String? assistantMessageId, String? turnId}) {
    _turnStartedAt ??= _clock();
    if (turnId != null) streamingTurnId = turnId;
    if (assistantMessageId != null) {
      for (var i = items.length - 1; i >= 0; i--) {
        final it = items[i];
        if (!it.synced &&
            it.message.role == MessageRole.assistant &&
            it.protoId == assistantMessageId) {
          streamingIndex = i;
          streamingProtoId = assistantMessageId;
          it.turnId ??= turnId;
          return i;
        }
      }
    }
    if (streamingIndex >= 0 && streamingIndex < items.length) {
      final current = items[streamingIndex];
      if (assistantMessageId == null ||
          current.protoId == null ||
          current.protoId == assistantMessageId) {
        current.turnId ??= turnId;
        if (assistantMessageId != null) current.protoId = assistantMessageId;
        streamingProtoId = assistantMessageId ?? streamingProtoId;
        return streamingIndex;
      }
    }
    items.add(
      ZcodeSessionItem(
        message: ChatMessage(
          role: MessageRole.assistant,
          createdAt: _clock(),
          isStreaming: true,
        ),
        protoId: assistantMessageId ?? streamingProtoId,
        turnId: turnId ?? streamingTurnId,
      ),
    );
    streamingIndex = items.length - 1;
    streamingProtoId = assistantMessageId ?? streamingProtoId;
    return streamingIndex;
  }

  /// 采纳流式消息的 assistantMessageId（占位条目获得 protoId，
  /// 后续权威刷新可按 id 原位替换）
  void adoptStreamingProtoId(String protoId, {String? turnId}) {
    streamingProtoId = protoId;
    final index = ensureStreamingPlaceholder(
      assistantMessageId: protoId,
      turnId: turnId,
    );
    items[index].protoId = protoId;
    items[index].turnId ??= turnId;
  }

  /// 追加正文增量（text_delta）。同类连续增量只更新尾部文本过程行；
  /// 中间若插入工具或 reasoning，会自然开始新的文本过程行。
  void appendTextDelta(
    String delta, {
    String? assistantMessageId,
    String? turnId,
  }) {
    final index = ensureStreamingPlaceholder(
      assistantMessageId: assistantMessageId,
      turnId: turnId,
    );
    _recordDelta(delta);
    final it = items[index];
    final parts = List<ChatProcessPart>.of(it.message.processParts);
    if (parts.isNotEmpty && parts.last.kind == ChatProcessPartKind.text) {
      final last = parts.removeLast();
      parts.add(last.copyWith(text: '${last.text ?? ''}$delta'));
    } else {
      parts.add(ChatProcessPart.text(delta));
    }
    it.message = it.message.copyWith(
      processParts: parts,
      isStreaming: true,
    );
    it.dirty = true;
    if (isWaitingForResponse) isWaitingForResponse = false; // 首个增量已到达
  }

  /// 追加 thinking 增量（reasoning_delta）。同类连续增量合并进尾部思考行；
  /// 中间若插入工具或正文，会自然开始新的思考行。
  void appendThinkingDelta(
    String delta, {
    String? assistantMessageId,
    String? turnId,
  }) {
    final index = ensureStreamingPlaceholder(
      assistantMessageId: assistantMessageId,
      turnId: turnId,
    );
    _recordDelta(delta);
    final it = items[index];
    final parts = List<ChatProcessPart>.of(it.message.processParts);
    if (parts.isNotEmpty && parts.last.kind == ChatProcessPartKind.reasoning) {
      final last = parts.removeLast();
      parts.add(last.copyWith(text: '${last.text ?? ''}$delta'));
    } else {
      parts.add(ChatProcessPart.reasoning(delta));
    }
    it.message = it.message.copyWith(
      processParts: parts,
      isStreaming: true,
    );
    it.dirty = true;
    if (isWaitingForResponse) isWaitingForResponse = false;
  }

  /// 把实时工具生命周期投影到原序过程流。后续 scheduled/started/progress/
  /// result 只更新同一 toolCallId，绝不把工具行移动到结果抵达的位置。
  void upsertStreamingTool(
    ToolCallInfo tool, {
    String? assistantMessageId,
    String? turnId,
  }) {
    // started/progress/result 常不再携带 assistantMessageId。先在所有未确认
    // assistant 消息中找原工具项，后续状态必须原位更新而非落到当前占位。
    var index = -1;
    for (var candidate = items.length - 1; candidate >= 0; candidate--) {
      final item = items[candidate];
      if (item.synced || item.message.role != MessageRole.assistant) continue;
      final matchesMessage =
          assistantMessageId == null || item.protoId == assistantMessageId;
      if (!matchesMessage) continue;
      final containsTool = item.message.processParts
          .any((part) => part.toolCall?.toolCallId == tool.toolCallId);
      if (containsTool) {
        index = candidate;
        break;
      }
    }
    index = index >= 0
        ? index
        : ensureStreamingPlaceholder(
            assistantMessageId: assistantMessageId,
            turnId: turnId,
          );
    final it = items[index];
    it.turnId ??= turnId;
    final parts = List<ChatProcessPart>.of(it.message.processParts);
    var partIndex = -1;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].kind == ChatProcessPartKind.tool &&
          parts[i].toolCall?.toolCallId == tool.toolCallId) {
        partIndex = i;
        break;
      }
    }
    if (partIndex >= 0) {
      parts[partIndex] = parts[partIndex].copyWith(toolCall: tool);
    } else {
      parts.add(ChatProcessPart.tool(tool));
    }
    it.message = it.message.copyWith(
      processParts: parts,
      isStreaming: true,
    );
    it.dirty = true;
    if (isWaitingForResponse) isWaitingForResponse = false;
  }

  /// 按 toolCallId 在未确认流式消息中查找当前工具投影
  ToolCallInfo? streamingTool(String toolCallId) {
    for (final it in items.reversed) {
      if (it.synced || it.message.role != MessageRole.assistant) continue;
      for (final part in it.message.processParts) {
        if (part.toolCall?.toolCallId == toolCallId) return part.toolCall;
      }
    }
    return null;
  }

  /// 将 activeToolCalls 快照补到实时视图。快照是整体替换的状态投影，
  /// 但不清除已经收到的输入、输出和历史工具行。
  void reconcileActiveTools(List<ToolCallInfo> active, {String? turnId}) {
    for (final tool in active) {
      final existing = streamingTool(tool.toolCallId);
      upsertStreamingTool(
        existing == null
            ? tool
            : existing.copyWith(
                toolName: tool.toolName,
                status: tool.status,
                isError: tool.isError,
                lifecycle: tool.lifecycle,
                startedAt: tool.startedAt,
              ),
        turnId: turnId,
      );
    }
  }

  // ── 回合块数据（回合时长）────────────────────────

  /// 最近一次已完成回合的总时长（毫秒；未知为 null）
  int? lastTurnMs;

  // ── 回合指标（首字延迟 / tok/s）──────────────────
  // 口径（2026-09-18 定）：
  // - 首字延迟 = 流式起点（sendMessage 置位 _turnStartedAt）→ 第一个
  //   到达的增量（思考或正文，谁先到算谁——思考本就实时渲染，这就是
  //   用户看到第一个字出现的时刻，也是标准 TTFT 口径）；
  // - 流式中 tok/s = 滑动窗口增量字符速率 ÷ charsPerTokenEstimate，
  //   只能是估算（协议无逐增量 token 数，usage 只有每请求/回合粒度），
  //   UI 标 ≈ 明示；回合结束后换权威值 =
  //   usage.outputTokens ÷（首增量→末增量生成跨度）。
  //   纯文本回合精确；工具回合跨度含请求间隙，读数偏低属预期。

  /// 滑动窗口宽度：3 秒内的增量字符速率（更短抖动大、更长钝）
  static const int _kRateWindowMs = 3000;

  /// 采样环数量闸（读取只扫描不裁剪，这里防长回合内存膨胀）
  static const int _kMaxRateSamples = 256;

  /// 校准采信门槛：token 与字符样本都够多才更新比率（小样本噪声大）
  static const int _kCalibMinTokens = 50;
  static const int _kCalibMinChars = 200;

  /// 字符/token 比率（流式估算用）。每回合收尾用权威 outputTokens 与
  /// 实际累计字符做 EMA 自校准；static 跨会话共享、仅内存——重启回初值。
  static double charsPerTokenEstimate = 2.5;

  /// 最近一次已完成回合的首字延迟（毫秒；未知为 null）
  int? lastFirstTokenMs;

  /// 最近一次已完成回合的权威 tok/s（outputTokens ÷ 生成跨度；
  /// 无增量或无 token 数据为 null）
  double? lastTurnTokensPerSecond;

  DateTime? _firstDeltaAt;
  DateTime? _lastDeltaAt;
  DateTime? _turnStartedAt;

  /// 本回合累计增量字符数（思考+正文）
  int _deltaChars = 0;

  /// 采样环：(墙钟毫秒, 该时刻累计字符数)
  final List<({int ms, int chars})> _rateSamples = [];

  /// 当前回合首字延迟（首增量未到为 null）
  int? get firstTokenLatencyMs {
    final start = _turnStartedAt;
    final first = _firstDeltaAt;
    if (start == null || first == null) return null;
    return first.difference(start).inMilliseconds;
  }

  /// 回合已耗时（运行中实时；无在途回合为 null）
  Duration? get streamElapsed =>
      _turnStartedAt == null ? null : _clock().difference(_turnStartedAt!);

  /// 滑动窗口内增量字符速率（chars/s）。无采样返回 null；流停顿导致
  /// 采样全部滑出窗口时返回 0（速率随时间衰减的真实语义）。
  double? liveCharsPerSecond() {
    if (_firstDeltaAt == null || _lastDeltaAt == null) return null;
    final nowMs = _clock().millisecondsSinceEpoch;
    ({int ms, int chars})? anchor;
    for (final s in _rateSamples) {
      if (nowMs - s.ms <= _kRateWindowMs) {
        anchor = s;
        break;
      }
    }
    if (anchor == null) return 0;
    final spanMs = nowMs - anchor.ms;
    if (spanMs <= 0) return null;
    return (_deltaChars - anchor.chars) * 1000 / spanMs;
  }

  /// 记录一次增量到达（思考与正文共用）
  void _recordDelta(String delta) {
    final now = _clock();
    _firstDeltaAt ??= now;
    _lastDeltaAt = now;
    _deltaChars += delta.length;
    _rateSamples.add((ms: now.millisecondsSinceEpoch, chars: _deltaChars));
    if (_rateSamples.length > _kMaxRateSamples) {
      _rateSamples.removeRange(0, _rateSamples.length ~/ 2);
    }
  }

  void _rollTurnBlockData({int? outputTokens}) {
    if (_turnStartedAt != null) {
      lastTurnMs = _clock().difference(_turnStartedAt!).inMilliseconds;
    }
    _rollTurnMetrics(outputTokens);
    _turnStartedAt = null;
  }

  /// 滚存首字延迟与权威 tok/s、自校准比率、清空采样。
  /// 无增量的回合（收尾兜底/出错）不动 last* 指标；有增量但无 token
  /// 数据则显式置 null，不冒充上一回合的值。
  void _rollTurnMetrics(int? outputTokens) {
    if (_firstDeltaAt == null) {
      _lastDeltaAt = null;
      _deltaChars = 0;
      _rateSamples.clear();
      return;
    }
    lastFirstTokenMs = firstTokenLatencyMs;
    // token 数优先回合收尾传入的权威 usage；缺省回落 lastOutputTokens
    // （usage.delta / model.response 的每请求口径，多请求回合可能偏小）
    final outTok = outputTokens ?? lastOutputTokens;
    final spanMs = _lastDeltaAt!.difference(_firstDeltaAt!).inMilliseconds;
    lastTurnTokensPerSecond =
        (spanMs > 0 && outTok > 0) ? outTok * 1000 / spanMs : null;
    if (outTok >= _kCalibMinTokens && _deltaChars >= _kCalibMinChars) {
      charsPerTokenEstimate =
          charsPerTokenEstimate * 0.5 + (_deltaChars / outTok) * 0.5;
    }
    _firstDeltaAt = null;
    _lastDeltaAt = null;
    _deltaChars = 0;
    _rateSamples.clear();
  }

  /// 用 model.response 的全文重对当前流式文本（防 text_delta 丢失）。
  /// 此数据仍是临时投影；最终顺序与工具状态以 session/messages 替换。
  void reconcileStreamingText(String text, {String? assistantMessageId}) {
    if (assistantMessageId != null) {
      adoptStreamingProtoId(assistantMessageId);
    }
    if (streamingIndex < 0 || streamingIndex >= items.length) return;
    final it = items[streamingIndex];
    final parts = List<ChatProcessPart>.of(it.message.processParts);
    var lastText = -1;
    for (var i = parts.length - 1; i >= 0; i--) {
      if (parts[i].kind == ChatProcessPartKind.text) {
        lastText = i;
        break;
      }
    }
    if (lastText >= 0) {
      final existing = parts[lastText].text ?? '';
      if (existing.isEmpty || text.startsWith(existing)) {
        parts[lastText] = parts[lastText].copyWith(text: text);
      } else {
        parts.add(ChatProcessPart.text(text));
      }
    } else {
      parts.add(ChatProcessPart.text(text));
    }
    it.message = it.message.copyWith(processParts: parts);
    it.dirty = true;
  }

  /// turn.started 采纳 user 消息：按 protoId 幂等（桌面端发起的回合、
  /// 后台会话补录）；本地乐观 user 消息同文本时原位采纳其 protoId。
  ///
  /// event 的 messageId 只是实时关联线索，不是 session/messages 权威确认；
  /// 因此这里绝不能把 synced 设为 true 或推进缓存水位。
  bool ensureUserMessage({
    String? protoId,
    required String content,
    String? turnId,
  }) {
    if (protoId != null && items.any((e) => e.protoId == protoId)) {
      return false;
    }
    if (protoId != null) {
      for (var i = items.length - 1; i >= 0; i--) {
        final it = items[i];
        if (!it.synced &&
            it.message.role == MessageRole.user &&
            it.message.text == content) {
          it.protoId = protoId;
          it.turnId ??= turnId;
          it.dirty = true;
          return true;
        }
      }
    }
    items.add(
      ZcodeSessionItem(
        message: ChatMessage(
          role: MessageRole.user,
          processParts: [ChatProcessPart.text(content)],
          createdAt: _clock(),
        ),
        protoId: protoId,
        turnId: turnId,
      ),
    );
    return true;
  }

  /// 终结流式投影。一个回合可有多个 assistantMessageId，因此必须收尾该
  /// 回合的所有未确认 assistant 行；只有当前消息可接受 model.response
  /// 的文本兜底，最终可见顺序仍等待 session/messages 原子替换。
  void finalizeStreaming({String? authoritativeText, TokenUsage? usage}) {
    for (var i = 0; i < items.length; i++) {
      final it = items[i];
      final isCurrent = i == streamingIndex;
      final sameTurn = streamingTurnId != null && it.turnId == streamingTurnId;
      if (it.synced ||
          it.message.role != MessageRole.assistant ||
          (!it.message.isStreaming && !isCurrent) ||
          (!isCurrent && !sameTurn)) {
        continue;
      }
      var parts = List<ChatProcessPart>.of(it.message.processParts);
      if (isCurrent &&
          authoritativeText != null &&
          authoritativeText.isNotEmpty) {
        var lastText = -1;
        for (var p = parts.length - 1; p >= 0; p--) {
          if (parts[p].kind == ChatProcessPartKind.text) {
            lastText = p;
            break;
          }
        }
        if (lastText >= 0) {
          parts[lastText] = parts[lastText].copyWith(text: authoritativeText);
        } else {
          parts.add(ChatProcessPart.text(authoritativeText));
        }
      }
      it.message = it.message.copyWith(
        isStreaming: false,
        processParts: parts,
        usage: isCurrent ? usage ?? it.message.usage : it.message.usage,
      );
      it.dirty = true;
    }
    streamingIndex = -1;
    _rollTurnBlockData(outputTokens: usage?.outputTokens);
  }

  /// 新回合时重置流式游标与 token 计数
  void resetTurnState() {
    _rollTurnBlockData();
    streamingIndex = -1;
    streamingProtoId = null;
    streamingTurnId = null;
    lastInputTokens = 0;
    lastOutputTokens = 0;
  }

  /// 合并权威消息批次（session/messages 响应已按服务端数组顺序排列）：
  /// - 同 protoId 必须原位整体替换，确保实时 parts 被权威 parts 原子取代；
  /// - 未带 id 的本地 user、或尚未获得 assistantMessageId 的占位，才允许
  ///   受限的尾部消解；不能按任意 assistant 文本做模糊匹配；
  /// - 其他权威消息按服务端返回顺序追加。
  void mergeAuthoritative(List<ZcodeSessionItem> incoming) {
    if (incoming.isEmpty) return;
    final byProto = <String, int>{};
    for (var i = 0; i < items.length; i++) {
      final id = items[i].protoId;
      if (id != null) byProto[id] = i;
    }
    var localRunStart = items.length;
    while (localRunStart > 0 && !items[localRunStart - 1].synced) {
      localRunStart--;
    }
    for (final inc in incoming) {
      final id = inc.protoId;
      final existingIdx = id == null ? null : byProto[id];
      if (existingIdx != null) {
        items[existingIdx] = inc;
        if (id != null) byProto[id] = existingIdx;
        _consumeStreamingAt(existingIdx);
        continue;
      }

      var reconciled = false;
      final role = inc.message.role;
      for (var i = items.length - 1; i >= localRunStart; i--) {
        final local = items[i];
        if (local.synced || local.message.role != role) continue;
        final canReconcile = switch (role) {
          // 同一回合优先，旧事件没有 turnId 时才回退同文本；只检查尾部
          // 未确认项，避免重复提示词把更早的乐观消息错误吞掉。
          MessageRole.user =>
            (inc.turnId != null && local.turnId == inc.turnId) ||
                (inc.turnId == null &&
                    local.turnId == null &&
                    local.message.text == inc.message.text),
          // assistant 有 server id 却没有 exact hit 时，只能消解还没获得任何
          // assistantMessageId 的空占位；已有不同 id 绝不猜测同一消息。
          MessageRole.assistant => local.protoId == null,
        };
        if (!canReconcile) continue;
        items[i] = inc;
        if (id != null) byProto[id] = i;
        _consumeStreamingAt(i);
        reconciled = true;
        break;
      }
      if (!reconciled) {
        items.add(inc);
        if (id != null) byProto[id] = items.length - 1;
      }
    }
  }

  /// 权威数据替换了流式占位所在下标时消费占位游标：
  /// 占位已被服务端版本取代，后续 finalizeStreaming 不得再覆写该条目
  void _consumeStreamingAt(int index) {
    if (index == streamingIndex) streamingIndex = -1;
  }

  /// 头部插入截断提示（降级路径使用 resume 的 messages 数组且被
  /// companion 截断时）
  void insertHeadNotice(String notice) {
    items.insert(
      0,
      ZcodeSessionItem(
        message: ChatMessage(
          role: MessageRole.assistant,
          processParts: [ChatProcessPart.text(notice)],
          createdAt: _clock(),
        ),
      ),
    );
  }
}
