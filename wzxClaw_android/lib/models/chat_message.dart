// ============================================================
// chat_message — ZCode canonical timeline 消息模型
//
// 硬切换版（2026-09-18 定）：只有 user / assistant 两类消息；assistant
// 的全部可见内容是按引擎原序排列的 processParts（text / reasoning /
// tool / marker）。没有正文平铺字段、没有 role==tool、没有独立
// toolCalls 列表——旧模型已删除，不做兼容。
// ============================================================

/// 消息主体：user 发言或 assistant 产出（后者承载过程行）
enum MessageRole { user, assistant }

/// 工具调用的可见终态（实时生命周期走 [ToolCallInfo.lifecycle]）
enum ToolCallStatus { running, done, error }

/// 过程行种类。
/// marker 保留 step-start / step-finish 及尚未具备展示策略的协议类型，
/// 使其不会在持久化或权威回填时静默消失。
enum ChatProcessPartKind { text, reasoning, tool, marker }

/// 单个工具调用。同一 toolCallId 的整个生命周期共享一个实例投影：
/// scheduled → started → progress* → result/batch 原位更新，不另起行。
class ToolCallInfo {
  final String toolCallId;
  final String toolName;
  final String? inputSummary;
  final String? outputSummary;
  final ToolCallStatus status;
  final bool isError;

  /// 全量输入/输出。运行时保留完整值；本地缓存按容量上限持久化。
  /// 工具行二级展开（diff/命令输出原文）的数据源。
  final String? inputFull;
  final String? outputFull;

  /// app-server 实时生命周期：scheduled / started / progress / result /
  /// batch / input_streaming / permission_requested / permission_denied 等。
  final String? lifecycle;
  final int? elapsedMs;
  final DateTime? startedAt;
  final int? parallelGroupIndex;
  final bool canRunParallel;

  /// Agent/子智能体工具的关联元数据。childToolCallId 在父会话中已被
  /// 引擎 namespaced 为 toolCallId，仍保留 parent/source 以便嵌套展示。
  final String? subagentType;
  final String? childSessionId;
  final String? parentToolCallId;
  final String? source;
  final String? agentId;
  final bool background;
  final String? description;

  /// 引擎结果声明输出被截断时为 true。
  final bool outputTruncated;

  /// 同 callId 生命周期内曾见过错误（先败后成 = 已重试恢复）。
  /// 实时投影 OR 累积并随缓存持久化；权威数据只有终态，尽力而为。
  final bool everError;

  const ToolCallInfo({
    required this.toolCallId,
    required this.toolName,
    this.inputSummary,
    this.outputSummary,
    this.status = ToolCallStatus.running,
    this.isError = false,
    this.inputFull,
    this.outputFull,
    this.lifecycle,
    this.elapsedMs,
    this.startedAt,
    this.parallelGroupIndex,
    this.canRunParallel = false,
    this.subagentType,
    this.childSessionId,
    this.parentToolCallId,
    this.source,
    this.agentId,
    this.background = false,
    this.description,
    this.outputTruncated = false,
    this.everError = false,
  });

  ToolCallInfo copyWith({
    String? toolName,
    String? inputSummary,
    String? outputSummary,
    ToolCallStatus? status,
    bool? isError,
    String? inputFull,
    String? outputFull,
    String? lifecycle,
    int? elapsedMs,
    DateTime? startedAt,
    int? parallelGroupIndex,
    bool? canRunParallel,
    String? subagentType,
    String? childSessionId,
    String? parentToolCallId,
    String? source,
    String? agentId,
    bool? background,
    String? description,
    bool? outputTruncated,
    bool? everError,
  }) =>
      ToolCallInfo(
        toolCallId: toolCallId,
        toolName: toolName ?? this.toolName,
        inputSummary: inputSummary ?? this.inputSummary,
        outputSummary: outputSummary ?? this.outputSummary,
        status: status ?? this.status,
        isError: isError ?? this.isError,
        inputFull: inputFull ?? this.inputFull,
        outputFull: outputFull ?? this.outputFull,
        lifecycle: lifecycle ?? this.lifecycle,
        elapsedMs: elapsedMs ?? this.elapsedMs,
        startedAt: startedAt ?? this.startedAt,
        parallelGroupIndex: parallelGroupIndex ?? this.parallelGroupIndex,
        canRunParallel: canRunParallel ?? this.canRunParallel,
        subagentType: subagentType ?? this.subagentType,
        childSessionId: childSessionId ?? this.childSessionId,
        parentToolCallId: parentToolCallId ?? this.parentToolCallId,
        source: source ?? this.source,
        agentId: agentId ?? this.agentId,
        background: background ?? this.background,
        description: description ?? this.description,
        outputTruncated: outputTruncated ?? this.outputTruncated,
        everError: everError ?? this.everError,
      );

