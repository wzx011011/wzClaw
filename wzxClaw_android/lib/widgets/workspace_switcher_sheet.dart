import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/git_service.dart';
import '../services/session_sync_service.dart';
import 'workspace_picker_card.dart';

/// 工作区切换底部弹层（抽屉与「新任务」欢迎页共用）。
///
/// 数据仍来自引擎 session/list 聚合（app-server 无独立工作区接口）；
/// 选中后写入手机本地每设备记忆（ConnectionManager._respondWorkspaceSwitch）。
/// 列表按 companion x/fs/exists 过滤已不存在的目录（会话历史会残留
/// 已删除/改名的工作区，即「老数据」）；过滤失败（旧 companion/未连接）
/// 时如实展示全量，不隐藏。
Future<void> showWorkspaceSwitcherSheet(BuildContext context) async {
  final colors = AppColors.of(context);
  SessionSyncService.instance.fetchWorkspaces();
  // exists 探测的 memo（按 workspaces 实例失效）：builder 每帧重建时不得重发
  List<WorkspaceItem>? probedWorkspaces;
  Future<List<bool>>? existsFuture;

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
              // 过滤已不存在的目录：x/fs/exists 批量探测；探测中/失败展示全量。
              // future 按 workspaces 实例 memoize——builder 每帧重建时不得
              // 反复重发探测请求
              if (!identical(probedWorkspaces, workspaces)) {
                probedWorkspaces = workspaces;
                existsFuture = GitService.instance
                    .existingDirs(
                      [for (final w in workspaces) w.primaryPath ?? ''],
                    )
                    .catchError(
                        (_) => List<bool>.filled(workspaces.length, true),);
              }
              final currentExistsFuture = existsFuture;
              return FutureBuilder<List<bool>>(
                future: currentExistsFuture,
                builder: (context, exSnap) {
                  final exists = exSnap.data;
                  final visible = (exists == null)
                      ? workspaces
                      : [
                          for (var i = 0; i < workspaces.length; i++)
                            if (exists[i]) workspaces[i],
                        ];
                  final hiddenCount = workspaces.length - visible.length;
                  if (visible.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Text(
                        hiddenCount > 0 ? '工作区目录均已不存在' : '暂无工作区',
                        style: TextStyle(color: colors.textMuted, fontSize: 14),
                      ),
                    );
                  }
                  return Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (hiddenCount > 0)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
                          child: Text(
                            '已隐藏 $hiddenCount 个已不存在的目录',
                            style: TextStyle(
                                color: colors.textMuted, fontSize: 12,),
                          ),
                        ),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: MediaQuery.of(ctx).size.height * 0.55,
                        ),
                        child: ListView.builder(
                          shrinkWrap: true,
                          itemCount: visible.length,
                          itemBuilder: (ctx, i) {
                            final ws = visible[i];
                            return WorkspacePickerCard(
                              workspace: ws,
                              colors: colors,
                              onWorkspaceTap: () {
                                Navigator.pop(ctx);
                                final path = ws.primaryPath;
                                if (path != null && path.isNotEmpty) {
                                  SessionSyncService.instance
                                      .switchWorkspace(path);
                                }
                              },
                              onSessionTap: (sessionId) {
                                Navigator.pop(ctx);
                                // 统一入口：活跃位+切窗+全量拉取三件套——
                                // 只 setActiveSession 会造成半切换（标题换了、
                                // 消息和发送目标还在旧会话）
                                SessionSyncService.instance.openSession(sessionId);
                                final path = ws.primaryPath;
                                if (path != null && path.isNotEmpty) {
                                  SessionSyncService.instance
                                      .switchWorkspace(path);
                                }
                              },
                            );
                          },
                        ),
                      ),
                    ],
                  );
                },
              );
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}
