import 'dart:convert';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';
import 'streaming_shimmer.dart';

/// ── 回合块（Turn Block）视图模型与渲染 ─────────────────────────────
/// 设计冻结版见 .planning/PLAN-turn-block.md / docs/turn-block-mockup.html。
/// 文档流范式：无框无线；回合头常显（运行中转圈 / 完成总时长 + 中文动词
/// 计数）；过程（思考/工具行）可折叠且正文永显；工具行二级展开；块尾
/// 复制/下载/全文按钮。

/// ── 工具家族分类（官方 chat.toolCall.kind.* + RLt 分组对齐）────────
/// 家族决定种类标签（shell→终端、read→读取、search→搜索、write→写入、
/// edit→编辑、message→消息，其余=工具名）；查阅桶决定查阅组成员资格；
/// terminalGroupable 决定终端组成员资格（非白名单且有命令的 shell）。
enum _ToolFamily { shell, read, search, write, edit, message, other }

class _ToolClass {
  const _ToolClass(this.family, {this.bucket, this.terminalGroupable = false});
  final _ToolFamily family;

  /// 查阅组成员资格与桶（null = 非查阅成员）
  final _ExploreBucket? bucket;

  /// 终端组成员资格（非白名单且有命令的 shell）
  final bool terminalGroupable;
}

/// 分组运行类型
enum _RunKind { explore, terminal }

enum _ExploreBucket { search, list, file }

/// 只读 shell 白名单（官方 mLt：wc/ls/grep/rg 族；含分桶正则里的 find/tree/dir）
const _readOnlyShellCommands = {
  'wc', 'ls', 'grep', 'rg', 'ripgrep', 'find', 'tree', 'dir',
};

final _searchCmdRE = RegExp(
  r'(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)',
  caseSensitive: false,
);
final _listCmdRE = RegExp(
  r'(^|\s)(ls|find|tree|dir)(\s|$)',
  caseSensitive: false,
);

/// 提取 shell 命令本体（结构化输入 JSON 的 command/cmd/script）
String? _shellCommand(String? input) {
  final parsed = _tryParseInputObject(input);
  if (parsed == null) return null;
  for (final key in ['command', 'cmd', 'script']) {
    final v = parsed[key];
    if (v is String && v.trim().isNotEmpty) return v.trim();
  }
  return null;
}