  Map<String, dynamic> toJson() => {
        'toolCallId': toolCallId,
        'toolName': toolName,
        if (inputSummary != null) 'inputSummary': inputSummary,
        if (outputSummary != null) 'outputSummary': outputSummary,
        if (inputFull != null) 'inputFull': inputFull,
        if (outputFull != null) 'outputFull': outputFull,
        'status': status.name,
        'isError': isError,
        if (lifecycle != null) 'lifecycle': lifecycle,
        if (elapsedMs != null) 'elapsedMs': elapsedMs,
        if (startedAt != null) 'startedAt': startedAt!.millisecondsSinceEpoch,
        if (parallelGroupIndex != null)
          'parallelGroupIndex': parallelGroupIndex,
        if (canRunParallel) 'canRunParallel': true,
        if (subagentType != null) 'subagentType': subagentType,
        if (childSessionId != null) 'childSessionId': childSessionId,
        if (parentToolCallId != null) 'parentToolCallId': parentToolCallId,
        if (source != null) 'source': source,
        if (agentId != null) 'agentId': agentId,
        if (background) 'background': true,
        if (description != null) 'description': description,
        if (outputTruncated) 'outputTruncated': true,
        if (everError) 'everError': true,
      };

  factory ToolCallInfo.fromJson(Map<String, dynamic> json) {
    final rawStartedAt = json['startedAt'];
    final startedAtMs = rawStartedAt is num
        ? rawStartedAt.toInt()
        : int.tryParse(rawStartedAt?.toString() ?? '');
    final rawElapsedMs = json['elapsedMs'];
    final rawParallelGroupIndex = json['parallelGroupIndex'];
    return ToolCallInfo(
      toolCallId: json['toolCallId'] as String? ?? '',
      toolName: json['toolName'] as String? ?? '',
      inputSummary: json['inputSummary'] as String?,
      outputSummary: json['outputSummary'] as String?,
      status: ToolCallStatus.values
          .byName(json['status'] as String? ?? ToolCallStatus.running.name),
      isError: json['isError'] as bool? ?? false,
      inputFull: json['inputFull'] as String?,
      outputFull: json['outputFull'] as String?,
      lifecycle: json['lifecycle'] as String?,
      elapsedMs: rawElapsedMs is num
          ? rawElapsedMs.toInt()
          : int.tryParse(rawElapsedMs?.toString() ?? ''),
      startedAt: startedAtMs == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(startedAtMs),
      parallelGroupIndex: rawParallelGroupIndex is num
          ? rawParallelGroupIndex.toInt()
          : int.tryParse(rawParallelGroupIndex?.toString() ?? ''),
      canRunParallel: json['canRunParallel'] == true,
      subagentType: json['subagentType'] as String?,
      childSessionId: json['childSessionId'] as String?,
      parentToolCallId: json['parentToolCallId'] as String?,
      source: json['source'] as String?,
      agentId: json['agentId'] as String?,
      background: json['background'] == true,
      description: json['description'] as String?,
      outputTruncated: json['outputTruncated'] == true,
      everError: json['everError'] == true,
    );
  }
}

