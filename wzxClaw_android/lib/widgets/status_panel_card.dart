// ============================================================
// status_panel_card — 悬浮状态面板（官方 chat.statusPanel 的手机端还原）
//
// 布局对齐官方移动端卡片：卡片头 = 「Git 工具」标题 + ⋯ 菜单（刷新/
// 收起为胶囊/关闭）+ ⤢（打开任务面板全屏页）；Git 板块行为 更改 +N -M、
// 分支、提交或推送（→ git.actionMenu 动作流）；随后 目标（① 目标文本
// n/m + goalStats 计时）、进程（已完成折叠）、智能体（tap → 任务面板）。
// 所有取数失败显性降级（隐藏板块），不做假数据、不留死按钮。
// ============================================================

import 'dart:async';
import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/goal_snapshot.dart';
import '../services/git_service.dart';
import '../services/goal_store.dart';
import '../models/ui_prefs.dart';
import '../zcode/zcode_chat_store.dart';
import 'git_action_sheets.dart';
import 'review_sheet.dart';

/// 组装好的板块数据（纯渲染入参，widget 测试直接构造）
class StatusPanelData {
  final GitRepoStatus? git;
  final GoalSnapshot goal;
  final List<SubagentThread> threads;

  const StatusPanelData({
    this.git,
    required this.goal,
    this.threads = const [],
  });

  /// 胶囊摘要文案（最要紧的一项；全空 = '状态'）
  String capsuleLabel() {
    final g = git;
    if (g != null && g.hasChanges) {
      return '+${g.added} -${g.removed}';
    }
    final active = goal.activeGroup;
    if (active != null && active.totalCount > 0) {
      return '${active.completedCount}/${active.totalCount}';
    }
    if (threads.isNotEmpty) return '${threads.length} 智能体';
    return '状态';
  }
}

/// 纯渲染卡片（无取数逻辑；宿主传入数据与回调）
class StatusPanelCard extends StatelessWidget {
  final StatusPanelData data;
  final VoidCallback onClose;
  final VoidCallback onCollapse;
  final VoidCallback onRefresh;
  final VoidCallback onOpenGoalPanel;
  final VoidCallback onGitActionDone;
  final void Function(String workspacePath) onOpenBranchSheet;

  /// goal 快捷动作（pause/resume；null = 宿主不支持）
  final void Function(String action)? onGoalAction;
  final String? workspacePath;
  final bool refreshing;

