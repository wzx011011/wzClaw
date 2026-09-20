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

/// 工具动作中文动词（与桌面端五分法一致）
String turnToolVerb(String toolName, {required bool done}) {
  switch (toolName) {
    case 'Bash':
    case 'ShellExecute':
    case 'shell':
      return '执行';
    case 'Read':
    case 'FileRead':
    case 'file-read':
      return '读取';
    case 'Write':
    case 'FileWrite':
    case 'file-write':
      return '写入';
    case 'Edit':
    case 'FileEdit':
    case 'ApplyPatch':
    case 'file-edit':
      return done ? '已编辑' : '编辑';
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'web-search':
      return '搜索';
    case 'WebFetch':
    case 'web-fetch':
      return '获取';
    case 'Agent':
    case 'Task':
    case 'agent-tool':
      return '子智能体';
    default:
      return toolName;
  }
}

/// 过程部件种类。全部来自权威 processParts 的直接投影。
enum TurnPartKind { thinking, tool, text, agent }

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
    this.defaultOpen = false,
    this.subagentType,
    this.lifecycle,
    this.filePath,
    this.memberRows,
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

  /// 完成且已有结果时默认展开一次；用户之后的开合操作仍被本地状态保留。
  /// 组行只展开成员列表；成员行默认收起（官方对齐），逐个点开看详情。
  final bool defaultOpen;

  /// Agent 的 subagent_type（Explore/general-purpose 等）；非 Agent 工具为 null。
  final String? subagentType;

  /// 实时生命周期的短状态，用于等待权限/参数流入等尚未形成结果的阶段。
  final String? lifecycle;
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
    this.defaultOpen = false,
  });

  final String agentType;
  final String target;
  final bool running;
  final bool failed;
  final List<TurnDetailLine> details;
  final bool defaultOpen;
}

/// 过程部件
class TurnPart {
  const TurnPart.think(TurnThinkData data, {this.key})
      : kind = TurnPartKind.thinking,
        think = data,
        tool = null,
        agent = null,
        text = null;
  const TurnPart.tool(TurnToolRow data, {this.key})
      : kind = TurnPartKind.tool,
        think = null,
        tool = data,
        agent = null,
        text = null;
  const TurnPart.text(String content, {this.key})
      : kind = TurnPartKind.text,
        think = null,
        tool = null,
        agent = null,
        text = content;
  const TurnPart.agent(TurnAgentData data, {this.key})
      : kind = TurnPartKind.agent,
        think = null,
        tool = null,
        agent = data,
        text = null;

  final TurnPartKind kind;
  final String? key;
  final TurnThinkData? think;
  final TurnToolRow? tool;
  final TurnAgentData? agent;
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
  var lastVerb = '';
  var currentMembers = <_ToolView>[];

  void breakAggregate() {
    lastVerb = '';
    currentMembers = <_ToolView>[];
  }

  /// 查阅伞行（官方对齐）：verb=查阅，target=分桶计数或运行态摘要，
  /// 二级为成员行（每行独立展开自己的输入/输出详情）
  TurnToolRow exploreRow(List<_ToolView> members) {
    final bucketCounts = <_ExploreBucket, int>{};
    for (final member in members) {
      final bucket = _exploreBucketOf(member);
      if (bucket != null) {
        bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
      }
    }
    _ToolView? trailingRunning;
    for (final member in members) {
      if (member.status == ToolCallStatus.running) trailingRunning = member;
    }
    final String target;
    if (trailingRunning != null) {
      // 运行中：摘要末个运行成员的动作（「正在读取 x.dart」）
      target =
          '正在${_bucketAction(_exploreBucketOf(trailingRunning))} '
          '${_toolTarget(trailingRunning.name, trailingRunning.input)}';
    } else {
      target = [
        if ((bucketCounts[_ExploreBucket.search] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.search]} 搜索',
        if ((bucketCounts[_ExploreBucket.list] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.list]} 列表',
        if ((bucketCounts[_ExploreBucket.file] ?? 0) > 0)
          '${bucketCounts[_ExploreBucket.file]} 文件',
      ].join('，');
    }
    return TurnToolRow(
      verb: '查阅',
      target: target,
      count: members.length,
      running: trailingRunning != null,
      failed: members.any((member) => member.failed),
      recovered: members.any((member) => member.recovered),
      memberRows: [
        for (final member in members) _exploreMemberRow(member),
      ],
      defaultOpen: members.any(
        (member) =>
            member.status != ToolCallStatus.running && member.output != null,
      ),
    );
  }

