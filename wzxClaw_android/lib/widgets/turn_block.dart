import 'dart:convert';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/chat_message.dart';

/// ── 回合块（Turn Block）视图模型与渲染 ─────────────────────────────
/// 设计冻结版见 .planning/PLAN-turn-block.md / docs/turn-block-mockup.html。
/// 文档流范式：无框无线；回合头常显（运行中转圈 / 完成总时长 + 中文动词
/// 计数）；过程（思考/工具行）可折叠且正文永显；工具行二级展开；块尾
/// 复制/下载/全文按钮。

/// 工具动作中文动词（与桌面端五分法一致）
String turnToolVerb(String toolName, {required bool done}) {
  switch (toolName) {
    case 'Bash':
      return '执行';
    case 'Read':
    case 'file-read':
      return '读取';
    case 'Write':
    case 'file-write':
      return '写入';
    case 'Edit':
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
    case 'agent-tool':
      return '子智能体';
    default:
      return toolName;
  }
}

/// 过程部件种类
enum TurnPartKind { thinking, tool, narration }

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
  });

  /// 中文动词：编辑/查阅/执行/写入/读取/搜索
  final String verb;

  /// 目标：文件末段，或聚合的「· 2 文件」「· 2 个命令」
  final String target;

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

  /// 二级展开的详情行（diff/命令输出，纯文本行）
  final List<TurnDetailLine> details;
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

/// 过程部件
class TurnPart {
  const TurnPart.think(TurnThinkData data)
      : kind = TurnPartKind.thinking,
        think = data,
        tool = null,
        narration = null;
  const TurnPart.tool(TurnToolRow data)
      : kind = TurnPartKind.tool,
        think = null,
        tool = data,
        narration = null;
  const TurnPart.narration(String text)
      : kind = TurnPartKind.narration,
        think = null,
        tool = null,
        narration = text;

  final TurnPartKind kind;
  final TurnThinkData? think;
  final TurnToolRow? tool;
  final String? narration; // 工具之间的中间叙述文本
}

/// 回合视图模型
class TurnVM {
  const TurnVM({
    required this.parts,
    required this.answerMarkdown,
    required this.busy,
    required this.countsLabel,
    this.totalDuration,
    this.think,
  });

  /// 过程部件（思考/工具/叙述，按真实顺序）
  final List<TurnPart> parts;

  /// 正文 Markdown（最后一个工具之后的文本；无工具回合即全部文本）
  final String answerMarkdown;

  final bool busy;
  final String countsLabel;
  final Duration? totalDuration;

  /// 思考行数据（运行中实时 / 完成后保留的最近一次；null = 不显示思考行）
  final TurnThinkData? think;
}

/// 工具调用的扁平视图：直连栈（assistant.toolCalls）与 legacy
/// （role==tool 消息）两种形态归一后的最小展示单元。
class _ToolView {
  const _ToolView({
    required this.name,
    required this.status,
    required this.createdAt,
    this.input,
    this.output,
    this.callId = '',
    this.everError = false,
  });

  final String name;
  final ToolCallStatus status;
  final String? input;
  final String? output;
  final String callId;
  final DateTime createdAt;

  /// 同 callID 历史上是否失败过（先败后成 = 已重试恢复）
  final bool everError;

  bool get failed => everError && status == ToolCallStatus.error;
  bool get recovered => everError && status != ToolCallStatus.error;
}

