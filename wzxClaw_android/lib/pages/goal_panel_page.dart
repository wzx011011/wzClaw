// ============================================================
// goal_panel_page — 悬浮窗还原页（目标/进程/计划/智能体）
//
// 还原桌面端 ZCode 悬浮窗的四板块信息，数据源：
// - 目标/进程/计划：session/goal 快照（GoalStore，回合驱动自动刷新）
// - 智能体：session/subagents {action:'show'} 子线程
// ============================================================

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/goal_snapshot.dart';
import '../services/goal_store.dart';

class GoalPanelPage extends StatefulWidget {
  const GoalPanelPage({super.key});

  @override
  State<GoalPanelPage> createState() => _GoalPanelPageState();
}

class _GoalPanelPageState extends State<GoalPanelPage> {
  @override
  void initState() {
    super.initState();
    GoalStore.instance.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('任务面板')),
      body: ListenableBuilder(
        listenable: GoalStore.instance,
        builder: (context, _) {
          final store = GoalStore.instance;
          final snapshot = store.snapshot;
          final threads = store.threads;

          if (snapshot.isEmpty && threads.isEmpty) {
            final failed = store.phase == GoalLoadPhase.failed;
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.monitor_heart_outlined,
                      size: 40,
                      color: AppColors.of(context).textMuted,),
                  const SizedBox(height: 12),
                  // 失败且无旧数据：直说失败，绝不把「拉不到」冒充「没有」
                  Text(failed ? '数据拉取失败' : '暂无任务数据',
                      style: TextStyle(
                          color: AppColors.of(context).textMuted,
                          fontSize: 14,),),
                  const SizedBox(height: 4),
                  Text(
                      failed
                          ? store.staleLabel
                          : '会话运行中会自动更新，或下拉重新拉取',
                      style: TextStyle(
                          color: AppColors.of(context).textMuted,
                          fontSize: 12,),),
                ],
              ),
            );
          }

          return RefreshIndicator(
            onRefresh: () => GoalStore.instance.refresh(),
            child: ListView(
              padding: const EdgeInsets.all(12),
              children: [
                // 柱5 stale-but-labeled：旧数据保留展示但标注新鲜度，
                // 绝不冒充实时的（与悬浮卡同一份 GoalStore.staleLabel）
                if (store.phase == GoalLoadPhase.failed)
                  Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 8),
                    child: Row(
                      children: [
                        Icon(Icons.sync_problem_outlined,
                            size: 13,
                            color: AppColors.of(context).textMuted,),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(store.staleLabel,
                              style: TextStyle(
                                  color: AppColors.of(context).textMuted,
                                  fontSize: 11,),),
                        ),
                      ],
                    ),
                  ),
                _sectionHeader(context, Icons.flag_outlined, '目标',
                    count: snapshot.groups.length,),
                if (snapshot.groups.isEmpty)
                  _emptyHint(context, '暂无目标组')
                else
                  for (final g in snapshot.groups)
                    _GoalGroupCard(group: g, isActive: identical(g, snapshot.activeGroup)),
                const SizedBox(height: 16),
                _sectionHeader(context, Icons.checklist, '进程'),
                _ProgressCard(snapshot: snapshot),
                const SizedBox(height: 16),
                _sectionHeader(context, Icons.article_outlined, '计划',
                    count: snapshot.plans.length,),
                if (snapshot.plans.isEmpty)
                  _emptyHint(context, '暂无计划（计划模式下生成）')
                else
                  for (final p in snapshot.plans) _GoalGroupCard(group: p),
                const SizedBox(height: 16),
                _sectionHeader(context, Icons.smart_toy_outlined, '智能体',
                    count: threads.length,),
                if (threads.isEmpty)
                  _emptyHint(context, '暂无子智能体活动')
                else
                  for (final t in threads) _SubagentThreadCard(thread: t),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _sectionHeader(BuildContext context, IconData icon, String title,
      {int? count,}) {
    final colors = AppColors.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Row(
        children: [
          Icon(icon, size: 16, color: colors.accent),
          const SizedBox(width: 6),
          Text(title,
              style: TextStyle(
                  color: colors.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,),),
          if (count != null && count > 0) ...[
            const SizedBox(width: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(
                color: colors.bgTertiary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text('$count',
                  style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,),),
            ),
          ],
        ],
      ),
    );
  }

  Widget _emptyHint(BuildContext context, String text) {
    final colors = AppColors.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.border),
      ),
      child: Text(text,
          style: TextStyle(color: colors.textMuted, fontSize: 12),),
    );
  }
}

// ── 目标/计划：组卡片（进度 + todo 列表）──────────────────────────

class _GoalGroupCard extends StatelessWidget {
  final GoalGroup group;
  final bool isActive;

  const _GoalGroupCard({required this.group, this.isActive = false});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final total = group.totalCount;
    final done = group.completedCount;
    final ratio = total == 0 ? 0.0 : done / total;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: isActive ? colors.accent.withValues(alpha: 0.5) : colors.border,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (isActive)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Icon(Icons.play_circle_outline,
                      size: 14, color: colors.accent,),
                ),
              Expanded(
                child: Text(
                  '目标组 ${group.id.isEmpty ? '' : '#${group.id}'}'
                  '${group.isPlan ? '（计划）' : ''}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,),
                ),
              ),
              if (group.startedAt > 0 && group.updatedAt > group.startedAt)
                Text(
                  _fmtDuration(
                      Duration(milliseconds: group.updatedAt - group.startedAt),),
                  style: TextStyle(color: colors.textMuted, fontSize: 11),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: ratio,
                    minHeight: 5,
                    backgroundColor: colors.bgTertiary,
                    valueColor: AlwaysStoppedAnimation<Color>(
                        done >= total && total > 0
                            ? colors.success
                            : colors.accent,),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text('$done/$total',
                  style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                      fontFeatures: const [FontFeature.tabularFigures()],),),
            ],
          ),
          const SizedBox(height: 8),
          for (final t in group.todos) _TodoRow(todo: t),
        ],
      ),
    );
  }
}