/// 按引擎原序保存的一个过程行。
class ChatProcessPart {
  const ChatProcessPart._({
    required this.kind,
    this.id,
    this.rawType,
    this.text,
    this.toolCall,
    this.startedAtMs,
    this.closedAtMs,
  });

  const ChatProcessPart.text(String text, {String? id})
      : this._(kind: ChatProcessPartKind.text, id: id, text: text);

  const ChatProcessPart.reasoning(
    String text, {
    String? id,
    int? startedAtMs,
    int? closedAtMs,
  }) : this._(
          kind: ChatProcessPartKind.reasoning,
          id: id,
          text: text,
          startedAtMs: startedAtMs,
          closedAtMs: closedAtMs,
        );

  const ChatProcessPart.tool(ToolCallInfo toolCall, {String? id})
      : this._(
          kind: ChatProcessPartKind.tool,
          id: id,
          toolCall: toolCall,
        );

  const ChatProcessPart.marker(String rawType, {String? id})
      : this._(
          kind: ChatProcessPartKind.marker,
          id: id,
          rawType: rawType,
        );

  final ChatProcessPartKind kind;

  /// 协议 partId（旧运行时字段名为 id）。实时过程项没有服务端 partId
  /// 时可为空；权威回填后总是有值。
  final String? id;

  /// marker 的原始协议类型。正文/思考/工具保持 null，避免伪造类型。
  final String? rawType;
  final String? text;
  final ToolCallInfo? toolCall;

  /// 分段起点（毫秒墙钟，实时流式期间本地记录）。思考耗时的分子：
  /// 「思考 · 持续了 N 秒」= closedAtMs − startedAtMs；运行中随心跳
  /// 用当前时间滚算。权威回填的分段无本地时间 → null（只显示「思考」）。
  final int? startedAtMs;

  /// 分段闭合时间（后续不同类 part 插入或回合终结核销；仅思考分段使用）
  final int? closedAtMs;

  ChatProcessPart copyWith({
    String? text,
    ToolCallInfo? toolCall,
    int? startedAtMs,
    int? closedAtMs,
  }) =>
      ChatProcessPart._(
        kind: kind,
        id: id,
        rawType: rawType,
        text: text ?? this.text,
        toolCall: toolCall ?? this.toolCall,
        startedAtMs: startedAtMs ?? this.startedAtMs,
        closedAtMs: closedAtMs ?? this.closedAtMs,
      );

  Map<String, dynamic> toJson() => {
        'kind': kind.name,
        if (id != null) 'id': id,
        if (rawType != null) 'rawType': rawType,
        if (text != null) 'text': text,
        if (toolCall != null) 'toolCall': toolCall!.toJson(),
        if (startedAtMs != null) 'startedAtMs': startedAtMs,
        if (closedAtMs != null) 'closedAtMs': closedAtMs,
      };

  factory ChatProcessPart.fromJson(Map<String, dynamic> json) {
    final kind = switch (json['kind']?.toString()) {
      'reasoning' => ChatProcessPartKind.reasoning,
      'tool' => ChatProcessPartKind.tool,
      'marker' => ChatProcessPartKind.marker,
      _ => ChatProcessPartKind.text,
    };
    final rawToolCall = json['toolCall'];
    int? msOf(Object? v) => v is num
        ? v.toInt()
        : int.tryParse(v?.toString() ?? '');
    return ChatProcessPart._(
      kind: kind,
      id: json['id']?.toString(),
      rawType: json['rawType']?.toString(),
      text: json['text']?.toString(),
      toolCall: rawToolCall is Map
          ? ToolCallInfo.fromJson(Map<String, dynamic>.from(rawToolCall))
          : null,
      startedAtMs: msOf(json['startedAtMs']),
      closedAtMs: msOf(json['closedAtMs']),
    );
  }
}

/// Token usage for a completed turn.
class TokenUsage {
  final int inputTokens;
  final int outputTokens;

