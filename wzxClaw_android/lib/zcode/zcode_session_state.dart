// ============================================================
// zcode_session_state — 每会话状态容器（P1.2 同步层核心数据结构）
//
// 职责：单会话的消息窗、事件去重（eventId）、seq 水位、订阅/物化
// 标记与回合（流式）状态。本类只做纯数据变更，网络 I/O、持久化与
// 通知（notifyListeners）由 ZcodeChatStore 编排。
//
// 设计要点（对照 .planning/PLAN-zcode-remote-v2.md P1.2 与
// relay/zcode/APP-SERVER.md「同步层协议实测（第二轮）」节）：
// - 所有入站帧按自带 sessionId 路由到对应容器（含后台会话），
//   多会话订阅并存、互不串扰；
// - eventId 是 UUID（构造性全局唯一）→ 去重安全；每会话另有单调
//   seq → 断线后从 last-seq 重订阅/补放的游标；
// - watermark（消息水位）只由 session/messages 响应推进，避免跳过
//   未见过的消息；
// - epoch 由 store 在切换/关闭时递增，旧纪元的在途结果不写容器。
// ============================================================

import 'dart:collection';

import '../models/chat_message.dart';

/// 事件去重集合上限（超出裁剪最旧一半，防止长会话内存膨胀）
const int _kMaxAppliedEventIds = 4000;

/// thinking 缓冲上限（超出保留后半部分，与 services/chat_store 一致）
const int _kMaxThinkingChars = 20000;

/// 单条会话消息：ChatMessage + 协议消息 id。
///
/// protoId 为 app-server 侧的消息标识（session/messages 的 info.id，
/// 或流式事件的 assistantMessageId）；null 表示尚无协议 id 的本地消息。
/// synced 标记该条是否已被服务端权威数据确认（本地乐观消息与流式
/// 占位即使采纳了 protoId 仍是未确认，会被权威合并原位消解）。
class ZcodeSessionItem {
  ZcodeSessionItem({
    required this.message,
    this.protoId,
    this.synced = false,
    this.dirty = true,
  });

  /// 渲染用消息模型（与现有聊天 UI 兼容）
  ChatMessage message;

  /// app-server 消息 id；null 表示本地乐观消息
  String? protoId;

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
  ZcodeSessionState(this.sessionId);

  /// 所属会话 id
  final String sessionId;

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

  /// 流式正文累积
  String streamingText = '';

  /// 当前流式消息的 assistantMessageId（占位条目的 protoId）
  String? streamingProtoId;

  /// 当前回合 thinking 内容（流式 reasoning 拼接；回合结束清空）
  String thinkingContent = '';

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

  /// 视口渲染用消息快照（每次访问生成新列表，页面零改动兼容）
  List<ChatMessage> get chatMessages =>
      items.map((e) => e.message).toList(growable: false);

  /// 尾部最后一条已知协议消息 id（缓存恢复时推导水位用）
  String? get lastProtoId {
    for (final it in items.reversed) {
      if (it.protoId != null) return it.protoId;
    }
    return null;
  }