/// 只读判定：无重定向/输入重定向，且 && || ; 分隔的每段首命令都在白名单内
bool _isReadOnlyShell(String cmd) {
  if (RegExp(r'>{1,2}').hasMatch(cmd) || cmd.contains('<')) return false;
  for (final segment in cmd.split(RegExp(r'&&|\|\||;'))) {
    final tokens = segment.trim().split(RegExp(r'\s+'));
    if (tokens.isEmpty || tokens.first.isEmpty) continue;
    if (!_readOnlyShellCommands.contains(tokens.first.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/// 白名单只读 shell 的查阅桶；非白名单返回 null（进终端组资格）
_ExploreBucket? _exploreShellBucket(String cmd) {
  if (!_isReadOnlyShell(cmd)) return null;
  if (_searchCmdRE.hasMatch(cmd)) return _ExploreBucket.search;
  if (_listCmdRE.hasMatch(cmd)) return _ExploreBucket.list;
  return _ExploreBucket.file;
}

/// 解析结构化输入 JSON；非对象返回 null
Map<String, dynamic>? _tryParseInputObject(String? input) {
  final raw = input?.trim() ?? '';
  if (!raw.startsWith('{')) return null;
  try {
    final decoded = jsonDecode(raw);
    return decoded is Map<String, dynamic> ? decoded : null;
  } catch (_) {
    return null;
  }
}

/// 家族 + 分组资格分类。消息卡按输入结构识别（to + message/summary，
/// 官方 kind local_agent_message），不认工具名。
_ToolClass _classifyTool(String toolName, String? input) {
  final parsed = _tryParseInputObject(input);
  if (parsed != null &&
      parsed['to'] is String &&
      (parsed['message'] is String || parsed['summary'] is String)) {
    return const _ToolClass(_ToolFamily.message);
  }
  switch (toolName) {
    case 'Bash':
    case 'ShellExecute':
    case 'shell':
      final cmd = _shellCommand(input);
      if (cmd == null || cmd.isEmpty) {
        // 空参数（流式占位）：两边都不进组，单行「终端」
        return const _ToolClass(_ToolFamily.shell);
      }
      if (RegExp(r'>{1,2}').hasMatch(cmd) || cmd.contains('<')) {
        return const _ToolClass(_ToolFamily.shell, terminalGroupable: true);
      }
      final bucket = _exploreShellBucket(cmd);
      if (bucket != null) {
        return _ToolClass(_ToolFamily.shell, bucket: bucket);
      }
      return const _ToolClass(_ToolFamily.shell, terminalGroupable: true);
    case 'Read':
    case 'FileRead':
    case 'file-read':
      return const _ToolClass(_ToolFamily.read, bucket: _ExploreBucket.file);
    case 'Grep':
    case 'WebSearch':
    case 'web-search':
      return const _ToolClass(_ToolFamily.search, bucket: _ExploreBucket.search);
    case 'Glob':
      // family 归属官方未钉：按「其余=工具名」落标签；分组按文件桶进查阅
      return const _ToolClass(_ToolFamily.other, bucket: _ExploreBucket.file);
    case 'Write':
    case 'FileWrite':
    case 'file-write':
      // 官方把 file-write 归「编辑」标签；我们保留写入/±行数/下载（有意超越）
      return const _ToolClass(_ToolFamily.write);
    case 'Edit':
    case 'FileEdit':
    case 'ApplyPatch':
    case 'file-edit':
      return const _ToolClass(_ToolFamily.edit);
    default:
      return const _ToolClass(_ToolFamily.other);
  }
}

/// 种类标签（运行中换动作文案；动作文案 UI 侧挂渐变扫光）
String _familyLabel(_ToolClass cls, String toolName, {required bool running}) {
  switch (cls.family) {
    case _ToolFamily.shell:
      return running ? '正在执行' : '终端';
    case _ToolFamily.read:
      return running ? '正在读取' : '读取';
    case _ToolFamily.search:
      return running ? '正在搜索' : '搜索';
    case _ToolFamily.write:
      return '写入';
    case _ToolFamily.edit:
      return running ? '编辑' : '已编辑';
    case _ToolFamily.message:
      return running ? '正在发送消息' : '消息';
    case _ToolFamily.other:
      if (toolName == 'WebFetch' || toolName == 'web-fetch') return '获取';
      if (toolName == 'TaskOutput') return '任务输出';
      if (toolName.startsWith('mcp__')) return _mcpToolLabel(toolName);
      return toolName;
  }
}

/// MCP 工具名美化：mcp__<server>__<tool> → '<server> · <tool>'
/// （裸名又长又带双下划线，官方按 server 分组展示）
String _mcpToolLabel(String name) {
  final parts = name.split('__');
  if (parts.length >= 3 && parts[1].isNotEmpty) {
    return '${parts[1]} · ${parts.sublist(2).join('_')}';
  }
  return name;
}

/// 运行态动作词（组行「查阅 · 正在读取 x.dart」用）
String _runningAction(_ToolFamily family) => switch (family) {
      _ToolFamily.shell => '执行',
      _ToolFamily.read => '读取',
      _ToolFamily.search => '搜索',
      _ => '',
    };


/// 过程部件种类。全部来自权威 processParts 的直接投影。
enum TurnPartKind { thinking, tool, text, agent, message }

/// 消息卡数据（发给子智能体的 SendMessage，官方 aFt 对齐：
/// 标题=摘要，dl = 目标子智能体(to)/摘要/消息）
class TurnMessageData {
  const TurnMessageData({
    required this.to,
    this.summary,
    this.body,
    this.running = false,
    this.failed = false,
    this.details = const [],
  });

  /// 目标子智能体标识（输入 to 字段）
  final String to;
  final String? summary;
  final String? body;
  final bool running;
  final bool failed;

  /// 展开详情（完整输入/输出原文行）
  final List<TurnDetailLine> details;
}

/// 工具行数据（聚合后的展示单元）
class TurnToolRow {
  const TurnToolRow({
    required this.verb,
    required this.target,
    this.dir,
    this.add,
    this.del,
    this.count,
    this.running = false,
    this.elapsed,
    this.failed = false,
    this.recovered = false,
    this.details = const [],
    this.subagentType,
    this.lifecycle,
    this.filePath,
    this.memberRows,
    this.statusNote,
  });

  /// 中文动词：查阅/执行/写入/读取/搜索/文件/列表
  final String verb;

  /// 目标：文件末段、命令摘要，或聚合计数「2 搜索，1 列表」，
  /// 或组运行态摘要「正在读取 x.dart」
  final String target;

  /// Write 家族的目标文件完整路径（手机端「下载到手机」入口数据源；
  /// 其他工具/聚合行为 null）
  final String? filePath;

  /// 目录（弱化灰字，可空）
  final String? dir;

  /// 行数增减（Edit 可算时非空）
  final int? add;
  final int? del;

  /// 聚合计数（查阅/终端聚合行非空）
  final int? count;

  final bool running;
  final Duration? elapsed;
  final bool failed;

  /// 失败后重试成功过（显示「已重试恢复」）
  final bool recovered;

  /// 二级展开的详情行（diff/命令输出，纯文本行）。组行（查阅伞）
  /// 不挂详情——二级是 [memberRows]，成员行各自挂详情。
  final List<TurnDetailLine> details;

  /// 组行的成员行（查阅伞展开后的逐成员列表；null = 普通单行）。
  /// 成员行是完整的工具行：各自独立展开输入/输出详情。
  final List<TurnToolRow>? memberRows;

  /// Agent 的 subagent_type（Explore/general-purpose 等）；非 Agent 工具为 null。
  final String? subagentType;

  /// 实时生命周期的短状态，用于等待权限/参数流入等尚未形成结果的阶段。
  final String? lifecycle;

  /// 行尾弱化状态注（如 TaskOutput 的「已获取」——官方同位渲染）。
  /// null = 无
  final String? statusNote;
}

class TurnDetailLine {
  const TurnDetailLine(this.text, {this.kind = DetailLineKind.dim});
  final String text;
  final DetailLineKind kind;
}

enum DetailLineKind { dim, add, del, cmd }

/// 思考行数据
class TurnThinkData {
  const TurnThinkData({
    this.duration,
    required this.content,
    this.running = false,
  });

  /// 时长（运行中为已持续时长；完成后的回合可能未知 → null 只显示「思考」）
  final Duration? duration;
  final String content;
  final bool running;
}

/// 子智能体过程行。显式 Agent 调用和 info.agent 产出的子会话消息都会
/// 映射成此行，但不会把后续子消息从父回合时间线中抽离。
class TurnAgentData {
  const TurnAgentData({
    required this.agentType,
    required this.target,
    this.running = false,
    this.failed = false,
    this.details = const [],
    this.toolCallId,
  });

  final String agentType;
  final String target;
  final bool running;
  final bool failed;
  final List<TurnDetailLine> details;

  /// 父回合的工具调用 ID：session/subagents 按 toolCallId 关联
  /// childSessionId（probe-subagents-map 钉死）——子会话面板入口钥匙。
  /// info.agent 内联子消息无此 ID → null（不提供面板入口）。
  final String? toolCallId;
}

/// 过程部件
class TurnPart {
  const TurnPart.think(TurnThinkData data, {this.key})
      : kind = TurnPartKind.thinking,
        think = data,
        tool = null,
        agent = null,
        text = null,
        message = null;
  const TurnPart.tool(TurnToolRow data, {this.key})
      : kind = TurnPartKind.tool,
        think = null,
        tool = data,
        agent = null,
        text = null,
        message = null;
  const TurnPart.text(String content, {this.key})
      : kind = TurnPartKind.text,
        think = null,
        tool = null,
        agent = null,
        text = content,
        message = null;
  const TurnPart.agent(TurnAgentData data, {this.key})
      : kind = TurnPartKind.agent,
        think = null,
        tool = null,
        agent = data,
        text = null,
        message = null;
  const TurnPart.message(TurnMessageData data, {this.key})
      : kind = TurnPartKind.message,
        think = null,
        tool = null,
        agent = null,
        text = null,
        message = data;

  final TurnPartKind kind;
  final String? key;
  final TurnThinkData? think;
  final TurnToolRow? tool;
  final TurnAgentData? agent;
  final TurnMessageData? message;
  final String? text;
}

/// 首字延迟文案：`首字 1.8s`（<10s 一位小数）/ `首字 21s`（≥10s 整数秒）
String formatTtft(int ms) {
  if (ms < 10000) return '首字 ${(ms / 1000).toStringAsFixed(1)}s';
  return '首字 ${(ms / 1000).round()}s';
}

/// tok/s 文案：估算加 ≈ 前缀明示（`≈31.6 tok/s`），权威值裸数值
/// （`45.3 tok/s`；≥100 取整避免位数抖动）
String formatTps(double tps, {required bool estimated}) {
  final v = tps >= 100 ? tps.round().toString() : tps.toStringAsFixed(1);
  return '${estimated ? '≈' : ''}$v tok/s';
}

/// 回合视图模型
class TurnVM {
  const TurnVM({
    required this.parts,
    required this.answerMarkdown,
    required this.busy,
    required this.countsLabel,
    this.totalDuration,
    this.firstTokenMs,
    this.tokensPerSecond,
    this.tpsIsEstimate = false,
    this.busyElapsed,
  });

  /// 过程部件（思考/正文/工具/子智能体，按引擎原序）
  final List<TurnPart> parts;

  /// 正文 Markdown（末尾连续可见文本；其余 text 保留在过程位置）
  final String answerMarkdown;

  final bool busy;
  final String countsLabel;
  final Duration? totalDuration;

  /// 首字延迟（毫秒；null = 无数据或首增量未到）
  final int? firstTokenMs;

  /// tok/s（流式中为估算需标 ≈；完成后为权威值）
  final double? tokensPerSecond;

  /// [tokensPerSecond] 是否估算（流式中字符速率换算，非权威 usage）
  final bool tpsIsEstimate;

  /// 运行中已耗时（busy 时头部显示「正在工作… Xs」；完成态用 totalDuration）
  final Duration? busyElapsed;
}

/// 工具调用的内部视图：canonical tool part 归一后的最小展示单元。
class _ToolView {
  const _ToolView({
    required this.name,
    required this.status,
    required this.createdAt,
    this.input,
    this.output,
    this.callId = '',
    this.everError = false,
    this.subagentType,
    this.lifecycle,
  });

  final String name;
  final ToolCallStatus status;
  final String? input;
  final String? output;
  final String callId;
  final DateTime createdAt;
  final String? subagentType;
  final String? lifecycle;

  /// 同 callID 历史上是否失败过（先败后成 = 已重试恢复）
  final bool everError;

  bool get failed => everError && status == ToolCallStatus.error;
  bool get recovered => everError && status != ToolCallStatus.error;
}

/// 从 canonical 消息切片构建 TurnVM（唯一路径）。
/// [messages] = 该回合内按序的 assistant 消息（含 info.agent 子智能体
/// 消息，作为内联 Agent 行保留在原位）；不含用户消息。
TurnVM buildTurnVM(
  List<ChatMessage> messages, {
  required bool busy,
  Duration? totalDuration,
  int? firstTokenMs,
  double? tokensPerSecond,
  bool tpsIsEstimate = false,
  Duration? busyElapsed,
}) {
  final parts = <TurnPart>[];
  final counts = <String, int>{};
  final sequence = <_ProcessSource>[];
  for (final message in messages) {
    if (message.isSubagentMessage) {
      sequence.add(_ProcessSource.agentMessage(message));
      continue;
    }
    for (final part in message.processParts) {
      sequence.add(
        _ProcessSource.part(
          part,
          message.createdAt,
          streaming: message.isStreaming,
        ),
      );
    }
  }

  // 仅把末尾连续可见文本提升为回答区；其余 text 保留在过程位置，
  // 这样 text → tool → text 的相对顺序在展开流程时不会被重排。
  var terminalTextIndex = -1;
  for (var i = sequence.length - 1; i >= 0; i--) {
    final source = sequence[i];
    if (source.kind == _ProcessSourceKind.marker) continue;
    if (source.kind == _ProcessSourceKind.part &&
        source.part?.kind == ChatProcessPartKind.text) {
      terminalTextIndex = i;
    }
    break;
  }
  var answer = '';
  // 分组运行状态（官方 RLt 对齐）：相邻连续同资格成员 ≥2 才成组，任何
  // 非成员行（文字/思考/标记/写入/空命令 shell 等）断组；落单回退种类标签
  _RunKind? runOpen;
  var runMembers = <_ToolView>[];

  void breakAggregate() {
    runOpen = null;
    runMembers = <_ToolView>[];
  }

  /// 查阅组行：成员 = 读取/搜索工具 + 白名单只读 shell；计数半角逗号
  /// 「N 搜索, M 文件」；运行中摘要末个运行成员的动作
  TurnToolRow exploreGroupRow(List<_ToolView> members) {
    final bucketCounts = <_ExploreBucket, int>{};
    _ToolView? trailingRunning;
    for (final member in members) {
      final cls = _classifyTool(member.name, member.input);
      if (cls.bucket != null) {
        bucketCounts[cls.bucket!] = (bucketCounts[cls.bucket!] ?? 0) + 1;
      }
      if (member.status == ToolCallStatus.running) trailingRunning = member;
    }
    final String target;
    if (trailingRunning != null) {
      final cls = _classifyTool(trailingRunning.name, trailingRunning.input);
      target = '· 正在${_runningAction(cls.family)} '
          '${_toolTarget(trailingRunning.name, trailingRunning.input)}';
    } else {
      target = '· ${[
        if ((bucketCounts[_ExploreBucket.search] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.search]} 搜索',
        if ((bucketCounts[_ExploreBucket.list] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.list]} 列表',
        if ((bucketCounts[_ExploreBucket.file] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.file]} 文件',
      ].join(', ')}';
    }
    return TurnToolRow(
      verb: '查阅',
      target: target,
      count: members.length,
      running: trailingRunning != null,
      failed: members.any((member) => member.failed),
      recovered: members.any((member) => member.recovered),
      memberRows: [for (final member in members) _memberRow(member)],
    );
  }

  /// 终端组行：成员 = 非白名单且有命令的 shell；「终端 · N 个命令」
  TurnToolRow terminalGroupRow(List<_ToolView> members) {
    _ToolView? trailingRunning;
    for (final member in members) {
      if (member.status == ToolCallStatus.running) trailingRunning = member;
    }
    final String target;
    if (trailingRunning != null) {
      target = '· 正在执行 '
          '${_toolTarget(trailingRunning.name, trailingRunning.input)}';
    } else {
      target = '· ${members.length} 个命令';
    }
    return TurnToolRow(
      verb: '终端',
      target: target,
      count: members.length,
      running: trailingRunning != null,
      failed: members.any((member) => member.failed),
      recovered: members.any((member) => member.recovered),
      memberRows: [for (final member in members) _memberRow(member)],
    );
  }

  // 组内成员行 _memberRow 为顶层函数（见 _memberDetails 附近）


  /// 单行落发：种类标签（运行中换动作文案，UI 侧挂渐变）
  void emitSingle(_ToolView view, _ToolClass cls) {
    final running = view.status == ToolCallStatus.running;
    final delta = _editLineDelta(view.name, view.input);
    final written = view.status != ToolCallStatus.running && !view.failed
        ? _writtenFilePath(view)
        : null;
    final label = _familyLabel(cls, view.name, running: running);
    // 已完成但输入缺失（0.16.9 偶发）：显式标注而非空白行
    final resolvedTarget = _toolTarget(view.name, view.input);
    final target = resolvedTarget.isEmpty && !running ? '输入未捕获' : resolvedTarget;
    parts.add(
      TurnPart.tool(
        TurnToolRow(
          verb: label,
          target: target,
          add: delta?.$1,
          del: delta?.$2,
          filePath: written,
          running: running,
          failed: view.failed,
          recovered: view.recovered,
          elapsed: running ? DateTime.now().difference(view.createdAt) : null,
          details: _memberDetails(view),
          subagentType: view.subagentType,
          lifecycle: view.lifecycle,
          statusNote: _taskOutputNote(view),
        ),
        key: view.callId.isEmpty ? null : view.callId,
      ),
    );
    var countKey = _familyLabel(cls, view.name, running: false);
    if (countKey == '已编辑') countKey = '编辑';
    counts[countKey] = (counts[countKey] ?? 0) + 1;
  }

  void emitTool(_ToolView view) {
    final cls = _classifyTool(view.name, view.input);
    final isExploreMember = cls.bucket != null;
    final isTerminalMember = cls.bucket == null && cls.terminalGroupable;
    if (isExploreMember || isTerminalMember) {
      final kind = isExploreMember ? _RunKind.explore : _RunKind.terminal;
      if (runOpen != kind) {
        // 开新 run：首成员按单行落发；后续连续成员到来时升级为组
        runOpen = kind;
        runMembers = [view];
        emitSingle(view, cls);
        return;
      }
      runMembers.add(view);
      final row = parts.last.tool!;
      parts[parts.length - 1] = TurnPart.tool(
        isExploreMember
            ? exploreGroupRow(runMembers)
            : terminalGroupRow(runMembers),
        key: row.target,
      );
      if (runMembers.length == 2 && isExploreMember) {
        // 首成员此前按种类标签计数过：成组后并入「查阅」。
        // 终端组单发/成组同标签「终端」，计数无需调整
        final firstCls =
            _classifyTool(runMembers.first.name, runMembers.first.input);
        final firstKey =
            _familyLabel(firstCls, runMembers.first.name, running: false);
        final c = counts[firstKey] ?? 0;
        if (c <= 1) {
          counts.remove(firstKey);
        } else {
          counts[firstKey] = c - 1;
        }
        counts['查阅'] = (counts['查阅'] ?? 0) + 1;
      }
      return;
    }
    // 非成员行：断组 + 普通单行（写入/编辑/获取/空命令 shell/工具名）
    breakAggregate();
    emitSingle(view, cls);
  }

  _ToolView toolViewOf(ChatProcessPart part, DateTime createdAt) {    final tool = part.toolCall!;
    return _ToolView(
      name: tool.toolName,
      status: tool.status,
      input: tool.inputFull ?? tool.inputSummary,
      output: tool.outputFull ?? tool.outputSummary,
      callId: tool.toolCallId,
      createdAt: createdAt,
      everError: tool.everError || tool.isError,
      subagentType: tool.subagentType,
      lifecycle: tool.lifecycle,
    );
  }

  for (var i = 0; i < sequence.length; i++) {
    final source = sequence[i];
    if (source.kind == _ProcessSourceKind.agentMessage) {
      final message = source.message!;
      final detailLines = <TurnDetailLine>[];
      for (final process in message.processParts) {
        if (process.kind == ChatProcessPartKind.text ||
            process.kind == ChatProcessPartKind.reasoning) {
          final body = process.text?.trim();
          if (body != null && body.isNotEmpty) {
            detailLines.add(TurnDetailLine(_capBlock(body)));
          }
        } else if (process.kind == ChatProcessPartKind.tool &&
            process.toolCall != null) {
          detailLines.addAll(
            _memberDetails(toolViewOf(process, message.createdAt)),
          );
        }
      }
      final summary = _singleLine(message.text, 80);
      parts.add(
        TurnPart.agent(
          TurnAgentData(
            agentType: _agentLabel(message.agent),
            target: summary.isEmpty ? '子智能体' : summary,
            running: message.isStreaming,
            failed: message.processParts
                .any((part) => part.toolCall?.isError ?? false),
            details: detailLines,
          ),
          key: message.agent,
        ),
      );
      counts['子智能体'] = (counts['子智能体'] ?? 0) + 1;
      breakAggregate();
      continue;
    }
    if (source.kind == _ProcessSourceKind.marker) {
      breakAggregate();
      continue;
    }
    final process = source.part;
    if (process == null) continue;
    switch (process.kind) {
      case ChatProcessPartKind.text:
        final body = process.text ?? '';
        if (body.trim().isEmpty) continue;
        // 过程中的叙述正文保留全文（评审 #10）：此前截成 157 字摘要且
        // 无法展开，工具调用前后的说明/计划/代码在 UI 中不可获取；
        // 折叠语义由回合收起承担，行内不再二次截断
        if (i == terminalTextIndex) {
          answer = body;
        } else {
          parts.add(
            TurnPart.text(body, key: process.id),
          );
        }
        breakAggregate();
      case ChatProcessPartKind.reasoning:
        final body = process.text ?? '';
        if (body.isNotEmpty) {
          // 分段状态（官方对齐）：只有流式消息尾部的思考段是「正在思考」，
          // 之前的分段已闭合——固定显示自己的持续时长，不再跟着整轮转圈
          final isLiveTail = busy &&
              source.isStreamingMessage &&
              i == sequence.length - 1;
          final started = process.startedAtMs;
          Duration? duration;
          if (started != null) {
            final end =
                process.closedAtMs ?? DateTime.now().millisecondsSinceEpoch;
            duration = Duration(milliseconds: end - started);
          }
          parts.add(
            TurnPart.think(
              TurnThinkData(
                content: body,
                running: isLiveTail,
                duration: duration,
              ),
              key: process.id,
            ),
          );
        }
        breakAggregate();
      case ChatProcessPartKind.tool:
        final tool = process.toolCall;
        if (tool == null) {
          breakAggregate();
          continue;
        }
        // 记账型工具（官方时间线不渲染）：TodoWrite 是任务面板内部簿记、
        // TaskOutput/TaskUpdate 是子智能体输出轮询——渲染出来只会是一行
        // 裸 JSON。跳过且不打断相邻工具分组（官方同形态）
        if (_isBookkeepingTool(tool.toolName)) continue;
        final toolInput = tool.inputFull ?? tool.inputSummary;
        // 消息卡（官方 aFt 对齐）：识别靠输入结构（to + message/summary，
        // kind local_agent_message），不认工具名
        if (_classifyTool(tool.toolName, toolInput).family ==
            _ToolFamily.message) {
          final json = _tryParseInputObject(toolInput) ?? const {};
          parts.add(
            TurnPart.message(
              TurnMessageData(
                to: json['to']?.toString() ?? '',
                summary: json['summary']?.toString(),
                body: json['message']?.toString(),
                running: tool.status == ToolCallStatus.running,
                failed: tool.isError,
                details: _toolDetails(toolViewOf(process, source.createdAt!)),
              ),
              key: process.id ?? tool.toolCallId,
            ),
          );
          counts['消息'] = (counts['消息'] ?? 0) + 1;
          breakAggregate();
          continue;
        }
        // 显式 Agent/Task 工具 → 内联子智能体行；专属工具 → 各自结构行；
        // 其余按普通工具行处理
        if (tool.toolName == 'Agent' || tool.toolName == 'Task') {
          final input = tool.inputFull ?? tool.inputSummary ?? '';
          final view = toolViewOf(process, source.createdAt!);
          parts.add(
            TurnPart.agent(
              TurnAgentData(
                agentType: tool.subagentType ?? '子智能体',
                target: _toolTarget(tool.toolName, input),
                running: tool.status == ToolCallStatus.running,
                failed: tool.isError,
                details: _toolDetails(view),
                toolCallId: tool.toolCallId,
              ),
              key: process.id ?? tool.toolCallId,
            ),
          );
          counts['子智能体'] = (counts['子智能体'] ?? 0) + 1;
        } else {
          // 专属工具行（官方每工具结构卡的行级等价）：清单/任务/技能
          final special = _specialToolRow(tool, toolInput);
          if (special != null) {
            parts.add(special.$1);
            counts[special.$2] = (counts[special.$2] ?? 0) + 1;
            breakAggregate();
          } else {
            emitTool(toolViewOf(process, source.createdAt!));
          }
        }
      case ChatProcessPartKind.marker:
        breakAggregate();
        break;
    }
  }

  final countsLabel =
      counts.entries.map((entry) => '${entry.key} ${entry.value}').join(' · ');
  return TurnVM(
    parts: parts,
    answerMarkdown: answer,
    busy: busy,
    countsLabel: countsLabel,
    totalDuration: totalDuration,
    firstTokenMs: firstTokenMs,
    tokensPerSecond: tokensPerSecond,
    tpsIsEstimate: tpsIsEstimate,
    busyElapsed: busyElapsed,
  );
}

class _ProcessSource {
  _ProcessSource.part(
    ChatProcessPart value,
    this.createdAt, {
    bool streaming = false,
  })  : part = value,
        kind = value.kind == ChatProcessPartKind.marker
            ? _ProcessSourceKind.marker
            : _ProcessSourceKind.part,
        message = null,
        isStreamingMessage = streaming;
  _ProcessSource.agentMessage(ChatMessage value)
      : message = value,
        kind = _ProcessSourceKind.agentMessage,
        part = null,
        createdAt = value.createdAt,
        isStreamingMessage = value.isStreaming;

  final _ProcessSourceKind kind;
  final ChatProcessPart? part;
  final ChatMessage? message;

  /// 所属消息的创建时间（工具行运行计时用）
  final DateTime? createdAt;

  /// 所属消息是否仍在流式（思考分段「正在思考」判定用）
  final bool isStreamingMessage;
}

enum _ProcessSourceKind { part, marker, agentMessage }


/// 记账型工具（官方时间线不渲染）：TodoWrite = 任务面板内部簿记；
/// TaskUpdate = 子智能体状态更新；RespondToCoordinator = 工作流协调器
/// 簿记（回报经 <subagent-message> 卡片呈现）。
/// 注意：TaskOutput 官方是渲染的（「任务输出 <id> 已获取」），不入列。
bool _isBookkeepingTool(String name) =>
    name == 'TodoWrite' ||
    name == 'TaskUpdate' ||
    name == 'RespondToCoordinator';

/// TaskOutput 行尾状态注（官方「任务输出 <id> 已获取」同位渲染）
String? _taskOutputNote(_ToolView view) {
  if (view.name != 'TaskOutput') return null;
  return switch (view.status) {
    ToolCallStatus.running => '获取中',
    ToolCallStatus.error => '获取失败',
    _ => '已获取',
  };
}

/// 查阅/终端组成员行：种类标签（运行中动作文案）+ 目标 + 自身状态与详情
TurnToolRow _memberRow(_ToolView view) {
  final cls = _classifyTool(view.name, view.input);
  final running = view.status == ToolCallStatus.running;
  return TurnToolRow(
    verb: _familyLabel(cls, view.name, running: running),
    target: _toolTarget(view.name, view.input),
    running: running,
    failed: view.failed,
    recovered: view.recovered,
    elapsed: running ? DateTime.now().difference(view.createdAt) : null,
    details: _memberDetails(view),
    lifecycle: view.lifecycle,
  );
}

List<TurnDetailLine> _memberDetails(_ToolView view) {
  final lines = <TurnDetailLine>[_memberLine(view)];
  final input = view.input?.trim();
  if (input != null && input.isNotEmpty) {
    lines.add(
      TurnDetailLine(
        _prettyInput(view.name, input),
        kind: DetailLineKind.cmd,
      ),
    );
  }
  final output = view.output?.trim();
  if (output != null && output.isNotEmpty) {
    lines.add(TurnDetailLine(output));
  }
  return lines;
}

String _agentLabel(String? agent) {
  final value = agent?.trim() ?? '';
  if (value.isEmpty) return '子智能体';
  final pieces = value.split('__');
  return pieces.isEmpty ? value : pieces.last;
}

/// Write 家族工具的目标文件完整路径（手机端「下载到手机」入口数据源）。
/// 结构化解析不到时返回 null（宁可没有入口，不给错路径）。
String? _writtenFilePath(_ToolView view) {
  if (view.name != 'Write' && view.name != 'file-write') return null;
  final raw = view.input?.trim() ?? '';
  if (!raw.startsWith('{')) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, dynamic>) {
      for (final key in ['file_path', 'filePath', 'path']) {
        final v = decoded[key];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
  } catch (_) {}
  return null;
}

/// 工具行目标：按工具类型从输入提取人类可读目标（命令/路径末段/模式/URL）。
/// 结构化字段提取不到时回退原始输入首行的路径末段。
String _toolTarget(String name, String? input) {
  final raw = input?.trim() ?? '';
  // 参数未流入（流式占位）：只显示动词行，不把工具名当目标（「文件Read」）
  if (raw.isEmpty) return '';
  Map<String, dynamic>? json;
  if (raw.startsWith('{')) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {}
  }
  String? pick(List<String> keys) {
    for (final k in keys) {
      final v = json?[k];
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    return null;
  }

  switch (name) {
    case 'Bash':
    case 'ShellExecute':
    case 'shell':
      final cmd = pick(['command', 'cmd', 'script']);
      if (cmd != null) return _singleLine(cmd, 60);
      break;
    case 'Read':
    case 'FileRead':
    case 'file-read':
    case 'Write':
    case 'FileWrite':
    case 'file-write':
    case 'Edit':
    case 'FileEdit':
    case 'ApplyPatch':
    case 'file-edit':
      final path = pick(['file_path', 'filePath', 'path', 'notebook_path']);
      if (path != null) return _lastPathSegment(path);
      break;
    case 'Glob':
      final pattern = pick(['pattern']);
      if (pattern != null) return _singleLine(pattern, 48);
      break;
    case 'Grep':
      final pattern = pick(['pattern']);
      if (pattern != null) return _singleLine(pattern, 40);
      break;
    case 'WebFetch':
    case 'web-fetch':
      final url = pick(['url']);
      if (url != null) return _singleLine(url, 60);
      break;
    case 'WebSearch':
    case 'web-search':
      final query = pick(['query']);
      if (query != null) return _singleLine(query, 40);
      break;
    case 'Agent':
    case 'agent-tool':
    case 'Task':
      final desc = pick(['description', 'agent_type', 'prompt']);
      if (desc != null) return _singleLine(desc, 48);
      break;
    case 'TaskOutput':
      // 官方同形态：目标 = 任务 id（行尾另挂「已获取」状态注）
      final taskId = pick(['task_id']);
      if (taskId != null) return taskId;
      break;
  }
  // 未知工具：结构化提取常见语义键；提取不到退化为纯动词行——原始
  // JSON 留在展开详情里（_prettyInput 会格式化），不再裸奔到行上
  if (json != null) {
    const commonKeys = [
      'task_id',
      'skill',
      'pattern',
      'query',
      'url',
      'file_path',
      'filePath',
      'path',
      'command',
      'cmd',
      'name',
      'description',
    ];
    for (final k in commonKeys) {
      final v = json[k];
      if (v is String && v.trim().isNotEmpty) return _singleLine(v.trim(), 60);
    }
    return '';
  }
  return _lastPathSegment(_singleLine(raw, 60));
}

/// 首行单行化并按显示宽度截断
String _singleLine(String s, int max) {
  final line = s.replaceAll('\r\n', '\n').split('\n').first.trim();
  if (line.length <= max) return line;
  return '${line.substring(0, max)}…';
}

/// Edit 行数增减：old/new 去公共前后缀行后，剩余旧行数 = 删除、
/// 剩余新行数 = 新增（真实行级差异，非两侧全量）。
(int, int)? _editLineDelta(String name, String? input) {
  if (name != 'Edit' &&
      name != 'FileEdit' &&
      name != 'ApplyPatch' &&
      name != 'file-edit') {
    return null;
  }
  final raw = input?.trim() ?? '';
  if (!raw.startsWith('{')) return null;
  Map<String, dynamic>? json;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, dynamic>) json = decoded;
  } catch (_) {
    return null;
  }
  final oldS = json?['old_string'];
  final newS = json?['new_string'];
  if (oldS is! String || newS is! String) return null;
  var oldLines = _textLines(oldS);
  var newLines = _textLines(newS);
  var common = 0;
  while (common < oldLines.length &&
      common < newLines.length &&
      oldLines[common] == newLines[common]) {
    common++;
  }
  oldLines = oldLines.sublist(common);
  newLines = newLines.sublist(common);
  var suffix = 0;
  while (suffix < oldLines.length &&
      suffix < newLines.length &&
      oldLines[oldLines.length - 1 - suffix] ==
          newLines[newLines.length - 1 - suffix]) {
    suffix++;
  }
  if (suffix > 0) {
    oldLines = oldLines.sublist(0, oldLines.length - suffix);
    newLines = newLines.sublist(0, newLines.length - suffix);
  }
  if (newLines.isEmpty && oldLines.isEmpty) return null;
  return (newLines.length, oldLines.length);
}

