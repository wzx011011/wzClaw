import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/session_sync_service.dart';

/// 可展开的工作区卡片，显示工作区信息和会话列表。
class WorkspacePickerCard extends StatefulWidget {
  const WorkspacePickerCard({
    super.key,
    required this.workspace,
    required this.colors,
    required this.onWorkspaceTap,
    required this.onSessionTap,
  });

  final WorkspaceItem workspace;
  final AppColors colors;
  final VoidCallback onWorkspaceTap;
  final void Function(String sessionId) onSessionTap;

  @override
  State<WorkspacePickerCard> createState() => _WorkspacePickerCardState();
}

class _WorkspacePickerCardState extends State<WorkspacePickerCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final ws = widget.workspace;
    final colors = widget.colors;
    final sessions = ws.sessions;
    final hasSessions = sessions.isNotEmpty;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 工作区头部
        InkWell(
          onTap: () {
            if (hasSessions) {
              setState(() => _expanded = !_expanded);
            } else {
              widget.onWorkspaceTap();
            }
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Icon(
                  ws.archived
                      ? Icons.folder_outlined
                      : Icons.folder_open,
                  color: ws.archived ? colors.textSecondary : colors.accent,
                  size: 22,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        ws.title,
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontWeight: FontWeight.w600,
                          fontSize: 15,
                        ),
                      ),
                      if (ws.primaryPath != null &&
                          ws.primaryPath!.isNotEmpty)
                        Text(
                          ws.primaryPath!,
                          style: TextStyle(
                              color: colors.textMuted, fontSize: 11),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                if (hasSessions)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: colors.accent.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          '${sessions.length}',
                          style: TextStyle(color: colors.accent, fontSize: 11),
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded
                            ? Icons.expand_less
                            : Icons.expand_more,
                        size: 18,
                        color: colors.textMuted,
                      ),
                    ],
                  )
                else
                  Icon(Icons.arrow_forward_ios,
                      size: 14, color: colors.textMuted),
              ],
            ),
          ),
        ),

        // 展开的会话列表
        if (_expanded && hasSessions)
          Container(
            margin: const EdgeInsets.only(left: 28, right: 8),
            padding: const EdgeInsets.only(left: 12),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(color: colors.border, width: 1),
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: sessions.map((session) {
                final isRunning =
                    session.id == ws.activeSessionId;
                return InkWell(
                  onTap: () => widget.onSessionTap(session.id),
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 8),
                    child: Row(
                      children: [
                        // 运行状态指示灯
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: isRunning
                                ? colors.success
                                : colors.textMuted,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment:
                                CrossAxisAlignment.start,
                            children: [
                              Text(
                                session.title,
                                style: TextStyle(
                                  fontSize: 13,
                                  color: colors.textPrimary,
                                  fontWeight: isRunning
                                      ? FontWeight.w600
                                      : FontWeight.normal,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '${session.messageCount} 条消息${_formatTime(session.updatedAt)}',
                                style: TextStyle(
                                    fontSize: 11,
                                    color: colors.textMuted),
                              ),
                            ],
                          ),
                        ),
                        if (isRunning)
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              color: colors.success
                                  .withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '运行中',
                              style: TextStyle(
                                  color: colors.success, fontSize: 10),
                            ),
                          ),
                      ],
                    ),
                  ),
                );
              }).toList(),
            ),
          ),

        // "进入工作区"按钮
        if (_expanded && hasSessions)
          Padding(
            padding: const EdgeInsets.only(left: 52, bottom: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: widget.onWorkspaceTap,
                style: TextButton.styleFrom(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(
                  '进入工作区 (默认会话)',
                  style:
                      TextStyle(color: colors.accent, fontSize: 12),
                ),
              ),
            ),
          ),

        Divider(height: 1, color: colors.border),
      ],
    );
  }

  String _formatTime(int epochMs) {
    if (epochMs <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(epochMs);
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return ' · 刚刚';
    if (diff.inMinutes < 60) return ' · ${diff.inMinutes}分钟前';
    if (diff.inHours < 24) return ' · ${diff.inHours}小时前';
    return ' · ${dt.month}/${dt.day}';
  }
}
