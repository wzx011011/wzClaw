import 'dart:convert';

enum MessageRole { user, assistant, tool }

enum ToolCallStatus { running, done, error }

/// A single tool call within an assistant turn.
class ToolCallInfo {
  final String toolCallId;
  final String toolName;
  final String? inputSummary;
  final String? outputSummary;
  final ToolCallStatus status;
  final bool isError;

  const ToolCallInfo({
    required this.toolCallId,
    required this.toolName,
    this.inputSummary,
    this.outputSummary,
    this.status = ToolCallStatus.running,
    this.isError = false,
  });

  ToolCallInfo copyWith({
    String? outputSummary,
    ToolCallStatus? status,
    bool? isError,
  }) =>
      ToolCallInfo(
        toolCallId: toolCallId,
        toolName: toolName,
        inputSummary: inputSummary,
        outputSummary: outputSummary ?? this.outputSummary,
        status: status ?? this.status,
        isError: isError ?? this.isError,
      );

  Map<String, dynamic> toJson() => {
        'toolCallId': toolCallId,
        'toolName': toolName,
        if (inputSummary != null) 'inputSummary': inputSummary,
        if (outputSummary != null) 'outputSummary': outputSummary,
        'status': status.name,
        'isError': isError,
      };

  factory ToolCallInfo.fromJson(Map<String, dynamic> json) => ToolCallInfo(
        toolCallId: json['toolCallId'] as String? ?? '',
        toolName: json['toolName'] as String? ?? '',
        inputSummary: json['inputSummary'] as String?,
        outputSummary: json['outputSummary'] as String?,
        status: ToolCallStatus.values.byName(json['status'] as String? ?? ToolCallStatus.running.name),
        isError: json['isError'] as bool? ?? false,
      );
}

/// Token usage for a completed turn.
class TokenUsage {
  final int inputTokens;
  final int outputTokens;

  const TokenUsage({required this.inputTokens, required this.outputTokens});
}

class ChatMessage {
  final int? id;
  final MessageRole role;
  final String content;
  final String? toolName;
  final ToolCallStatus? toolStatus;
  final DateTime createdAt;
  final bool isStreaming;

  // Phase 4 additions
  final List<ToolCallInfo>? toolCalls;
  final TokenUsage? usage;
  final String? toolCallId;
  final String? toolInput;
  final String? toolOutput;
  final String? toolResultSummary;
  final String? model;

  ChatMessage({
    this.id,
    required this.role,
    required this.content,
    this.toolName,
    this.toolStatus,
    required this.createdAt,
    this.isStreaming = false,
    this.toolCalls,
    this.usage,
    this.toolCallId,
    this.toolInput,
    this.toolOutput,
    this.toolResultSummary,
    this.model,
  });

  ChatMessage copyWith({
    int? id,
    String? content,
    ToolCallStatus? toolStatus,
    bool? isStreaming,
    List<ToolCallInfo>? toolCalls,
    TokenUsage? usage,
    String? toolOutput,
    String? toolResultSummary,
    String? model,
  }) =>
      ChatMessage(
        id: id ?? this.id,
        role: role,
        content: content ?? this.content,
        toolName: toolName,
        toolStatus: toolStatus ?? this.toolStatus,
        createdAt: createdAt,
        isStreaming: isStreaming ?? this.isStreaming,
        toolCalls: toolCalls ?? this.toolCalls,
        usage: usage ?? this.usage,
        toolCallId: toolCallId,
        toolInput: toolInput,
        toolOutput: toolOutput ?? this.toolOutput,
        toolResultSummary: toolResultSummary ?? this.toolResultSummary,
        model: model ?? this.model,
      );

  Map<String, dynamic> toDbMap() => {
        'role': role.name,
        'content': content,
        'tool_name': toolName,
        'tool_status': toolStatus?.name,
        'created_at': createdAt.millisecondsSinceEpoch,
        'tool_call_id': toolCallId,
        'tool_input': toolInput,
        'tool_output': toolOutput,
        'tool_result_summary': toolResultSummary,
        'tool_calls_json': toolCalls != null
            ? jsonEncode(toolCalls!.map((t) => t.toJson()).toList())
            : null,
        'input_tokens': usage?.inputTokens,
        'output_tokens': usage?.outputTokens,
      };

  factory ChatMessage.fromDbMap(Map<String, dynamic> map) {
    List<ToolCallInfo>? toolCalls;
    final toolCallsJson = map['tool_calls_json'] as String?;
    if (toolCallsJson != null) {
      final list = jsonDecode(toolCallsJson) as List;
      toolCalls = list
          .map((e) => ToolCallInfo.fromJson(e as Map<String, dynamic>))
          .toList();
    }

    TokenUsage? usage;
    final inTok = map['input_tokens'] as int?;
    final outTok = map['output_tokens'] as int?;
    if (inTok != null && outTok != null) {
      usage = TokenUsage(inputTokens: inTok, outputTokens: outTok);
    }

    return ChatMessage(
      id: map['id'] as int?,
      role: _parseRole(map['role']),
      content: map['content'] as String,
      toolName: map['tool_name'] as String?,
      toolStatus: map['tool_status'] != null
          ? _parseToolStatus(map['tool_status'])
          : null,
      createdAt:
          DateTime.fromMillisecondsSinceEpoch(map['created_at'] as int),
      toolCallId: map['tool_call_id'] as String?,
      toolInput: map['tool_input'] as String?,
      toolOutput: map['tool_output'] as String?,
      toolResultSummary: map['tool_result_summary'] as String?,
      toolCalls: toolCalls,
      usage: usage,
    );
  }

  /// Parse role from DB — supports both new (name string) and legacy (int index) formats.
  static MessageRole _parseRole(dynamic value) {
    if (value is int) return MessageRole.values[value];
    if (value is String) {
      return MessageRole.values.byName(value);
    }
    return MessageRole.user;
  }

  /// Parse tool status from DB — supports both new (name string) and legacy (int index) formats.
  static ToolCallStatus _parseToolStatus(dynamic value) {
    if (value is int) return ToolCallStatus.values[value];
    if (value is String) {
      return ToolCallStatus.values.byName(value);
    }
    return ToolCallStatus.running;
  }
}