List<String> _textLines(String s) {
  final parts = s.replaceAll('\r\n', '\n').split('\n');
  if (parts.length > 1 && parts.last.isEmpty) parts.removeLast();
  return parts;
}

/// 二级展开详情：输入（Bash 只展示命令本体；结构化输入美化 JSON）+
/// 输出原文。超长在显示层截断并标注（全量数据仍在消息模型里）。
List<TurnDetailLine> _toolDetails(_ToolView v) {
  final lines = <TurnDetailLine>[];
  final input = v.input?.trim();
  if (input != null && input.isNotEmpty) {
    lines.add(
      TurnDetailLine(
        _capBlock(_prettyInput(v.name, input)),
        kind: DetailLineKind.cmd,
      ),
    );
  }
  final output = v.output?.trim();
  if (output != null && output.isNotEmpty) {
    lines.add(TurnDetailLine(_capBlock(output)));
  }
  return lines;
}

/// 专属工具行：Skill → 技能行（官方语义的干净行）。返回 null = 走通用
/// 工具行。TodoWrite/TaskOutput 属记账型工具（官方时间线不渲染，
/// 见 _isBookkeepingTool），不在此列。
(TurnPart, String)? _specialToolRow(ToolCallInfo tool, String? input) {
  final running = tool.status == ToolCallStatus.running;
  final failed = tool.isError;
  switch (tool.toolName) {
    case 'Skill':
      final parsed = _tryParseInputObject(input) ?? const {};
      final skill = parsed['skill']?.toString() ?? '';
      final args = parsed['args']?.toString();
      final output = (tool.outputFull ?? tool.outputSummary)?.trim();
      final details = <TurnDetailLine>[
        if (args != null && args.trim().isNotEmpty)
          TurnDetailLine(_capBlock(args.trim()), kind: DetailLineKind.cmd),
        if (output != null && output.isNotEmpty)
          TurnDetailLine(_capBlock(output)),
      ];
      return (
        TurnPart.tool(
          TurnToolRow(
            verb: '技能',
            target: _singleLine(skill, 48),
            running: running,
            failed: failed,
            details: details,
          ),
          key: tool.toolCallId.isEmpty ? null : tool.toolCallId,
        ),
        '技能',
      );
    default:
      return null;
  }
}