  /// 是否有回合在途（流式占位或等待标志）
  bool get hasTurnInFlight =>
      isStreaming || isWaitingForResponse || streamingIndex >= 0;

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
    items.add(ZcodeSessionItem(
      message: ChatMessage(
        role: MessageRole.user,
        content: text,
        createdAt: DateTime.now(),
      ),
    ),);
  }

  /// 确保尾部存在流式 assistant 占位（isStreaming = true）
  void ensureStreamingPlaceholder() {
    if (streamingIndex >= 0 && streamingIndex < items.length) return;
    items.add(ZcodeSessionItem(
      message: ChatMessage(
        role: MessageRole.assistant,
        content: '',
        createdAt: DateTime.now(),
        isStreaming: true,
      ),
      protoId: streamingProtoId,
    ),);
    streamingIndex = items.length - 1;
  }

  /// 采纳流式消息的 assistantMessageId（占位条目获得 protoId，
  /// 后续权威刷新可按 id 原位替换）
  void adoptStreamingProtoId(String protoId) {
    streamingProtoId = protoId;
    if (streamingIndex >= 0 && streamingIndex < items.length) {
      items[streamingIndex].protoId = protoId;
    }
  }

  /// 追加正文增量（text_delta）
  void appendTextDelta(String delta) {
    streamingText += delta;
    ensureStreamingPlaceholder();
    if (streamingIndex >= 0 && streamingIndex < items.length) {
      final it = items[streamingIndex];
      it.message = it.message.copyWith(content: streamingText);
      it.dirty = true;
    }
    if (isWaitingForResponse) isWaitingForResponse = false; // 首个增量已到达
  }

  /// 追加 thinking 增量（reasoning_delta；超限保留后半部分）
  void appendThinkingDelta(String delta) {
    if (thinkingContent.length + delta.length > _kMaxThinkingChars) {
      thinkingContent =
          thinkingContent.substring(thinkingContent.length ~/ 2);
    }
    thinkingContent += delta;
  }

  /// 用权威全文重对流式文本（model.response 的 content，防增量丢失）
  void reconcileStreamingText(String text) {
    if (streamingText == text) return;
    streamingText = text;
    if (streamingIndex >= 0 && streamingIndex < items.length) {
      final it = items[streamingIndex];
      it.message = it.message.copyWith(content: text);
      it.dirty = true;
    }
  }

  /// turn.started 采纳 user 消息：按 protoId 幂等（桌面端发起的回合、
  /// 后台会话补录）；本地乐观 user 消息同文本时原位采纳其 protoId。
  /// 带服务端 protoId 即视为已同步。
  bool ensureUserMessage({String? protoId, required String content}) {
    if (protoId != null && items.any((e) => e.protoId == protoId)) {
      return false;
    }
    if (protoId != null) {
      for (var i = items.length - 1; i >= 0; i--) {
        final it = items[i];
        if (!it.synced &&
            it.message.role == MessageRole.user &&
            it.message.content == content) {
          it.protoId = protoId;
          it.synced = true;
          it.dirty = true;
          return true;
        }
      }
    }
    items.add(ZcodeSessionItem(
      message: ChatMessage(
        role: MessageRole.user,
        content: content,
        createdAt: DateTime.now(),
      ),
      protoId: protoId,
      synced: protoId != null,
    ),);
    return true;
  }

  /// 终结流式占位：标记 isStreaming=false、以权威全文（若有）落定内容、
  /// 清空游标与 thinking
  void finalizeStreaming({String? authoritativeText, TokenUsage? usage}) {
    final text = (authoritativeText != null && authoritativeText.isNotEmpty)
        ? authoritativeText
        : streamingText;
    if (streamingIndex >= 0 && streamingIndex < items.length) {
      final it = items[streamingIndex];
      final m = it.message;
      if (m.isStreaming || m.content != text || usage != null) {
        it.message = m.copyWith(
          isStreaming: false,
          content: text,
          usage: usage ?? m.usage,
        );
        it.dirty = true;
      }
    }
    streamingIndex = -1;
    streamingText = '';
    thinkingContent = '';
  }

  /// 新回合时重置流式游标与 token 计数
  void resetTurnState() {
    streamingIndex = -1;
    streamingText = '';
    thinkingContent = '';
    streamingProtoId = null;
    lastInputTokens = 0;
    lastOutputTokens = 0;
  }

  /// 合并权威消息批次（session/messages 响应，已按时间序归一）：
  /// - protoId 命中现有条目 → 原位替换（工具状态/内容更新）；
  /// - 未命中 → 先尝试消解尾部未同步（synced == false）的本地条目
  ///   （同角色；user 还要求同文本），原位替换并采纳 protoId；
  /// - 否则追加到尾部。
  void mergeAuthoritative(List<ZcodeSessionItem> incoming) {
    if (incoming.isEmpty) return;
    // 现有 protoId → 下标
    final byProto = <String, int>{};
    for (var i = 0; i < items.length; i++) {
      final id = items[i].protoId;
      if (id != null) byProto[id] = i;
    }
    // 尾部未同步（本地乐观/流式占位）条目的起始下标。
    // 注意：占位即使采纳了 assistantMessageId 也仍是未同步（服务端
    // 尚未在权威列表中返回它），不能以 protoId 判定同步边界。
    var localRunStart = items.length;
    while (localRunStart > 0 && !items[localRunStart - 1].synced) {
      localRunStart--;
    }
    for (final inc in incoming) {
      final id = inc.protoId;
      final existingIdx = id == null ? null : byProto[id];
      if (existingIdx != null) {
        items[existingIdx] = inc; // 原位替换，保留位置
        _consumeStreamingAt(existingIdx);
        continue;
      }
      var reconciled = false;
      final role = inc.message.role;
      for (var i = items.length - 1; i >= localRunStart; i--) {
        final it = items[i];
        if (!it.synced &&
            it.message.role == role &&
            (role != MessageRole.user ||
                it.message.content == inc.message.content)) {
          items[i] = inc; // 消解本地乐观条目
          _consumeStreamingAt(i);
          reconciled = true;
          break;
        }
      }
      if (!reconciled) items.add(inc);
    }
  }

  /// 权威数据替换了流式占位所在下标时消费占位游标：
  /// 占位已被服务端版本取代，后续 finalizeStreaming 不得再覆写该条目
  void _consumeStreamingAt(int index) {
    if (index == streamingIndex) streamingIndex = -1;
  }

  /// 头部插入截断提示（降级路径使用 resume 的 messages 数组且被
  /// companion 截断时，与旧版行为一致）
  void insertHeadNotice(ChatMessage message) {
    items.insert(0, ZcodeSessionItem(message: message));
  }
}