  void emitTool(_ToolView view) {
    final verb = turnToolVerb(
      view.name,
      done: view.status != ToolCallStatus.running,
    );
    // 查阅聚合（官方对齐）：连续的查阅类工具（读取/搜索/只读 shell）
    // 并入同一伞行，按语义分桶计数；≥2 个成员才成组，单发保留原动词行。
    final bucket = _exploreBucketOf(view);
    if (bucket != null && lastVerb == _kExploreVerb) {
      final firstUpgrade = currentMembers.length == 1;
      currentMembers = List.of(currentMembers)..add(view);
      final row = parts.last.tool!;
      parts[parts.length - 1] = TurnPart.tool(
        exploreRow(currentMembers),
        key: row.target,
      );
      if (firstUpgrade) {
        // 首个成员此前按语义动词计数过：成组后并入「查阅」
        final firstBucket = _exploreBucketOf(currentMembers.first);
        if (firstBucket != null) {
          final bucketVerb = _bucketVerb(firstBucket);
          final c = counts[bucketVerb] ?? 0;
          if (c <= 1) {
            counts.remove(bucketVerb);
          } else {
            counts[bucketVerb] = c - 1;
          }
        }
        counts['查阅'] = (counts['查阅'] ?? 0) + 1;
      }
      return;
    }
    if (bucket != null) {
      // 首个查阅成员：先按语义动词渲染单行；下一个连续成员到来时
      // 升级为伞行并把该计数并回查阅
      currentMembers = [view];
      lastVerb = _kExploreVerb;
      final bucketVerb = _bucketVerb(bucket);
      parts.add(
        TurnPart.tool(
          TurnToolRow(
            verb: bucketVerb,
            target: _toolTarget(view.name, view.input),
            running: view.status == ToolCallStatus.running,
            failed: view.failed,
            recovered: view.recovered,
            elapsed: view.status == ToolCallStatus.running
                ? DateTime.now().difference(view.createdAt)
                : null,
            details: _memberDetails(view),
            defaultOpen:
                view.status != ToolCallStatus.running && view.output != null,
            lifecycle: view.lifecycle,
          ),
          key: view.callId.isEmpty ? null : view.callId,
        ),
      );
      counts[bucketVerb] = (counts[bucketVerb] ?? 0) + 1;
      return;
    }
    // 终端聚合：相邻执行（非只读 shell）仍合并「· N 个命令」
    currentMembers = [view];
    if (verb == '执行' &&
        lastVerb == verb &&
        parts.isNotEmpty &&
        parts.last.kind == TurnPartKind.tool) {
      final previous = parts.last.tool!;
      final mergedCount = (previous.count ?? 1) + 1;
      parts[parts.length - 1] = TurnPart.tool(
        TurnToolRow(
          verb: verb,
          target: '· $mergedCount 个命令',
          count: mergedCount,
          running:
              previous.running || view.status == ToolCallStatus.running,
          failed: previous.failed || view.failed,
          recovered: previous.recovered || view.recovered,
          details: [...previous.details, ..._memberDetails(view)],
          defaultOpen: previous.defaultOpen ||
              (view.status != ToolCallStatus.running &&
                  view.output != null),
        ),
        key: previous.target,
      );
      return;
    }
    final delta = _editLineDelta(view.name, view.input);
    final written = view.status != ToolCallStatus.running && !view.failed
        ? _writtenFilePath(view)
        : null;
    parts.add(
      TurnPart.tool(
        TurnToolRow(
          verb: verb,
          target: _toolTarget(view.name, view.input),
          add: delta?.$1,
          del: delta?.$2,
          filePath: written,
          running: view.status == ToolCallStatus.running,
          failed: view.failed,
          recovered: view.recovered,
          elapsed: view.status == ToolCallStatus.running
              ? DateTime.now().difference(view.createdAt)
              : null,
          details: _memberDetails(view),
          defaultOpen:
              view.status != ToolCallStatus.running && view.output != null,
          subagentType: view.subagentType,
          lifecycle: view.lifecycle,
        ),
        key: view.callId.isEmpty ? null : view.callId,
      ),
    );
    counts[verb] = (counts[verb] ?? 0) + 1;
    lastVerb = verb;
  }