String _prettyInput(String name, String input) {
  if (name == 'Bash') {
    if (input.startsWith('{')) {
      try {
        final json = jsonDecode(input);
        if (json is Map<String, dynamic> && json['command'] is String) {
          return '\$ ${json['command']}';
        }
      } catch (_) {}
    }
    return '\$ $input';
  }
  if (input.startsWith('{')) {
    try {
      final json = jsonDecode(input);
      if (json is Map<String, dynamic>) {
        return const JsonEncoder.withIndent('  ').convert(json);
      }
    } catch (_) {}
  }
  return input;
}

String _capBlock(String s, [int max = 8000]) {
  final t = s.replaceAll('\r\n', '\n');
  return t.length <= max ? t : '${t.substring(0, max)}…（已截断）';
}

/// 聚合行的成员明细行（展开逐文件/逐命令显示）。已完成成员输入缺失时
/// 显式降级标注（0.16.9 偶发权威 part 缺 state.input），不留视觉空白
TurnDetailLine _memberLine(_ToolView v) {
  final target = _toolTarget(v.name, v.input);
  final display = target.isEmpty && v.status != ToolCallStatus.running
      ? '输入未捕获'
      : target;
  return TurnDetailLine('· $display${v.failed ? '  ⚠' : ''}');
}

String _lastPathSegment(String s) {
  final t = s.replaceAll('\\', '/').trim();
  if (t.isEmpty) return '…';
  final idx = t.lastIndexOf('/');
  return idx >= 0 && idx < t.length - 1 ? t.substring(idx + 1) : t;
}