  const StatusPanelCard({
    super.key,
    required this.data,
    required this.onClose,
    required this.onCollapse,
    required this.onRefresh,
    required this.onOpenGoalPanel,
    required this.onGitActionDone,
    required this.onOpenBranchSheet,
    this.onGoalAction,
    this.workspacePath,
    this.refreshing = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Material(
      color: colors.bgSecondary,
      borderRadius: BorderRadius.circular(14),
      elevation: 6,
      shadowColor: Colors.black54,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: colors.border),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── 卡片头 = Git 板块标题 + ⋯ 菜单 + ⤢（官方布局）─────────
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 4, 0),
              child: Row(
                children: [
                  Text(
                    'Git 工具',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  if (refreshing)
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8),
                      child: SizedBox(
                        width: 13,
                        height: 13,
                        child: CircularProgressIndicator(strokeWidth: 1.6),
                      ),
                    ),
                  PopupMenuButton<String>(
                    icon: Icon(
                      Icons.more_horiz,
                      size: 18,
                      color: colors.textMuted,
                    ),
                    tooltip: '更多',
                    onSelected: (v) {
                      switch (v) {
                        case 'refresh':
                          onRefresh();
                        case 'collapse':
                          onCollapse();
                        case 'close':
                          onClose();
                      }
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'refresh', child: Text('刷新')),
                      PopupMenuItem(value: 'collapse', child: Text('收起为胶囊')),
                      PopupMenuItem(value: 'close', child: Text('关闭')),
                    ],
                  ),
                  IconButton(
                    icon: Icon(
                      Icons.open_in_full,
                      size: 14,
                      color: colors.textMuted,
                    ),
                    tooltip: '打开任务面板',
                    onPressed: onOpenGoalPanel,
                  ),
                  // 调用轨迹（对齐官方侧栏轨迹标签；session/debug 进程内快照）
                  IconButton(
                    icon: Icon(
                      Icons.route_outlined,
                      size: 14,
                      color: colors.textMuted,
                    ),
                    tooltip: '调用轨迹',
                    onPressed: () =>
                        Navigator.of(context).pushNamed('/trace-panel'),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: colors.border),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (data.git != null) ...[
                      _gitChangesRow(context, colors, data.git!),
                      _gitBranchRow(colors, data.git!),
                      _gitCommitPushRow(context, colors),
                    ] else
                      Padding(
                        padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
                        child: Text(
                          workspacePath == null || workspacePath!.isEmpty
                              ? '未选择工作区'
                              : '当前目录不是 git 仓库',
                          style: TextStyle(
                            color: colors.textMuted,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    _divider(colors),
                    _goalRow(colors),
                    _divider(colors),
                    _TodoSection(goal: data.goal),
                    if (data.threads.isNotEmpty) ...[
                      _divider(colors),
                      _AgentsSection(
                        threads: data.threads,
                        onOpenGoalPanel: onOpenGoalPanel,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _divider(AppColors colors) =>
      Divider(height: 1, indent: 12, endIndent: 12, color: colors.border);

  // ── 更改 +N -M（tap → 审查 sheet，阶段 3c）───────────────────────
  Widget _gitChangesRow(
    BuildContext context,
    AppColors colors,
    GitRepoStatus git,
  ) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 2),
      child: InkWell(
        onTap: git.hasChanges && (workspacePath ?? '').isNotEmpty
            ? () => _openReviewSheet(context)
            : null,
        child: Row(
          children: [
          Icon(
            Icons.difference_outlined,
            size: 15,
            color: git.hasChanges ? colors.textPrimary : colors.textMuted,
          ),
          const SizedBox(width: 10),
          Text(
            git.hasChanges ? '更改' : '干净',
            style: TextStyle(
              color: git.hasChanges ? colors.textPrimary : colors.textMuted,
              fontSize: 13.5,
            ),
          ),
          const Spacer(),
          Text(
            '+${formatThousands(git.added)}',
            style: TextStyle(
              color: git.added > 0 ? colors.success : colors.textMuted,
              fontSize: 13,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            '-${formatThousands(git.removed)}',
            style: TextStyle(
              color: git.removed > 0 ? colors.error : colors.textMuted,
              fontSize: 13,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
        ),
      ),
    );
  }

  /// 审查 sheet（阶段 3c）：restored=true（发生过撤销）时经宿主刷新 git 状态
  Future<void> _openReviewSheet(BuildContext sheetContext) async {
    final restored = await showReviewSheet(sheetContext, workspacePath!);
    if (restored) onGitActionDone();
  }

  // ── 分支（tap → 分支抽屉）────────────────────────────────────────
  Widget _gitBranchRow(AppColors colors, GitRepoStatus git) {
    return InkWell(
      onTap: () => onOpenBranchSheet(workspacePath ?? ''),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 4),
        child: Row(
          children: [
            Icon(
              Icons.account_tree_outlined,
              size: 15,
              color: colors.textMuted,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                git.branch.isEmpty ? '（detached HEAD）' : git.branch,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
              ),
            ),
            Icon(Icons.keyboard_arrow_down, size: 17, color: colors.textMuted),
          ],
        ),
      ),
    );
  }

  // ── 提交或推送（tap → git.actionMenu 动作流）────────────────────
  Widget _gitCommitPushRow(BuildContext context, AppColors colors) {
    final ws = workspacePath ?? '';
    return InkWell(
      onTap: ws.isEmpty
          ? null
          : () => showGitActionSheet(
                context,
                workspacePath: ws,
                onDone: onGitActionDone,
              ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
        child: Row(
          children: [
            Icon(Icons.commit_outlined, size: 15, color: colors.textMuted),
            const SizedBox(width: 10),
            Text(
              '提交或推送',
              style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
            ),
          ],
        ),
      ),
    );
  }

  // ── 目标：① 目标文本 n/m + 计时（官方行形态）────────────────────
  Widget _goalRow(AppColors colors) {
    final goal = data.goal;
    final active = goal.activeGroup;
    final hasGoal = active != null && active.totalCount > 0;
    final seconds = goal.timeUsedSeconds;
    return InkWell(
      onTap: onOpenGoalPanel, // 打开任务面板（真实导航）
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '目标',
                  style: TextStyle(
                    color: colors.textSecondary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (seconds > 0)
                  Text(
                    _fmtDuration(seconds),
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                if (goal.target?.status == 'complete')
                  Icon(Icons.check_circle, size: 14, color: colors.success),
                if (onGoalAction != null &&
                    seconds > 0 &&
                    (goal.target?.status == 'active' ||
                        goal.target?.status == 'paused'))
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(minWidth: 26),
                    icon: Icon(
                      goal.target?.status == 'paused'
                          ? Icons.play_arrow
                          : Icons.pause,
                      size: 17,
                      color: colors.accent,
                    ),
                    tooltip: goal.target?.status == 'paused' ? '恢复目标' : '暂停目标',
                    onPressed: () => onGoalAction!(
                      goal.target?.status == 'paused' ? 'resume' : 'pause',
                    ),
                  ),
                Icon(Icons.chevron_right, size: 15, color: colors.textMuted),
              ],
            ),
            if (hasGoal) ...[
              const SizedBox(height: 4),
              Row(
                children: [
                  Container(
                    width: 16,
                    height: 16,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: colors.accent, width: 1.4),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '1',
                      style: TextStyle(
                        color: colors.accent,
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      goal.objectiveText,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '${active.completedCount}/${active.totalCount}',
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 12.5,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ] else
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '暂无进行中的目标',
                  style: TextStyle(color: colors.textMuted, fontSize: 12),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _fmtDuration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    if (h > 0) return '$h小时$m分$s秒';
    if (m > 0) return '$m分$s秒';
    return '$s秒';
  }
}

// ── 进程：todo 清单（已完成折叠，官方同款）──────────────────────────

class _TodoSection extends StatefulWidget {
  final GoalSnapshot goal;

  const _TodoSection({required this.goal});

  @override
  State<_TodoSection> createState() => _TodoSectionState();
}

class _TodoSectionState extends State<_TodoSection> {
  bool _beforeExpanded = false;
  bool _afterExpanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final active = widget.goal.activeGroup;
    final todos = active?.todos ?? const <GoalTodo>[];

    // 当前项 = 首个进行中；否则首个未完成；无则 null。
    // 全部完成时官方实测全展开不折叠（live 截图 5/5 全部删除线直出）；
    // 混合状态才折叠：之前的项 → 「已完成/前面」，之后的项 → 「待处理/后面」。
    var current = todos.indexWhere((t) => t.isInProgress);
    if (current < 0) current = todos.indexWhere((t) => !t.isCompleted);
    final allCompleted = todos.isNotEmpty && current < 0;
    final before = current > 0 ? todos.sublist(0, current) : const <GoalTodo>[];
    final after = current >= 0 && current + 1 <= todos.length - 1
        ? todos.sublist(current + 1)
        : const <GoalTodo>[];

    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '进程',
                style: TextStyle(
                  color: colors.textSecondary,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                '${active?.completedCount ?? 0}/${active?.totalCount ?? 0}',
                style: TextStyle(
                  color: colors.textMuted,
                  fontSize: 12,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          if (todos.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '暂无清单',
                style: TextStyle(color: colors.textMuted, fontSize: 12),
              ),
            )
          else if (allCompleted) ...[
            // 全完成：全部展开直出（官方同款）
            for (final t in todos)
              _PanelTodoRow(
                icon: Icons.check_circle,
                color: colors.success,
                text: t.content,
                done: true,
              ),
          ] else ...[
            if (before.isNotEmpty)
              _fold(
                colors,
                expanded: _beforeExpanded,
                onToggle: () =>
                    setState(() => _beforeExpanded = !_beforeExpanded),
                label: before.every((t) => t.isCompleted)
                    ? '已完成 ${before.length} 项'
                    : '前面 ${before.length} 项',
                expandedLabel: before.every((t) => t.isCompleted)
                    ? '收起 ${before.length} 项已完成'
                    : '收起 ${before.length} 项前面内容',
                rows: [
                  for (final t in before)
                    _PanelTodoRow(
                      icon: t.isInProgress
                          ? Icons.radio_button_checked
                          : t.isCompleted
                              ? Icons.check_circle
                              : Icons.radio_button_unchecked,
                      color: t.isInProgress
                          ? colors.accent
                          : t.isCompleted
                              ? colors.success
                              : colors.textMuted,
                      text: t.isInProgress && t.activeForm.isNotEmpty
                          ? t.activeForm
                          : t.content,
                      done: t.isCompleted,
                    ),
                ],
              ),
            if (current >= 0)
              _PanelTodoRow(
                icon: todos[current].isInProgress
                    ? Icons.radio_button_checked
                    : todos[current].isCompleted
                        ? Icons.check_circle
                        : Icons.radio_button_unchecked,
                color: todos[current].isInProgress
                    ? colors.accent
                    : todos[current].isCompleted
                        ? colors.success
                        : colors.textPrimary,
                text: todos[current].isInProgress &&
                        todos[current].activeForm.isNotEmpty
                    ? todos[current].activeForm
                    : todos[current].content,
                done: todos[current].isCompleted,
              ),
            if (after.isNotEmpty)
              _fold(
                colors,
                expanded: _afterExpanded,
                onToggle: () =>
                    setState(() => _afterExpanded = !_afterExpanded),
                label: after.every((t) => !t.isCompleted)
                    ? '待处理 ${after.length} 项'
                    : '后面 ${after.length} 项',
                expandedLabel: after.every((t) => !t.isCompleted)
                    ? '收起 ${after.length} 项待处理'
                    : '收起 ${after.length} 项后面内容',
                rows: [
                  for (final t in after)
                    _PanelTodoRow(
                      icon: t.isInProgress
                          ? Icons.radio_button_checked
                          : t.isCompleted
                              ? Icons.check_circle
                              : Icons.radio_button_unchecked,
                      color: t.isInProgress
                          ? colors.accent
                          : t.isCompleted
                              ? colors.success
                              : colors.textMuted,
                      text: t.isInProgress && t.activeForm.isNotEmpty
                          ? t.activeForm
                          : t.content,
                      done: t.isCompleted,
                    ),
                ],
              ),
          ],
        ],
      ),
    );
  }

  Widget _fold(
    AppColors colors, {
    required bool expanded,
    required VoidCallback onToggle,
    required String label,
    String? expandedLabel,
    required List<Widget> rows,
  }) {
    final shownLabel = expanded ? (expandedLabel ?? label) : label;
    return Column(
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: onToggle,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              children: [
                Icon(
                  expanded ? Icons.expand_less : Icons.expand_more,
                  size: 14,
                  color: colors.textMuted,
                ),
                const SizedBox(width: 6),
                Text(
                  shownLabel,
                  style: TextStyle(color: colors.textMuted, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
        if (expanded) ...rows,
      ],
    );
  }
}

class _PanelTodoRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;
  final bool done;

  const _PanelTodoRow({
    required this.icon,
    required this.color,
    required this.text,
    this.done = false,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: done ? colors.textMuted : colors.textPrimary,
                fontSize: 12.5,
                decoration: done ? TextDecoration.lineThrough : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── 智能体：子线程列表（tap → 任务面板）─────────────────────────────

class _AgentsSection extends StatelessWidget {
  final List<SubagentThread> threads;
  final VoidCallback onOpenGoalPanel;

  const _AgentsSection({
    required this.threads,
    required this.onOpenGoalPanel,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      onTap: onOpenGoalPanel,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '智能体',
                  style: TextStyle(
                    color: colors.textSecondary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                Text(
                  '${threads.length}',
                  style: TextStyle(color: colors.textMuted, fontSize: 12),
                ),
              ],
            ),
            for (final t in threads.take(3))
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Row(
                  children: [
                    Icon(
                      Icons.subdirectory_arrow_right,
                      size: 13,
                      color: colors.textMuted,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        '${t.label} · ${t.messages.length} 条消息',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            if (threads.length > 3)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '还有 ${threads.length - 3} 个线程…',
                  style: TextStyle(color: colors.textMuted, fontSize: 11),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ── 悬浮容器：取数 + 胶囊 + 拖动（宿主放入 Stack）───────────────────

class FloatingStatusPanel extends StatefulWidget {
  final VoidCallback onClose;

  /// 工作区目录（git 板块数据源；空 = 显示「未选择工作区」）
  final String? workspacePath;

  /// 分支抽屉打开器（宿主注入，复用既有 showGitBranchSheet）
  final void Function(String workspacePath) onOpenBranchSheet;

  /// 当前会话是否运行中（auto 策略的展开依据）
  final bool sessionBusy;

  const FloatingStatusPanel({
    super.key,
    required this.onClose,
    required this.onOpenBranchSheet,
    this.sessionBusy = false,
    this.workspacePath,
  });

  @override
  State<FloatingStatusPanel> createState() => _FloatingStatusPanelState();
}

class _FloatingStatusPanelState extends State<FloatingStatusPanel> {
  bool _capsule = false;
  bool _refreshing = false;
  GitRepoStatus? _git;
  bool _gitUnavailable = false;
  Offset _dragOffset = const Offset(16, 80);

  /// 用户手动收起/展开过后，auto 策略不再自动切形态（不抢用户操作）
  bool _userChangedForm = false;

  /// 跟踪策略变化（全局 notifier 不经 widget 参数，需本地镜像）
  StatusPanelStrategy? _lastStrategy;

  static bool _resolveCapsule(StatusPanelStrategy strategy, bool busy) =>
      switch (strategy) {
        StatusPanelStrategy.expanded => false,
        StatusPanelStrategy.collapsed => true,
        StatusPanelStrategy.auto => !busy, // 空闲胶囊、运行中展开
      };

  @override
  void initState() {
    super.initState();
    _lastStrategy = UiPrefs.statusPanelStrategy.value;
    _capsule = _resolveCapsule(
      UiPrefs.statusPanelStrategy.value,
      widget.sessionBusy,
    );
    _refresh();
  }

  @override
  void didUpdateWidget(FloatingStatusPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 工作区变更必须重拉（审查 P1-2）：不清旧数据会显示 A 的分支/差异、
    // 却对 B 的工作区执行动作
    if (oldWidget.workspacePath != widget.workspacePath) {
      _refresh();
    }
    final strategy = UiPrefs.statusPanelStrategy.value;
    if (_lastStrategy != strategy) {
      // 策略切换：重置手动标记并按新策略重解析形态
      _lastStrategy = strategy;
      _userChangedForm = false;
      setState(() => _capsule = _resolveCapsule(strategy, widget.sessionBusy));
    } else if (oldWidget.sessionBusy != widget.sessionBusy &&
        strategy == StatusPanelStrategy.auto &&
        !_userChangedForm) {
      setState(() => _capsule = !widget.sessionBusy);
    }
  }

  Future<void> _refresh() async {
    setState(() => _refreshing = true);
    unawaited(GoalStore.instance.refresh());
    final ws = widget.workspacePath;
    GitRepoStatus? git;
    var unavailable = false;
    if (ws != null && ws.isNotEmpty) {
      try {
        git = await GitService.instance.repoStatus(ws);
      } catch (_) {
        unavailable = true; // 非 git 仓库/离线：如实隐藏板块
      }
    } else {
      unavailable = true;
    }
    if (!mounted) return;
    // 在途期间工作区已切换：旧工作区的查询结果不回填（审查 P1-2）；
    // didUpdateWidget 已为新区触发下一次 _refresh
    if (widget.workspacePath != ws) return;
    setState(() {
      _git = git;
      _gitUnavailable = unavailable;
      _refreshing = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    // 订阅 GoalStore：goal/threads 刷新完成（含回合边界自动刷新）立即
    // 重建——此前只在宿主偶发重建时顺带读取，空闲期面板/胶囊会停留在
    // 上一次的旧快照
    return ListenableBuilder(
      listenable: GoalStore.instance,
      builder: (context, _) => _buildPanel(context),
    );
  }

  Widget _buildPanel(BuildContext context) {
    final screen = MediaQuery.of(context).size;

    if (_capsule) {
      final capsuleColors = AppColors.of(context);
      return Positioned(
        right: 16,
        top: 60, // 任务头下方、会话区顶部右侧（官方胶囊位置）
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: () => setState(() => _capsule = false),
          onLongPress: widget.onClose,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              color: capsuleColors.bgSecondary,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: capsuleColors.border),
              boxShadow: const [
                BoxShadow(
                  color: Colors.black38,
                  blurRadius: 8,
                  offset: Offset(0, 2),
                ),
              ],
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.monitor_heart_outlined,
                  size: 14,
                  color: capsuleColors.accent,
                ),
                const SizedBox(width: 6),
                Text(
                  _data.capsuleLabel(),
                  style: TextStyle(
                    color: capsuleColors.textPrimary,
                    fontSize: 12,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final maxDx = screen.width - 240;
    final maxDy = screen.height - 320;
    final dx = _dragOffset.dx.clamp(8.0, maxDx < 8 ? 8.0 : maxDx);
    final dy = _dragOffset.dy.clamp(60.0, maxDy < 60 ? 60.0 : maxDy);

    return Positioned(
      left: dx,
      top: dy,
      child: SizedBox(
        width: (screen.width * 0.86).clamp(260.0, 360.0),
        height: screen.height * 0.62,
        child: GestureDetector(
          onPanUpdate: (d) => setState(() {
            _dragOffset = Offset(
              _dragOffset.dx + d.delta.dx,
              _dragOffset.dy + d.delta.dy,
            );
          }),
          child: StatusPanelCard(
            data: _data,
            refreshing: _refreshing,
            onRefresh: _refresh,
            onClose: widget.onClose,
            onCollapse: () => setState(() {
              _capsule = true;
              _userChangedForm = true;
            }),
            onOpenGoalPanel: () {
              widget.onClose();
              Navigator.of(context).pushNamed('/goal-panel');
            },
            onGitActionDone: _refresh,
            onGoalAction: (action) async {
              final ok = await ZcodeChatStore.instance.goalAction(action);
              if (ok) await _refresh();
            },
            onOpenBranchSheet: widget.onOpenBranchSheet,
            workspacePath: widget.workspacePath,
          ),
        ),
      ),
    );
  }

  StatusPanelData get _data => StatusPanelData(
        git: _gitUnavailable ? null : _git,
        goal: GoalStore.instance.snapshot,
        threads: GoalStore.instance.threads,
      );
}