/// 从一回合的扁平消息切片构建 TurnVM。
/// [messages] = 该回合内按序的消息（直连栈：assistant 消息携带 toolCalls；
/// legacy：role==tool 独立消息，仅旧缓存兼容）；不含用户消息。
/// [busy] = 回合是否在途；[totalDuration] = 回合总时长（可得时传入）；
/// [think] = 思考行数据（可得时传入；null = 该回合无思考信息）。
TurnVM buildTurnVM(
  List<ChatMessage> messages, {
  required bool busy,
  Duration? totalDuration,
  TurnThinkData? think,
}) {
  final parts = <TurnPart>[];
  String answer = '';
  final counts = <String, int>{};
  var lastVerb = '';
  var currentMembers = <_ToolView>[];

  // 最后一个非空助手文本 = 正文；其前的文本 = 中间叙述（避免同一段
  // 文本既进叙述又进正文的重复展示）
  var lastTextIndex = -1;
  for (var i = 0; i < messages.length; i++) {
    final m = messages[i];
    if (m.role == MessageRole.assistant && m.content.trim().isNotEmpty) {
      lastTextIndex = i;
    }
  }

  void emitTool(_ToolView v) {
    final done = v.status != ToolCallStatus.running;
    final verb = turnToolVerb(v.name, done: done);
    // 聚合：连续同类（读取/搜索/执行）合并为一行，展开逐成员显示
    final aggregate = verb == '读取' || verb == '搜索' || verb == '执行';
    if (aggregate &&
        verb == lastVerb &&
        parts.isNotEmpty &&
        parts.last.kind == TurnPartKind.tool) {
      currentMembers = List.of(currentMembers)..add(v);
      final count = currentMembers.length;
      parts[parts.length - 1] = TurnPart.tool(
        TurnToolRow(
          verb: verb,
          target: '· $count${verb == '执行' ? ' 个命令' : ' 文件'}',
          count: count,
          running: v.status == ToolCallStatus.running,
          failed: v.failed,
          details: [
            for (final member in currentMembers) _memberLine(member),
          ],
        ),
      );
      counts[verb] = (counts[verb] ?? 0) + 1;
      return;
    }
    currentMembers = [v];
    final delta = _editLineDelta(v.name, v.input);
    parts.add(
      TurnPart.tool(
        TurnToolRow(
          verb: verb,
          target: _toolTarget(v.name, v.input),
          add: delta?.$1,
          del: delta?.$2,
          running: !done,
          failed: v.failed,
          recovered: v.recovered,
          elapsed: done ? null : DateTime.now().difference(v.createdAt),
          details: _toolDetails(v),
        ),
      ),
    );
    counts[verb] = (counts[verb] ?? 0) + 1;
    lastVerb = verb;
  }

  for (var i = 0; i < messages.length; i++) {
    final m = messages[i];

    // ── 工具展开：直连栈形态（assistant.toolCalls，协议权威）为主，
    // legacy role==tool 独立消息兜底。同 callID 连续条目合并为一个视图
    // （引擎重试：终态取最后，先败后成标「已重试恢复」）。
    final views = <_ToolView>[];
    final calls = m.toolCalls;
    if (calls != null && calls.isNotEmpty) {
      for (final tc in calls) {
        views.add(
          _ToolView(
            name: tc.toolName,
            status: tc.status,
            input: tc.inputFull ?? tc.inputSummary,
            output: tc.outputFull ?? tc.outputSummary,
            callId: tc.toolCallId,
            createdAt: m.createdAt,
            everError: tc.status == ToolCallStatus.error,
          ),
        );
      }
    } else if (m.role == MessageRole.tool) {
      views.add(
        _ToolView(
          name: m.toolName ?? 'Tool',
          status: m.toolStatus ?? ToolCallStatus.running,
          input: m.toolInput ?? (m.content.isNotEmpty ? m.content : null),
          output: m.toolOutput,
          callId: m.toolCallId ?? '',
          createdAt: m.createdAt,
          everError: m.toolStatus == ToolCallStatus.error,
        ),
      );
    }
    final merged = <_ToolView>[];
    for (final v in views) {
      if (merged.isNotEmpty && v.callId.isNotEmpty && merged.last.callId == v.callId) {
        final p = merged.last;
        merged[merged.length - 1] = _ToolView(
          name: v.name,
          status: v.status,
          input: v.input ?? p.input,
          output: v.output ?? p.output,
          callId: v.callId,
          createdAt: p.createdAt,
          everError: p.everError || v.everError,
        );
      } else {
        merged.add(v);
      }
    }
    for (final v in merged) {
      emitTool(v);
    }

    // ── 助手文本：最后一个 = 正文，其余 = 中间叙述（叙述会打断聚合）
    if (m.role == MessageRole.assistant &&
        i != lastTextIndex &&
        m.content.trim().isNotEmpty) {
      parts.add(TurnPart.narration(_plainExcerpt(m.content)));
      lastVerb = '';
      currentMembers = const [];
    }
  }

  // 正文兜底：无任何助手文本的回合（罕见）不显示正文
  if (lastTextIndex >= 0) answer = messages[lastTextIndex].content;

  final countsLabel = counts.entries
      .map((e) => '${e.key} ${e.value}')
      .join(' · ');

  return TurnVM(
    parts: parts,
    answerMarkdown: answer,
    busy: busy,
    countsLabel: countsLabel,
    totalDuration: totalDuration,
    think: think,
  );
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
      final cmd = pick(['command', 'cmd', 'script']);
      if (cmd != null) return _singleLine(cmd, 60);
      break;
    case 'Read':
    case 'file-read':
    case 'Write':
    case 'file-write':
    case 'Edit':
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
  if (name != 'Edit' && name != 'file-edit') return null;
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
      TurnDetailLine(_capBlock(_prettyInput(v.name, input)),
          kind: DetailLineKind.cmd,),
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

/// 叙述文本摘录：过长时截断（叙述在流程里是辅助角色，全文在正文段）
String _plainExcerpt(String text) {
  final t = text.trim();
  return t.length > 160 ? '${t.substring(0, 157)}…' : t;
}

/// ── 渲染 ──────────────────────────────────────────────────────────

class TurnBlockView extends StatefulWidget {
  const TurnBlockView({
    super.key,
    required this.vm,
    this.defaultCollapsed,
    this.answerBuilder,
  });

  final TurnVM vm;

  /// null = 自动（busy 展开 / 完成折叠）
  final bool? defaultCollapsed;

  /// 正文 Markdown 渲染器（宿主传入富渲染；缺省纯文本）
  final Widget Function(String markdown)? answerBuilder;

  @override
  State<TurnBlockView> createState() => _TurnBlockViewState();
}

class _TurnBlockViewState extends State<TurnBlockView> {
  late bool _collapsed;

  @override
  void initState() {
    super.initState();
    _collapsed = widget.defaultCollapsed ?? !widget.vm.busy;
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (showHeader)
          InkWell(
            onTap: () => setState(() => _collapsed = !_collapsed),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(2, 4, 2, 4),
              child: Row(children: [
                Icon(_collapsed ? Icons.chevron_right : Icons.expand_more,
                    size: 15, color: colors.textMuted,),
                const SizedBox(width: 5),
                if (vm.busy)
                  SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(
                        strokeWidth: 1.8, color: colors.accent,),
                  )
                else
                  Icon(Icons.check_circle_outline,
                      size: 14, color: colors.success,),
                const SizedBox(width: 7),
                Text(
                  vm.busy ? '正在工作…' : _durationText(vm.totalDuration),
                  style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(vm.countsLabel,
                      style: TextStyle(
                          color: colors.textMuted, fontSize: 11.5,),
                      overflow: TextOverflow.ellipsis,),
                ),
              ],),
            ),
          ),
        // 过程（可折叠）
        if (!_collapsed)
          Padding(
            padding: const EdgeInsets.only(left: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (vm.think != null) _ThinkRow(data: vm.think!),
                for (final part in vm.parts)
                  if (part.kind == TurnPartKind.thinking)
                    _ThinkRow(data: part.think!)
                  else if (part.kind == TurnPartKind.tool)
                    _ToolRowView(data: part.tool!)
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text(part.narration ?? '',
                          style: TextStyle(
                              color: colors.textPrimary, fontSize: 13,),),
                    ),
              ],
            ),
          ),
        // 正文（文档流：无框直接渲染 Markdown，永不被折叠隐藏）
        if (vm.answerMarkdown.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6, bottom: 2),
            child: widget.answerBuilder != null
                ? widget.answerBuilder!(vm.answerMarkdown)
                : MarkdownBodyLite(markdown: vm.answerMarkdown),
          ),
        // 块级操作按钮（正文非空时）
        if (vm.answerMarkdown.isNotEmpty)
          Align(
            alignment: Alignment.centerRight,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              _BlockBtn(icon: Icons.copy_outlined, label: '复制',
                  onTap: () {},),
              _BlockBtn(icon: Icons.ios_share, label: '下载',
                  onTap: () {},),
              _BlockBtn(icon: Icons.open_in_full, label: '全文',
                  onTap: () {},),
            ],),
          ),
      ],
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
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      InkWell(
        onTap: () => setState(() => _open = !_open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(children: [
            if (d.running)
              SizedBox(
                width: 11,
                height: 11,
                child: CircularProgressIndicator(
                    strokeWidth: 1.6, color: colors.textMuted,),
              )
            else
              Icon(Icons.psychology_outlined, size: 13, color: colors.textMuted),
            const SizedBox(width: 6),
            Text('思考',
                style: TextStyle(
                    color: colors.textMuted,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,),),
            if (d.duration != null)
              Text(' · 持续了 ${d.duration!.inSeconds} 秒',
                  style: TextStyle(color: colors.textMuted, fontSize: 12,),),
            const Spacer(),
            Icon(_open ? Icons.expand_less : Icons.expand_more,
                size: 13, color: colors.textMuted,),
          ],),
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
          child: Text(d.content,
              style: TextStyle(color: colors.textMuted, fontSize: 12,),),
        ),
    ],);
  }
}

