import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../zcode/zcode_chat_store.dart';

/// 路径分隔符（末级目录名提取用；预编译避免每行瓦片每次重建重复构造）
final RegExp _trailingPathSep = RegExp(r'[/\\]+$');
final RegExp _pathSep = RegExp(r'[/\\]');

/// 抽屉会话列表的单行瓦片（zcode 换芯版）。
///
/// 数据源从旧 relay 协议栈的 SessionMeta 改为 ZcodeSessionMeta
/// （lib/zcode/zcode_chat_store.dart）：
/// - 运行中判定 = status == 'running'（session/list 的状态徽标），
///   显示绿色脉冲圆点；
/// - 第二行小字 = updatedAt 相对时间 + workspacePath 末级目录名；
/// - isActive 由调用方传入（ZcodeSessionMeta 本身无活动标记，是否
///   活动是 store 的视口状态 activeSessionId，调用方比对即可）；
/// - 旧版的 messageCount / isSynced 缓存徽标 / 长按重命名与删除
///   在 zcode 协议中无对应能力，已随换芯移除。
class SessionListTile extends StatelessWidget {
  const SessionListTile({
    super.key,
    required this.session,
    required this.isActive,
    required this.onTap,
  });

  final ZcodeSessionMeta session;
  final bool isActive;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final running = session.status == 'running';
    final wsPath = session.workspacePath;
    final wsLabel =
        wsPath == null || wsPath.isEmpty ? null : _workspaceLabel(wsPath);
    final timeLabel = _formatTime(session.updatedAt);
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
                      if (running) ...[
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
                      // updatedAt 缺失（0）时不渲染空 Text 与间隙
                      if (timeLabel.isNotEmpty)
                        Text(
                          timeLabel,
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.textMuted,
                          ),
                        ),
                      if (wsLabel != null) ...[
                        if (timeLabel.isNotEmpty) const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            wsLabel,
                            style: TextStyle(
                              fontSize: 12,
                              color: colors.textMuted,
                            ),
                            overflow: TextOverflow.ellipsis,
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

  /// 工作区路径只显示最后一级目录名（与 zcode_page._workspaceLabel 同逻辑；
  /// 先去掉结尾分隔符，'C:\repo\' → 'repo'）
  String _workspaceLabel(String path) {
    final trimmed = path.replaceAll(_trailingPathSep, '');
    final parts = trimmed.split(_pathSep);
    return parts.isEmpty || parts.last.isEmpty ? path : parts.last;
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