/// ── 渲染 ──────────────────────────────────────────────────────────

class TurnBlockView extends StatefulWidget {
  const TurnBlockView({
    super.key,
    required this.vm,
    this.defaultCollapsed,
    this.onFoldChanged,
    this.answerBuilder,
    this.onDownloadFile,
    this.onAnswerLongPress,
    this.onOpenSubagent,
  });

  final TurnVM vm;

  /// null = 自动（busy 展开 / 完成折叠）
  final bool? defaultCollapsed;

  /// 用户点击头部切换折叠（宿主按块身份持久化，滚动重建/前插不丢）
  final ValueChanged<bool>? onFoldChanged;

  /// 正文 Markdown 渲染器（宿主传入富渲染；缺省纯文本）。
  /// 第二参 isStreaming = 该回合进行中：宿主应降级为纯文本渲染，
  /// 防半截 markdown 语法裸露与逐 chunk 全量重解析。
  final Widget Function(String markdown, bool isStreaming)? answerBuilder;

  /// Write 工具行「下载到手机」入口（宿主接线下载服务；null 不显示入口）
  final void Function(String path)? onDownloadFile;

  /// 回答区长按（宿主弹操作菜单：复制全文/引用为输入）；
  /// 仅正文非空时生效，参数为回答 markdown 全文
  final void Function(String answerMarkdown)? onAnswerLongPress;