/// 工具行：动词 + 目录 + 文件/聚合 + 行数 + 失败标 + 计时；点开二级详情
class _ToolRowView extends StatefulWidget {
  const _ToolRowView({required this.data});
  final TurnToolRow data;

  @override
  State<_ToolRowView> createState() => _ToolRowViewState();
}

class _ToolRowViewState extends State<_ToolRowView> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final d = widget.data;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      InkWell(
        onTap: d.details.isEmpty ? null : () => setState(() => _open = !_open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            if (d.details.isNotEmpty)
              Icon(_open ? Icons.expand_less : Icons.expand_more,
                  size: 12, color: colors.textMuted,)
            else
              const SizedBox(width: 12),
            const SizedBox(width: 4),
            Text(d.verb,
                style: TextStyle(color: colors.textMuted, fontSize: 12.5,),),
            if (d.dir != null) ...[
              const SizedBox(width: 6),
              Flexible(
                child: Text(d.dir!,
                    style: TextStyle(
                        color: colors.textMuted, fontSize: 11.5,),
                    overflow: TextOverflow.ellipsis,),
              ),
              const SizedBox(width: 5),
            ],
            Flexible(
              child: Text(d.target,
                  style: TextStyle(color: colors.textPrimary, fontSize: 13,),
                  overflow: TextOverflow.ellipsis,),
            ),
            if (d.add != null) ...[
              const SizedBox(width: 6),
              Text('+${d.add}',
                  style: TextStyle(
                      color: colors.success,
                      fontSize: 12,
                      fontFamily: 'monospace',),),
            ],
            if (d.del != null) ...[
              const SizedBox(width: 4),
              Text('-${d.del}',
                  style: TextStyle(
                      color: colors.error,
                      fontSize: 12,
                      fontFamily: 'monospace',),),
            ],
            if (d.failed) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                decoration: BoxDecoration(
                  border: Border.all(color: colors.error),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text('⚠ 执行失败',
                    style: TextStyle(color: colors.error, fontSize: 10.5,),),
              ),
            ],
            if (d.recovered) ...[
              const SizedBox(width: 4),
              Text('已重试恢复',
                  style: TextStyle(color: colors.textMuted, fontSize: 10.5,),),
            ],
            const Spacer(),
            if (d.running && d.elapsed != null)
              Text('${d.elapsed!.inSeconds}s',
                  style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                      fontFamily: 'monospace',),)
            else if (!d.running)
              Icon(Icons.check, size: 13, color: colors.textMuted),
          ],),
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
    ],);
  }
}

/// 块级操作按钮
class _BlockBtn extends StatelessWidget {
  const _BlockBtn({required this.icon, required this.label, this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(children: [
          Icon(icon, size: 13, color: colors.textMuted),
          const SizedBox(width: 4),
          Text(label, style: TextStyle(color: colors.textMuted, fontSize: 12),),
        ],),
      ),
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
    return Text(markdown,
        style: TextStyle(color: colors.textPrimary, fontSize: 14, height: 1.5),);
  }
}
