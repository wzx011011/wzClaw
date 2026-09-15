import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/session_sync_service.dart';
import 'workspace_picker_card.dart';

/// 工作区切换底部弹层（抽屉与「新任务」欢迎页共用）。
///
/// 数据仍来自引擎 session/list 聚合（app-server 无独立工作区接口）；
/// 选中后写入手机本地每设备记忆（ConnectionManager._respondWorkspaceSwitch）。
Future<void> showWorkspaceSwitcherSheet(BuildContext context) async {
  final colors = AppColors.of(context);
  SessionSyncService.instance.fetchWorkspaces();

  await showModalBottomSheet(
    context: context,
    backgroundColor: colors.bgSecondary,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(
              children: [
                Text(
                  '切换工作区',
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => Navigator.pop(ctx),
                  child: Text(
                    '关闭',
                    style: TextStyle(color: colors.textMuted, fontSize: 13),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          StreamBuilder<List<WorkspaceItem>>(
            stream: SessionSyncService.instance.workspacesStream,
            initialData: SessionSyncService.instance.workspaces,
            builder: (context, snapshot) {
              final workspaces = snapshot.data ?? [];
              if (workspaces.isEmpty) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24),
                  child: Text(
                    '暂无工作区',
                    style: TextStyle(color: colors.textMuted, fontSize: 14),
                  ),
                );
              }
              return ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(ctx).size.height * 0.55,
                ),
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: workspaces.length,
                  itemBuilder: (ctx, i) {
                    final ws = workspaces[i];
                    return WorkspacePickerCard(
                      workspace: ws,
                      colors: colors,
                      onWorkspaceTap: () {
                        Navigator.pop(ctx);
                        final path = ws.primaryPath;
                        if (path != null && path.isNotEmpty) {
                          SessionSyncService.instance.switchWorkspace(path);
                        }
                      },
                      onSessionTap: (sessionId) {
                        Navigator.pop(ctx);
                        final path = ws.primaryPath;
                        if (path != null && path.isNotEmpty) {
                          SessionSyncService.instance.switchWorkspace(path);
                        }
                        SessionSyncService.instance.setActiveSession(sessionId);
                      },
                    );
                  },
                ),
              );
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}
