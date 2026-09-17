import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../zcode/zcode_chat_store.dart';

/// A single session row widget for the session list in the drawer.
/// R1 换接线：数据源 = ZcodeSessionMeta（引擎 session/list 实测字段）。
/// 引擎无 rename/delete/本地消息数概念——相关 UI 随旧栈退役（D5 显式降级）。
/// [pinned] = 本地置顶（SharedPreferences 记忆，非引擎能力）。
/// [busy] = 正在处理（转圈）；[resultDot] = 已完成待查看（绿点）。
class SessionListTile extends StatelessWidget {
  const SessionListTile({
    super.key,
    required this.session,
    required this.isActive,
    required this.onTap,
    this.pinned = false,
    this.busy = false,
    this.resultDot = false,
  });

  final ZcodeSessionMeta session;
  final bool isActive;
  final VoidCallback onTap;
  final bool pinned;
  final bool busy;
  final bool resultDot;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final running = session.status == 'running';
    return InkWell(
      onTap: onTap,
      splashColor: colors.accent.withValues(alpha: 0.12),
      highlightColor: colors.accent.withValues(alpha: 0.12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        color: isActive ? colors.accent.withValues(alpha: 0.12) : null,
        child: Row(
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 16,
              color: isActive ? colors.accent : colors.textMuted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      // 状态提示（标题前）：处理中转圈 > 完成绿点 >
                      // 引擎 running 脉冲点
                      if (busy) ...[
                        SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.8,
                            color: colors.accent,
                          ),
                        ),
                        const SizedBox(width: 6),
                      ] else if (resultDot) ...[
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: colors.success,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                      ] else if (running) ...[
                        _RunningDot(color: colors.success),
                        const SizedBox(width: 5),
                      ],
                      if (pinned) ...[
                        Icon(Icons.push_pin,
                            size: 12, color: colors.textMuted,),
                        const SizedBox(width: 4),
                      ],
                      Expanded(
                        child: Text(
                          session.title,
                          style: TextStyle(
                            fontSize: 14,
                            color:
                                isActive ? colors.textPrimary : colors.textSecondary,
                            fontWeight:
                                isActive ? FontWeight.w600 : FontWeight.normal,
                          ),
                          overflow: TextOverflow.ellipsis,
                          maxLines: 1,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Text(
                        _formatTime(session.updatedAt),
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.textMuted,
                        ),
                      ),
                      if (running) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: colors.success.withValues(alpha: 0.16),
                            borderRadius: BorderRadius.circular(3),
                          ),
                          child: Text(
                            '运行',
                            style: TextStyle(
                              fontSize: 10,
                              color: colors.success,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            if (isActive)
              Icon(
                Icons.check_circle,
                color: colors.accent,
                size: 18,
              ),
          ],
        ),
      ),
    );
  }

  String _formatTime(int epochMs) {
    if (epochMs == 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final now = DateTime.now();
    final diff = now.difference(dt);

    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes}分钟前';
    if (diff.inHours < 24) return '${diff.inHours}小时前';
    if (diff.inDays < 7) return '${diff.inDays}天前';
    return '${dt.month}/${dt.day}';
  }
}

/// 绿色脉冲圆点，表示会话正在运行。
class _RunningDot extends StatefulWidget {
  const _RunningDot({required this.color});

  final Color color;

  @override
  State<_RunningDot> createState() => _RunningDotState();
}

class _RunningDotState extends State<_RunningDot>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
    _anim = Tween<double>(begin: 1.0, end: 0.4).animate(
      CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, __) => Opacity(
        opacity: _anim.value,
        child: Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            color: widget.color,
            shape: BoxShape.circle,
          ),
        ),
      ),
    );
  }
}