  const TokenUsage({required this.inputTokens, required this.outputTokens});
}

class ChatMessage {
  final int? id;

  /// 运行时行号（缓存自增 id 回填；仅诊断用，不参与排序/身份）
  final MessageRole role;
  final List<ChatProcessPart> processParts;
  final DateTime createdAt;
  final bool isStreaming;
  final TokenUsage? usage;
  final String? model;

  /// 协议消息 id（app-server info.id / 流式 assistantMessageId）。
  /// 视图身份镜像：权威合并前后同 id → 同一块身份（item.protoId 是同步层
  /// 权威，这里只是渲染层的镜像，二者由同步层写入时保持一致）。
  final String? protoId;

  /// 产出该消息的 agent（引擎 info.agent；null / 'zcode-agent' = 主时间线）
  final String? agent;

  /// 本回合耗时（turn.completed duration 毫秒）→「已工作 X 分 X 秒」。
  final int? durationMs;

  /// 终端错误种类（仅运行时）。'model-unavailable' = 模型不可用且自动
  /// 自愈失败；UI 据此渲染「选择可用模型重试 / 新建会话」操作卡片。
  final String? errorKind;

  ChatMessage({
    this.id,
    required this.role,
    this.processParts = const [],
    required this.createdAt,
    this.isStreaming = false,
    this.usage,
    this.model,
    this.protoId,
    this.agent,
    this.durationMs,
    this.errorKind,
  });

  /// 正文 = 全部 text part 顺序拼接。user 消息恒为单个 text part。
  String get text => processParts
      .where((part) => part.kind == ChatProcessPartKind.text)
      .map((part) => part.text ?? '')
      .join();

  /// 主 agent 名（引擎实测 zcode-agent）；null 视为主时间线
  bool get isSubagentMessage =>
      agent != null && agent!.isNotEmpty && agent != 'zcode-agent';

  /// 桌面端注入给 agent 的系统提醒会以 user-role 入库（<system-reminder>
  /// 包裹或裸 TodoWrite 提醒），聊天 UI 不应把它们当成用户消息展示。
  bool get isSystemInjected {
    final body = text.trimLeft();
    if (body.startsWith('<system-reminder>') || body.startsWith('[System]')) {
      return true;
    }
    if (body.startsWith("The TodoWrite tool hasn't been used recently")) {
      return true;
    }
    if (body
        .contains('This is a gentle reminder - ignore if not applicable.')) {
      return true;
    }
    return false;
  }

  /// 协调器注入的子智能体回报信封（<subagent-message>…</subagent-message>
  /// user-role 消息）：是机器注入的内部消息，不是用户说的话——绝不能
  /// 渲染成用户气泡（官方在子智能体 UI 里呈现，不混进主对话）。
  bool get isSubagentReport => text.trimLeft().startsWith('<subagent-message');

  /// 是否存在可渲染内容（marker 不算——只有 step 边界的消息视觉为空）
  bool get hasVisibleContent =>
      processParts.any((part) => part.kind != ChatProcessPartKind.marker);

  /// 空助手行不展示；流式占位例外（isStreaming 的空行是活消息）。
  bool get isEmptyAssistant =>
      role == MessageRole.assistant && !hasVisibleContent && !isStreaming;

  ChatMessage copyWith({
    int? id,
    List<ChatProcessPart>? processParts,
    bool? isStreaming,
    TokenUsage? usage,
    String? model,
    String? protoId,
    String? agent,
    int? durationMs,
    String? errorKind,
  }) =>
      ChatMessage(
        id: id ?? this.id,
        role: role,
        processParts: processParts ?? this.processParts,
        createdAt: createdAt,
        isStreaming: isStreaming ?? this.isStreaming,
        usage: usage ?? this.usage,
        model: model ?? this.model,
        protoId: protoId ?? this.protoId,
        agent: agent ?? this.agent,
        durationMs: durationMs ?? this.durationMs,
        errorKind: errorKind ?? this.errorKind,
      );
}