  /// 子智能体行点击 → 打开子会话面板（宿主实现导航）。
  /// 仅带 toolCallId 的 Agent 行可开；null = 无入口（行内展开详情）
  final void Function(TurnAgentData data)? onOpenSubagent;

  @override
  State<TurnBlockView> createState() => _TurnBlockViewState();
}

class _TurnBlockViewState extends State<TurnBlockView> {
  late bool _collapsed;

  @override
  void initState() {
    super.initState();
    // 原生时间线保留最新回合的过程可见；历史块由宿主显式传 true。
    _collapsed = widget.defaultCollapsed ?? false;
  }

  @override
  void didUpdateWidget(TurnBlockView old) {
    super.didUpdateWidget(old);
    // 交接：busy→完成时保持用户当前折叠态不变（不抢用户操作）
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final vm = widget.vm;
    final showHeader = vm.parts.isNotEmpty || vm.busy;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (showHeader)
          InkWell(
            onTap: () {
              final next = !_collapsed;
              setState(() => _collapsed = next);
              widget.onFoldChanged?.call(next);
            },
            child: Padding(
              padding: const EdgeInsets.fromLTRB(2, 4, 2, 4),
              child: Row(
                children: [
                  Icon(
                    _collapsed ? Icons.chevron_right : Icons.expand_more,
                    size: 15,
                    color: colors.textMuted,
                  ),
                  const SizedBox(width: 5),
                  // 官方对齐：头部无图标无转圈，纯文字状态（官方「工作中 5 分 2 秒」）
                  const SizedBox(width: 7),
                  Text(
                    vm.busy
                        ? (vm.busyElapsed == null
                            ? '工作中'
                            : '工作中 ${_elapsedText(vm.busyElapsed!)}')
                        : _durationText(vm.totalDuration),
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  // 回合指标：首字延迟 + tok/s（流式中估算标 ≈，完成后权威）
                  if (vm.firstTokenMs != null ||
                      vm.tokensPerSecond != null) ...[
                    const SizedBox(width: 8),
                    Text(
                      [
                        if (vm.firstTokenMs != null)
                          formatTtft(vm.firstTokenMs!),
                        if (vm.tokensPerSecond != null)
                          formatTps(
                            vm.tokensPerSecond!,
                            estimated: vm.tpsIsEstimate,
                          ),
                      ].join(' · '),
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 11,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      vm.countsLabel,
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 11.5,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        // 引擎原序单遍渲染（运行时/历史一致性）：叙述正文永远可见（不参与
        // 折叠），思考/工具/子智能体/消息行归折叠区。旧实现把全部正文提到
        // 过程行之前、过程行整体放其后——reasoning→text→tool→text 会被
        // 拆散重排，展开后的视觉顺序不再是引擎顺序。
        for (final part in vm.parts)
          if (part.kind == TurnPartKind.text)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: widget.answerBuilder != null
                  ? widget.answerBuilder!(part.text ?? '', vm.busy)
                  : MarkdownBodyLite(markdown: part.text ?? ''),
            )
          else if (!_collapsed)
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 2),
              child: switch (part.kind) {
                TurnPartKind.thinking => _ThinkRow(data: part.think!),
                TurnPartKind.tool => _ToolRowView(
                    data: part.tool!,
                    onDownloadFile: widget.onDownloadFile,
                  ),
                TurnPartKind.agent => _AgentRowView(
                    data: part.agent!,
                    onOpenSubagent: widget.onOpenSubagent,
                  ),
                TurnPartKind.message => _MessageRowView(data: part.message!),
                TurnPartKind.text => const SizedBox.shrink(),
              },
            ),
        // 流式存活指示（官方对齐）：输出流末尾一个小等待圈
        if (vm.busy)
          const Padding(
            padding: EdgeInsets.only(top: 6, left: 4),
            child: SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        // 正文（文档流：无框直接渲染 Markdown，永不被折叠隐藏）
        if (vm.answerMarkdown.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6, bottom: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                widget.answerBuilder != null
                    ? widget.answerBuilder!(vm.answerMarkdown, vm.busy)
                    : MarkdownBodyLite(markdown: vm.answerMarkdown),
                // 流式中的输出感知：回答区底部细流光条
                if (vm.busy) const StreamingShimmer(),
              ],
            ),
          ),
      ],
    );
    // 回答区长按 → 宿主操作菜单（复制全文/引用为输入）
    if (widget.onAnswerLongPress == null || vm.answerMarkdown.isEmpty) {
      return body;
    }
    return GestureDetector(
      onLongPress: () => widget.onAnswerLongPress!(vm.answerMarkdown),
      child: body,
    );
  }

  String _durationText(Duration? d) {
    if (d == null) return '已完成';
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    if (m >= 1) return '已工作 $m 分 $s 秒';
    return '已工作 $s 秒';
  }

  /// 运行中已耗时（官方「工作中 5 分 2 秒」同款格式）
  String _elapsedText(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    if (m >= 1) return '$m 分 $s 秒';
    return '$s 秒';
  }
}

/// 思考行：⏳ 思考 · 持续了 N 秒，点击二级展开内容
class _ThinkRow extends StatefulWidget {
  const _ThinkRow({required this.data});
  final TurnThinkData data;