  _ToolView toolViewOf(ChatProcessPart part, DateTime createdAt) {    final tool = part.toolCall!;
    return _ToolView(
      name: tool.toolName,
      status: tool.status,
      input: tool.inputFull ?? tool.inputSummary,
      output: tool.outputFull ?? tool.outputSummary,
      callId: tool.toolCallId,
      createdAt: createdAt,
      everError: tool.isError,
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
            defaultOpen: detailLines.isNotEmpty,
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
        // 显式 Agent/Task 工具 → 内联子智能体行；其余按普通工具行处理
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
                defaultOpen:
                    tool.outputFull != null || tool.outputSummary != null,
              ),
              key: process.id ?? tool.toolCallId,
            ),
          );
          counts['子智能体'] = (counts['子智能体'] ?? 0) + 1;
        } else {
          emitTool(toolViewOf(process, source.createdAt!));
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

/// ── 查阅分桶（官方对齐）──────────────────────────────────────────
/// 只读查阅类工具与 shell 命令归入同一「查阅」伞：按语义分桶计数
/// （搜索/列表/文件），组行可展开为成员行，成员行各自展开详情。
/// 分类规则对齐官方前端（app.asar LOt/mLt）：rg/grep 家族 → 搜索；
/// ls/find/tree/dir → 列表；其余白名单命令 → 文件；写入/重定向命令
/// 不进查阅，按普通「执行」行处理。

/// 查阅伞动词标记（聚合游标专用，不直接渲染）
const _kExploreVerb = '#explore';

enum _ExploreBucket { search, list, file }

/// 只读 shell 白名单（官方 mLt：wc/ls/grep/rg + 分桶正则里的 find/tree/dir）
const _readOnlyShellCommands = {
  'wc', 'ls', 'grep', 'rg', 'ripgrep', 'find', 'tree', 'dir',
};

final _searchCmdRE = RegExp(r'(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)', caseSensitive: false);
final _listCmdRE = RegExp(r'(^|\s)(ls|find|tree|dir)(\s|$)', caseSensitive: false);

/// 提取 shell 命令本体（结构化输入 JSON 的 command/cmd/script）
String? _shellCommand(String? input) {
  final raw = input?.trim() ?? '';
  if (!raw.startsWith('{')) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, dynamic>) {
      for (final key in ['command', 'cmd', 'script']) {
        final v = decoded[key];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
  } catch (_) {}
  return null;
}

/// 只读 shell 判定：无重定向/输入重定向，且 && || ; 分隔的每段
/// 首命令都在白名单内（`wc -l f && ls` 合法；`cat f`、`npm t` 不进查阅）
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

/// 工具的查阅分桶；null = 不属于查阅家族（写入/编辑/子智能体/网络获取等）
_ExploreBucket? _exploreBucketOf(_ToolView view) {
  switch (view.name) {
    case 'Read':
    case 'FileRead':
    case 'file-read':
    case 'Glob':
      return _ExploreBucket.file;
    case 'Grep':
    case 'WebSearch':
    case 'web-search':
      return _ExploreBucket.search;
    case 'Bash':
    case 'ShellExecute':
    case 'shell':
      final cmd = _shellCommand(view.input);
      if (cmd == null || !_isReadOnlyShell(cmd)) return null;
      if (_searchCmdRE.hasMatch(cmd)) return _ExploreBucket.search;
      if (_listCmdRE.hasMatch(cmd)) return _ExploreBucket.list;
      return _ExploreBucket.file;
    default:
      return null;
  }
}

/// 分桶的成员行动词
String _bucketVerb(_ExploreBucket? bucket) => switch (bucket) {
      _ExploreBucket.search => '搜索',
      _ExploreBucket.list => '列表',
      _ => '文件',
    };

/// 分桶的运行态动作（组行「正在读取 x.dart」用）
String _bucketAction(_ExploreBucket? bucket) => switch (bucket) {
      _ExploreBucket.search => '搜索',
      _ExploreBucket.list => '扫描',
      _ => '读取',
    };

/// 查阅组成员行：语义动词 + 目标 + 自身状态与详情（默认收起）
TurnToolRow _exploreMemberRow(_ToolView view) {
  return TurnToolRow(
    verb: _bucketVerb(_exploreBucketOf(view)),
    target: _toolTarget(view.name, view.input),
    running: view.status == ToolCallStatus.running,
    failed: view.failed,
    recovered: view.recovered,
    elapsed: view.status == ToolCallStatus.running
        ? DateTime.now().difference(view.createdAt)
        : null,
    details: _memberDetails(view),
    defaultOpen: false,
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
  if (raw.isEmpty) return name;
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

/// 聚合行的成员明细行（展开逐文件/逐命令显示）
TurnDetailLine _memberLine(_ToolView v) {
  final target = _toolTarget(v.name, v.input);
  return TurnDetailLine('· $target${v.failed ? '  ⚠' : ''}');
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
    this.answerBuilder,
    this.onDownloadFile,
    this.onAnswerLongPress,
  });

  final TurnVM vm;

  /// null = 自动（busy 展开 / 完成折叠）
  final bool? defaultCollapsed;

  /// 正文 Markdown 渲染器（宿主传入富渲染；缺省纯文本）。
  /// 第二参 isStreaming = 该回合进行中：宿主应降级为纯文本渲染，
  /// 防半截 markdown 语法裸露与逐 chunk 全量重解析。
  final Widget Function(String markdown, bool isStreaming)? answerBuilder;

  /// Write 工具行「下载到手机」入口（宿主接线下载服务；null 不显示入口）
  final void Function(String path)? onDownloadFile;

  /// 回答区长按（宿主弹操作菜单：复制全文/引用为输入）；
  /// 仅正文非空时生效，参数为回答 markdown 全文
  final void Function(String answerMarkdown)? onAnswerLongPress;

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
            onTap: () => setState(() => _collapsed = !_collapsed),
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
                  if (vm.busy)
                    SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.8,
                        color: colors.accent,
                      ),
                    )
                  else
                    Icon(
                      Icons.check_circle_outline,
                      size: 14,
                      color: colors.success,
                    ),
                  const SizedBox(width: 7),
                  Text(
                    vm.busy
                        ? (vm.busyElapsed == null
                            ? '正在工作…'
                            : '正在工作… ${vm.busyElapsed!.inSeconds}s')
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
        // 过程（可折叠）
        if (!_collapsed)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final part in vm.parts)
                  if (part.kind == TurnPartKind.thinking)
                    _ThinkRow(data: part.think!)
                  else if (part.kind == TurnPartKind.tool)
                    _ToolRowView(
                      data: part.tool!,
                      onDownloadFile: widget.onDownloadFile,
                    )
                  else if (part.kind == TurnPartKind.agent)
                    _AgentRowView(data: part.agent!)
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text(
                        part.text ?? '',
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 13,
                        ),
                      ),
                    ),
              ],
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
                if (d.running)
                  SizedBox(
                    width: 11,
                    height: 11,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.6,
                      color: colors.textMuted,
                    ),
                  )
                else
                  Icon(
                    Icons.psychology_outlined,
                    size: 13,
                    color: colors.textMuted,
                  ),
                const SizedBox(width: 6),
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
  const _AgentRowView({required this.data});
  final TurnAgentData data;

  @override
  State<_AgentRowView> createState() => _AgentRowViewState();
}

class _AgentRowViewState extends State<_AgentRowView> {
  late bool _open;

  @override
  void initState() {
    super.initState();
    _open = widget.data.defaultOpen;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final data = widget.data;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: data.details.isEmpty
              ? null
              : () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                if (data.running)
                  SizedBox(
                    width: 11,
                    height: 11,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.6,
                      color: colors.accent,
                    ),
                  )
                else
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
                  child: Text(
                    '${data.agentType} · ${data.target}',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: colors.textPrimary, fontSize: 13),
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
  late bool _open;
  bool _userToggled = false;

  @override
  void initState() {
    super.initState();
    _open = widget.data.defaultOpen;
  }

  @override
  void didUpdateWidget(_ToolRowView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 运行中 → 出结果时自动展开一次；用户已手动开合过则不抢操作。
    if (!_userToggled &&
        widget.data.defaultOpen &&
        !oldWidget.data.defaultOpen) {
      _open = true;
    }
  }

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
              : () => setState(() {
                    _userToggled = true;
                    _open = !_open;
                  }),
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
                  child: Text(
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
                  )
                else if (!d.running)
                  Icon(Icons.check, size: 13, color: colors.textMuted),
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
