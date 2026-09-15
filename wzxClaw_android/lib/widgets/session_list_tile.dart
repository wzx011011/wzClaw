import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/session_meta.dart';
import '../services/session_sync_service.dart';

/// A single session row widget for the session list in the drawer.
class SessionListTile extends StatelessWidget {
  const SessionListTile({
    super.key,
    required this.session,
    required this.isActive,
    required this.onTap,
  });

  final SessionMeta session;
  final bool isActive;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final statusLabel = _statusLabel(session);
    return InkWell(
      onTap: onTap,
      onLongPress: () => _showSessionActions(context, session),
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
                      if (session.taskState?.isActive == true || session.isRunning) ...[
                        _RunningDot(color: colors.success),
                        const SizedBox(width: 5),
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
                      const SizedBox(width: 8),
                      Text(
                        '${session.messageCount} 条消息',
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.textMuted,
                        ),
                      ),
                      if (statusLabel != null) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: _statusColor(colors, session).withValues(alpha: 0.16),
                            borderRadius: BorderRadius.circular(3),
                          ),
                          child: Text(
                            statusLabel,
                            style: TextStyle(
                              fontSize: 10,
                              color: _statusColor(colors, session),
                            ),
                          ),
                        ),
                      ],
                      if (!session.isSynced) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: colors.border,
                            borderRadius: BorderRadius.circular(3),
                          ),
                          child: Text(
                            '缓存',
                            style: TextStyle(
                              fontSize: 10,
                              color: colors.textMuted,
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

  String? _statusLabel(SessionMeta session) {
    switch (session.taskState?.status) {
      case 'starting':
        return '启动';
      case 'running':
        return '运行';
      case 'waiting_permission':
      case 'waiting_user':
        return '等待';
      case 'stopping':
        return '停止中';
      case 'failed':
        return '失败';
      case 'cancelled':
        return '已停止';
      case 'interrupted':
        return '中断';
    }
    return session.isRunning ? '运行' : null;
  }

  Color _statusColor(AppColors colors, SessionMeta session) {
    switch (session.taskState?.status) {
      case 'failed':
        return colors.error;
      case 'waiting_permission':
      case 'waiting_user':
      case 'stopping':
        return colors.warning;
      default:
        return colors.accent;
    }
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

  void _showSessionActions(BuildContext context, SessionMeta session) {
    final colors = AppColors.of(context);
    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgElevated,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.edit, color: colors.textSecondary),
              title: Text('重命名',
                  style: TextStyle(color: colors.textPrimary),),
              onTap: () {
                Navigator.pop(ctx);
                _showRenameDialog(context, session);
              },
            ),
            ListTile(
              leading: Icon(Icons.delete, color: colors.error),
              title: Text('删除', style: TextStyle(color: colors.error)),
              onTap: () {
                Navigator.pop(ctx);
                _showDeleteConfirm(context, session);
              },
            ),
          ],
        ),
      ),
    );
  }

  void _showRenameDialog(BuildContext context, SessionMeta session) {
    final colors = AppColors.of(context);
    final controller = TextEditingController(text: session.title);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('重命名会话', style: TextStyle(color: colors.textPrimary)),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: TextStyle(color: colors.textPrimary),
          decoration: InputDecoration(
            hintText: '输入新名称',
            hintStyle: TextStyle(color: colors.textMuted),
            enabledBorder: UnderlineInputBorder(
              borderSide: BorderSide(color: colors.border),
            ),
            focusedBorder: UnderlineInputBorder(
              borderSide: BorderSide(color: colors.accent),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              final title = controller.text.trim();
              if (title.isNotEmpty) {
                SessionSyncService.instance.renameSession(session.id, title);
              }
              Navigator.pop(ctx);
            },
            child: const Text('确定'),
          ),
        ],
      ),
    ).then((_) => controller.dispose());
  }

  void _showDeleteConfirm(BuildContext context, SessionMeta session) {
    final colors = AppColors.of(context);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('删除会话', style: TextStyle(color: colors.textPrimary)),
        content: Text(
          '确定删除 "${session.title}" 吗？此操作不可撤销。',
          style: TextStyle(color: colors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              SessionSyncService.instance.deleteSession(session.id);
              Navigator.pop(ctx);
            },
            child: Text('删除', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    );
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