  @override
  State<_ThinkRow> createState() => _ThinkRowState();
}

class _ThinkRowState extends State<_ThinkRow> {
  bool _open = false;

  /// 思考尾行预览（官方 streamingText）：最后一个非空行
  static String _tailPreview(String content) {
    final lines = content.replaceAll('\r\n', '\n').split('\n');
    for (final line in lines.reversed) {
      final trimmed = line.trim();
      if (trimmed.isNotEmpty) return trimmed;
    }
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final d = widget.data;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                // 官方对齐：行内零转圈——运行中「正在思考」挂渐变扫光，
                // 完成态灰字 + 持续时长
                Icon(
                  Icons.psychology_outlined,
                  size: 13,
                  color: colors.textMuted,
                ),
                const SizedBox(width: 6),
                if (d.running)
                  const AnimatedGradientText(
                    '正在思考',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                else
                  Text(
                    '思考',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                if (d.duration != null)
                  Text(
                    ' · 持续了 ${d.duration!.inSeconds} 秒',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12,
                    ),
                  ),
                if (d.running && d.content.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  // 尾行预览（官方 streamingText）：思考最后一行非空文字，末端淡出
                  Expanded(
                    child: Text(
                      _tailPreview(d.content),
                      maxLines: 1,
                      overflow: TextOverflow.fade,
                      softWrap: false,
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ] else
                  const Spacer(),
                Icon(
                  _open ? Icons.expand_less : Icons.expand_more,
                  size: 13,
                  color: colors.textMuted,
                ),
              ],
            ),
          ),
        ),
        if (_open && d.content.isNotEmpty)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: colors.bgPrimary,
              border: Border(left: BorderSide(color: colors.border, width: 2)),
            ),
            child: Text(
              d.content,
              style: TextStyle(
                color: colors.textMuted,
                fontSize: 12,
              ),
            ),
          ),
      ],
    );
  }
}

/// 子智能体行：保留 agent 类型和父工具上下文，详情按原序展开。
class _AgentRowView extends StatefulWidget {
  const _AgentRowView({required this.data, this.onOpenSubagent});
  final TurnAgentData data;

  /// 非空 = 有子会话面板入口：点击开面板（展开详情让位给长按? 否——
  /// 双入口：点行开面板，行尾 chevron 展开详情）
  final void Function(TurnAgentData data)? onOpenSubagent;

  @override
  State<_AgentRowView> createState() => _AgentRowViewState();
}

