import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/session_sync_service.dart';

/// 工作区选择卡片：仅展示工作区本身（名称/路径），点按即切换。
/// 不再列出工作区下的具体会话——会话入口统一走主界面的会话抽屉，
/// 避免同一份会话在两处列表漂移（2026-09-16 用户定稿）。
class WorkspacePickerCard extends StatelessWidget {
  const WorkspacePickerCard({
    super.key,
    required this.workspace,
    required this.colors,
    required this.onWorkspaceTap,
  });

  final WorkspaceItem workspace;
  final AppColors colors;
  final VoidCallback onWorkspaceTap;

  @override
  Widget build(BuildContext context) {
    final ws = workspace;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: onWorkspaceTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Icon(
                  ws.archived ? Icons.folder_outlined : Icons.folder_open,
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
                              color: colors.textMuted, fontSize: 11,),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                Icon(Icons.arrow_forward_ios,
                    size: 14, color: colors.textMuted,),
              ],
            ),
          ),
        ),
        Divider(height: 1, color: colors.border),
      ],
    );
  }
}