class _TodoRow extends StatelessWidget {
  final GoalTodo todo;

  const _TodoRow({required this.todo});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final icon = todo.isCompleted
        ? Icons.check_circle
        : todo.isInProgress
            ? Icons.radio_button_checked
            : Icons.radio_button_unchecked;
    final color = todo.isCompleted
        ? colors.success
        : todo.isInProgress
            ? colors.accent
            : colors.textMuted;
    // in_progress 优先展示 activeForm（引擎的"正在做"描述）
    final text = todo.isInProgress && todo.activeForm.isNotEmpty
        ? todo.activeForm
        : todo.content;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 14, color: color),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontSize: 13,
                color: todo.isCompleted ? colors.textMuted : colors.textPrimary,
                decoration:
                    todo.isCompleted ? TextDecoration.lineThrough : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── 进程：当前 todo 清单 + 运行统计 ──────────────────────────────

class _ProgressCard extends StatelessWidget {
  final GoalSnapshot snapshot;

  const _ProgressCard({required this.snapshot});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final stats = snapshot.stats;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (snapshot.todos.isEmpty)
            Text('当前回合无进行中的清单',
                style: TextStyle(color: colors.textMuted, fontSize: 12),)
          else ...[
            for (final t in snapshot.todos) _TodoRow(todo: t),
          ],
          if (stats != null) ...[
            const SizedBox(height: 10),
            // 上下文占用
            Row(
              children: [
                Text('上下文',
                    style: TextStyle(
                        color: colors.textMuted, fontSize: 11,),),
                const SizedBox(width: 8),
                Expanded(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(3),
                    child: LinearProgressIndicator(
                      value: stats.contextRatio.clamp(0.0, 1.0),
                      minHeight: 5,
                      backgroundColor: colors.bgTertiary,
                      valueColor: AlwaysStoppedAnimation<Color>(
                          stats.contextRatio > 0.85
                              ? colors.error
                              : stats.contextRatio > 0.6
                                  ? colors.warning
                                  : colors.accent,),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '${_fmtTokens(stats.contextUsed)}/${_fmtTokens(stats.contextWindow)}',
                  style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                      fontFeatures: const [FontFeature.tabularFigures()],),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                _statChip(context, '迭代', '${stats.iterationCount}'),
                const SizedBox(width: 8),
                _statChip(context, '工具调用', '${stats.toolCallCount}'),
                const SizedBox(width: 8),
                _statChip(context, '用时',
                    _fmtDuration(Duration(seconds: stats.timeUsedSeconds)),),
                const SizedBox(width: 8),
                _statChip(context, 'Tokens', _fmtTokens(stats.tokensUsed)),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _statChip(BuildContext context, String label, String value) {
    final colors = AppColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('$label ',
              style: TextStyle(color: colors.textMuted, fontSize: 11),),
          Text(value,
              style: TextStyle(
                  color: colors.textSecondary,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  fontFeatures: const [FontFeature.tabularFigures()],),),
        ],
      ),
    );
  }
}

// ── 智能体：子线程卡片 ────────────────────────────────────────────

class _SubagentThreadCard extends StatefulWidget {
  final SubagentThread thread;

  const _SubagentThreadCard({required this.thread});

  @override
  State<_SubagentThreadCard> createState() => _SubagentThreadCardState();
}

class _SubagentThreadCardState extends State<_SubagentThreadCard> {
  bool _expanded = false;

  String _label() {
    final a = widget.thread.agent;
    if (a.isEmpty) return '子智能体';
    final parts = a.split('__');
    return parts.isNotEmpty ? parts.last : a;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final msgs = widget.thread.messages;
    // 摘要：最新一条 assistant 文本的首行
    String? preview;
    for (final m in msgs.reversed) {
      final c = m['content'] as String? ?? '';
      if (c.isNotEmpty && m['role'] != 'user') {
        preview = c.split('\n').first.trim();
        if (preview.length > 60) preview = '${preview.substring(0, 60)}…';
        break;
      }
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Icon(Icons.smart_toy_outlined,
                      size: 15, color: colors.accent,),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${_label()} · ${msgs.length} 条消息',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              color: colors.textPrimary,
                              fontSize: 13,
                              fontWeight: FontWeight.w600,),
                        ),
                        if (preview != null && !_expanded)
                          Text(
                            preview,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                color: colors.textMuted, fontSize: 11,),
                          ),
                      ],
                    ),
                  ),
                  Icon(
                    _expanded
                        ? Icons.keyboard_arrow_up
                        : Icons.keyboard_arrow_down,
                    size: 18,
                    color: colors.textMuted,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final m in msgs)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            m['role'] == 'user' ? '任务' : _label(),
                            style: TextStyle(
                                color: colors.accent,
                                fontSize: 10,
                                fontWeight: FontWeight.w700,),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            m['content'] as String? ?? '',
                            style: TextStyle(
                                color: colors.textSecondary, fontSize: 12,),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ── 格式化工具 ────────────────────────────────────────────────────

String _fmtDuration(Duration d) {
  if (d.inHours > 0) return '${d.inHours}h ${d.inMinutes % 60}m';
  if (d.inMinutes > 0) return '${d.inMinutes}m ${d.inSeconds % 60}s';
  return '${d.inSeconds}s';
}

String _fmtTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
  return '$n';
}