class _AgentRowViewState extends State<_AgentRowView> {
  // 展开只由用户点击驱动（官方对齐）：详情默认收起，不自动弹开
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final data = widget.data;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () {
            // 优先子会话面板入口（probe-subagents-map：toolCallId 可关联
            // childSessionId）；无入口时回落行内详情展开
            if (widget.onOpenSubagent != null && data.toolCallId != null) {
              widget.onOpenSubagent!(data);
              return;
            }
            if (data.details.isNotEmpty) setState(() => _open = !_open);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                // 官方对齐：行内零转圈，运行中标题文字挂渐变扫光
                Icon(
                  Icons.smart_toy_outlined,
                  size: 14,
                  color: colors.accent,
                ),
                const SizedBox(width: 6),
                Text(
                  '子智能体',
                  style: TextStyle(
                    color: colors.textMuted,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: data.running
                      ? AnimatedGradientText(
                          '${data.agentType} · ${data.target}',
                          style: const TextStyle(fontSize: 13),
                        )
                      : Text(
                          '${data.agentType} · ${data.target}',
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: colors.textPrimary,
                            fontSize: 13,
                          ),
                        ),
                ),
                if (data.failed)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Icon(
                      Icons.error_outline,
                      size: 14,
                      color: colors.error,
                    ),
                  ),
                if (data.details.isNotEmpty)
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 13,
                    color: colors.textMuted,
                  ),
              ],
            ),
          ),
        ),
        if (_open && data.details.isNotEmpty)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(left: 18, bottom: 8),
            padding: const EdgeInsets.all(8),
            constraints: const BoxConstraints(maxHeight: 280),
            decoration: BoxDecoration(
              color: colors.bgPrimary,
              border: Border.all(color: colors.border),
              borderRadius: BorderRadius.circular(6),
            ),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in data.details)
                    SelectableText(
                      line.text,
                      style: TextStyle(
                        color: line.kind == DetailLineKind.cmd
                            ? colors.accent
                            : colors.textMuted,
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// 消息卡行：发给子智能体的 SendMessage（官方 aFt 对齐）——
/// 运行中「正在发送消息」渐变，完成态「消息」；标题 = 摘要；
/// 展开为 dl 三行：目标子智能体(to)/摘要/消息
class _MessageRowView extends StatefulWidget {
  const _MessageRowView({required this.data});
  final TurnMessageData data;

  @override
  State<_MessageRowView> createState() => _MessageRowViewState();
}

class _MessageRowViewState extends State<_MessageRowView> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final d = widget.data;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                Icon(
                  Icons.subdirectory_arrow_right,
                  size: 13,
                  color: colors.accent,
                ),
                const SizedBox(width: 6),
                if (d.running)
                  const AnimatedGradientText(
                    '正在发送消息',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                else
                  Text(
                    '消息',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                if (d.summary != null && d.summary!.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      d.summary!,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
                if (d.failed)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Icon(
                      Icons.error_outline,
                      size: 14,
                      color: colors.error,
                    ),
                  ),
                const Spacer(),
                Icon(
                  _open ? Icons.expand_less : Icons.expand_more,
                  size: 13,
                  color: colors.textMuted,
                ),
              ],
            ),
          ),
        ),
        if (_open)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(left: 18, bottom: 8),
            padding: const EdgeInsets.all(8),
            constraints: const BoxConstraints(maxHeight: 280),
            decoration: BoxDecoration(
              color: colors.bgPrimary,
              border: Border.all(color: colors.border),
              borderRadius: BorderRadius.circular(6),
            ),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // dl 三行：目标子智能体 / 摘要 / 消息（官方同构）
                  _dlRow(context, '目标子智能体', d.to, mono: true),
                  _dlRow(context, '摘要', d.summary ?? '—'),
                  _dlRow(context, '消息', d.body ?? '—'),
                  for (final line in d.details)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: SelectableText(
                        line.text,
                        style: TextStyle(
                          color: line.kind == DetailLineKind.cmd
                              ? colors.accent
                              : colors.textMuted,
                          fontSize: 11.5,
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _dlRow(
    BuildContext context,
    String label,
    String value, {
    bool mono = false,
  }) {
    final colors = AppColors.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: SelectableText.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$label  ',
              style: TextStyle(color: colors.textMuted, fontSize: 11.5),
            ),
            TextSpan(
              text: value,
              style: TextStyle(
                color: colors.textPrimary,
                fontSize: 11.5,
                fontFamily: mono ? 'monospace' : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 工具行：动词 + 目录 + 文件/聚合 + 行数 + 失败标 + 计时；点开二级详情
class _ToolRowView extends StatefulWidget {
  const _ToolRowView({required this.data, this.onDownloadFile});
  final TurnToolRow data;

  /// Write 行「下载到手机」回调（TurnBlockView 透传；null 不显示入口）
  final void Function(String path)? onDownloadFile;

  @override
  State<_ToolRowView> createState() => _ToolRowViewState();
}

class _ToolRowViewState extends State<_ToolRowView> {
  // 展开只由用户点击驱动（官方对齐）：结果到达绝不自动弹开——流式期间
  // 用户在滑动列表，自动展开既抢滚动又造成「手一碰就展开」的误触感。
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final d = widget.data;
    final expandable =
        d.details.isNotEmpty || (d.memberRows?.isNotEmpty ?? false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: !expandable
              ? null
              : () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                if (expandable)
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 12,
                    color: colors.textMuted,
                  )
                else
                  const SizedBox(width: 12),
                const SizedBox(width: 4),
                // 官方对齐：运行中挂渐变扫光。单行动画的动作文案在动词位
                // （正在执行/正在读取…），组行动画在 target 位（正在读取
                // x.dart）——渐变只挂一处，完成态全部回落灰字
                if (d.running && (d.memberRows?.isNotEmpty ?? false))
                  Text(
                    d.verb,
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12.5,
                    ),
                  )
                else if (d.running)
                  AnimatedGradientText(
                    d.verb,
                    style: const TextStyle(fontSize: 12.5),
                  )
                else
                  Text(
                    d.verb,
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12.5,
                    ),
                  ),
                if (d.dir != null) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      d.dir!,
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 11.5,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 5),
                ],
                Flexible(
                  child: (d.running && (d.memberRows?.isNotEmpty ?? false))
                      ? AnimatedGradientText(
                          d.target,
                          style: const TextStyle(fontSize: 13),
                        )
                      : Text(
                          d.target,
                          style: TextStyle(
                            color: colors.textPrimary,
                            fontSize: 13,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                ),
                if (d.add != null) ...[
                  const SizedBox(width: 6),
                  Text(
                    '+${d.add}',
                    style: TextStyle(
                      color: colors.success,
                      fontSize: 12,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
                if (d.del != null) ...[
                  const SizedBox(width: 4),
                  Text(
                    '-${d.del}',
                    style: TextStyle(
                      color: colors.error,
                      fontSize: 12,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
                // 行尾弱化状态注（官方「任务输出 … 已获取」同位）
                if (d.statusNote != null) ...[
                  const SizedBox(width: 6),
                  Text(
                    d.statusNote!,
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11.5,
                    ),
                  ),
                ],
                if (d.failed) ...[
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    decoration: BoxDecoration(
                      border: Border.all(color: colors.error),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '⚠ 执行失败',
                      style: TextStyle(
                        color: colors.error,
                        fontSize: 10.5,
                      ),
                    ),
                  ),
                ],
                if (d.recovered) ...[
                  const SizedBox(width: 4),
                  Text(
                    '已重试恢复',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 10.5,
                    ),
                  ),
                ],
                const Spacer(),
                // Write 产物的下载入口：完成后可用，失败行不给
                if (d.filePath != null &&
                    widget.onDownloadFile != null &&
                    !d.running &&
                    !d.failed)
                  InkWell(
                    onTap: () => widget.onDownloadFile!(d.filePath!),
                    child: Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Icon(
                        Icons.download_outlined,
                        size: 14,
                        color: colors.textMuted,
                      ),
                    ),
                  ),
                if (d.running && d.elapsed != null)
                  Text(
                    '${d.elapsed!.inSeconds}s',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                      fontFamily: 'monospace',
                    ),
                  ),
                // 官方对齐：完成态无 ✓ 图标（整行变灰即完成）；失败/已恢复
                // 徽章保留在行中——错误信息不能为观感牺牲
              ],
            ),
          ),
        ),
        // 组行（查阅伞）展开 = 成员行列表；成员行各自可再展开详情
        if (_open && (d.memberRows?.isNotEmpty ?? false))
          Padding(
            padding: const EdgeInsets.only(left: 12, bottom: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final member in d.memberRows!)
                  _ToolRowView(
                    data: member,
                    onDownloadFile: widget.onDownloadFile,
                  ),
              ],
            ),
          ),
        if (_open && d.details.isNotEmpty)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(left: 16, bottom: 8),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: colors.bgPrimary,
              border: Border.all(color: colors.border),
              borderRadius: BorderRadius.circular(6),
            ),
            // 大输出限高滚动，不撑爆回合块
            constraints: const BoxConstraints(maxHeight: 280),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in d.details)
                    SelectableText(
                      line.text,
                      style: TextStyle(
                        color: switch (line.kind) {
                          DetailLineKind.add => colors.success,
                          DetailLineKind.del => colors.error,
                          DetailLineKind.cmd => colors.accent,
                          DetailLineKind.dim => colors.textMuted,
                        },
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// 正文 Markdown 轻渲染（复用 home_page 的 MarkdownBody 配置较重；
/// 此处先以纯文本+代码样式渲染占位，T3 接线时换 flutter_markdown 实例）
class MarkdownBodyLite extends StatelessWidget {
  const MarkdownBodyLite({super.key, required this.markdown});
  final String markdown;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Text(
      markdown,
      style: TextStyle(color: colors.textPrimary, fontSize: 14, height: 1.5),
    );
  }
}

/// ── 运行态「走马灯」文字（官方 animated-gradient-text 对齐）────────
/// 一条约半透明亮带从右往左扫过文字：4s 循环，前 2s 扫后 2s 静
/// （官方 gradient-flow：background-position 100%→0%，strong/soft 双色）。
/// 仅运行中行挂载——状态一完成即换回静态文字并销毁控制器。
class AnimatedGradientText extends StatefulWidget {
  const AnimatedGradientText(
    this.text, {
    super.key,
    this.style,
    this.maxLines = 1,
  });

  final String text;
  final TextStyle? style;
  final int maxLines;

  @override
  State<AnimatedGradientText> createState() => _AnimatedGradientTextState();
}

class _AnimatedGradientTextState extends State<AnimatedGradientText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final base = widget.style?.color ?? colors.textPrimary;
    final soft = base.withAlpha(51); // 官方 soft = strong 20% 透明度
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final t = _controller.value;
        // 0→0.5：扫带中心从右缘到左缘；0.5→1：静止在左（对齐官方前扫后停）
        final p = t <= 0.5 ? 1 - 2 * t : 0.0;
        return ShaderMask(
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment(p * 2 - 1, 0),
            end: Alignment(p * 2 + 1, 0),
            colors: [base, soft, base],
          ).createShader(bounds),
          child: child,
        );
      },
      child: Text(
        widget.text,
        maxLines: widget.maxLines,
        overflow: TextOverflow.ellipsis,
        style: (widget.style ?? const TextStyle()).copyWith(
          color: Colors.white,
        ),
      ),
    );
  }
}
