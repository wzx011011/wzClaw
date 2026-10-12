import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/node_catalog_service.dart';
import '../zcode/zcode_chat_store.dart';
import 'node_directory_picker_sheet.dart';

/// 工作区切换抽屉：合并引擎 session/list 的真实会话工作区与用户明确导入
/// 的工作区快照；导入项不伪造会话数量。选择仅影响新会话 workspace 参数。
Future<void> showWorkspaceSwitcherSheet(BuildContext context) {
  final store = ZcodeChatStore.instance;
  store.refreshSessions();
  final importedFuture = NodeCatalogService.instance.importedWorkspaces();
  final colors = AppColors.of(context);
  return showModalBottomSheet(
    context: context,
    backgroundColor: colors.bgSecondary,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => SafeArea(
      child: FutureBuilder<List<String>>(
        future: importedFuture,
        builder: (context, importedSnapshot) => ListenableBuilder(
          listenable: store,
          builder: (context, _) {
            final groups = <String, List<ZcodeSessionMeta>>{};
            for (final s in store.sessions) {
              final key = s.workspaceKey ?? s.workspacePath ?? '未分组';
              (groups[key] ??= []).add(s);
            }
            for (final path in importedSnapshot.data ?? const <String>[]) {
              groups.putIfAbsent(path, () => <ZcodeSessionMeta>[]);
            }
            int newest(List<ZcodeSessionMeta> sessions) => sessions.isEmpty
                ? 0
                : sessions
                    .map((session) => session.updatedAt)
                    .reduce((a, b) => a > b ? a : b);
            final entries = groups.entries.toList()
              ..sort((a, b) => newest(b.value).compareTo(newest(a.value)));
            final activeId = store.activeSessionId;

            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                  child: Row(
                    children: [
                      Text(
                        '选择工作区',
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '共 ${entries.length} 个',
                        style: TextStyle(
                          color: colors.textMuted,
                          fontSize: 11.5,
                        ),
                      ),
                    ],
                  ),
                ),
                // 任意目录浏览：不依赖已有会话/导入快照，直接逐级选节点
                // 目录作为新会话工作区（x/fs/dirs；probe-wscreate 实测
                // session/create 接受任意未注册目录）
                ListTile(
                  dense: true,
                  leading: Icon(
                    Icons.folder_open,
                    size: 18,
                    color: colors.accent,
                  ),
                  title: Text(
                    '浏览节点目录…',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  subtitle: Text(
                    '从桌面节点选择任意文件夹作为工作区',
                    style: TextStyle(color: colors.textMuted, fontSize: 11),
                  ),
                  onTap: () async {
                    final picked = await showNodeDirectoryPicker(ctx);
                    if (picked != null && picked.isNotEmpty && ctx.mounted) {
                      store.selectWorkspace(basenameOf(picked), picked);
                      Navigator.pop(ctx);
                    }
                  },
                ),
                const Divider(height: 1),
                if (entries.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                    child: Text(
                      '暂无历史工作区：点上方「浏览节点目录」选择一个文件夹，'
                      '或在桌面端创建会话后自动出现',
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
                for (final entry in entries)
                  ListTile(
                    dense: true,
                    leading: Icon(
                      Icons.folder_outlined,
                      size: 18,
                      color: colors.textSecondary,
                    ),
                    title: Text(
                      _basename(entry.key),
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 13.5,
                      ),
                    ),
                    subtitle: Text(
                      entry.key,
                      style: TextStyle(
                        color: colors.textMuted,
                        fontSize: 11,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    trailing: entry.value.any(
                      (session) => session.sessionId == activeId,
                    )
                        ? Icon(
                            Icons.check_circle,
                            size: 16,
                            color: colors.accent,
                          )
                        : Text(
                            entry.value.isEmpty
                                ? '已导入'
                                : '${entry.value.length}',
                            style: TextStyle(
                              color: colors.textMuted,
                              fontSize: 11.5,
                            ),
                          ),
                    onTap: () {
                      final path = entry.value.isEmpty
                          ? entry.key
                          : entry.value
                                  .firstWhere(
                                    (session) => session.workspacePath != null,
                                    orElse: () => entry.value.first,
                                  )
                                  .workspacePath ??
                              entry.key;
                      store.selectWorkspace(entry.key, path);
                      Navigator.pop(ctx);
                    },
                  ),
                const SizedBox(height: 8),
              ],
            );
          },
        ),
      ),
    ),
  );
}

String _basename(String path) => basenameOf(path);

/// 路径末段（兼容 \ 与 / 分隔符）；picker 与本表共用
String basenameOf(String path) {
  final normalized = path.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
  final separator = normalized.lastIndexOf('/');
  return separator >= 0 && separator < normalized.length - 1
      ? normalized.substring(separator + 1)
      : path;
}
