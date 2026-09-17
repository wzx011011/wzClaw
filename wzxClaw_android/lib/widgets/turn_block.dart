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
    required this.duration,
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

/// 从一回合的扁平消息切片构建 TurnVM。
/// [messages] = 该回合内按序的消息（工具消息 + 助手文本消息，不含用户消息）；
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
  var sawTool = false;

  var lastVerb = '';
  for (final m in messages) {
    if (m.role == MessageRole.tool) {
      final done = m.toolStatus != ToolCallStatus.running;
      final verb = turnToolVerb(m.toolName ?? 'Tool', done: done);
      final target = (m.toolInput ?? m.toolOutput ?? m.content).isNotEmpty
          ? _lastPathSegment(m.toolInput ?? m.content)
          : (m.toolName ?? 'Tool');
      sawTool = true;
      // 聚合：连续同类且均为聚合形态（查阅/搜索/执行）→ 计数合并
      final aggregate = verb == '查阅' || verb == '搜索' || verb == '执行';
      if (aggregate && verb == lastVerb) {
        final prev = parts.last.tool!;
        parts[parts.length - 1] = TurnPart.tool(
          TurnToolRow(
            verb: verb,
            target: '· ${prev.count ?? 1 + 1}${verb == '执行' ? ' 个命令' : ' 文件'}',
            count: (prev.count ?? 1) + 1,
            running: m.toolStatus == ToolCallStatus.running,
          ),
        );
        counts[verb] = (counts[verb] ?? 0) + 1;
        continue;
      }
      parts.add(
        TurnPart.tool(
          TurnToolRow(
            verb: verb,
            target: target,
            running: !done,
            failed: m.toolStatus == ToolCallStatus.error,
            recovered: m.toolStatus == ToolCallStatus.error,
            elapsed: done ? null : DateTime.now().difference(m.createdAt),
          ),
        ),
      );
      counts[verb] = (counts[verb] ?? 0) + 1;
      lastVerb = verb;
    } else if (m.role == MessageRole.assistant) {
      if (m.content.trim().isEmpty) continue;
      final text = m.content;
      if (sawTool) {
        parts.add(TurnPart.narration(_plainExcerpt(text)));
      }
      answer = text; // 最后一个助手文本 = 正文（多段时取最后一段，前面段落成叙述）
    }
  }

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
  const TurnBlockView({super.key, required this.vm, this.defaultCollapsed});

  final TurnVM vm;
  /// null = 自动（busy 展开 / 完成折叠）
  final bool? defaultCollapsed;

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
            child: MarkdownBodyLite(markdown: vm.answerMarkdown),
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
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final line in d.details)
              Text(line.text,
                  style: TextStyle(
                      color: switch (line.kind) {
                        DetailLineKind.add => colors.success,
                        DetailLineKind.del => colors.error,
                        DetailLineKind.cmd => colors.accent,
                        DetailLineKind.dim => colors.textMuted,
                      },
                      fontSize: 11.5,
                      fontFamily: 'monospace',),),
          ],),
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
