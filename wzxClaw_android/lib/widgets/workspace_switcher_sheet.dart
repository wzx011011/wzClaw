import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../zcode/zcode_chat_store.dart';

/// 工作区切换抽屉（R3 直连栈版）：数据 = store.sessions 按 workspaceKey
/// 分组（引擎 session/list 实测字段，无独立请求）；选择 = store.selectWorkspace，
/// 影响 newSession 的 workspace 参数。引擎无「当前工作区」状态，选择仅本机生效。
Future<void> showWorkspaceSwitcherSheet(BuildContext context) {
  final store = ZcodeChatStore.instance;
  store.refreshSessions();
  final colors = AppColors.of(context);
  return showModalBottomSheet(
    context: context,
    backgroundColor: colors.bgSecondary,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => SafeArea(
      child: ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final groups = <String, List<ZcodeSessionMeta>>{};
          for (final s in store.sessions) {
            final key = s.workspaceKey ?? s.workspacePath ?? '未分组';
            (groups[key] ??= []).add(s);
          }
          int newest(List<ZcodeSessionMeta> l) =>
              l.map((e) => e.updatedAt).reduce((a, b) => a > b ? a : b);
          final entries = groups.entries.toList()
            ..sort((a, b) => newest(b.value).compareTo(newest(a.value)));
          final activeId = store.activeSessionId;

          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Row(children: [
                  Text('选择工作区',
                      style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,),),
                  const Spacer(),
                  Text('共 ${entries.length} 个',
                      style: TextStyle(color: colors.textMuted, fontSize: 11.5,),),
                ],),
              ),
              if (entries.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                  child: Text('暂无工作区：请先在桌面端创建一个会话',
                      style: TextStyle(
                          color: colors.textMuted, fontSize: 12.5,),),
                ),
              for (final entry in entries)
                ListTile(
                  dense: true,
                  leading: Icon(Icons.folder_outlined,
                      size: 18, color: colors.textSecondary,),
                  title: Text(_basename(entry.key),
                      style: TextStyle(
                          color: colors.textPrimary, fontSize: 13.5,),),
                  subtitle: Text(entry.key,
                      style: TextStyle(color: colors.textMuted, fontSize: 11,),
                      overflow: TextOverflow.ellipsis,),
                  trailing: entry.value.any((s) => s.sessionId == activeId)
                      ? Icon(Icons.check_circle, size: 16, color: colors.accent)
                      : Text('${entry.value.length}',
                          style: TextStyle(
                              color: colors.textMuted, fontSize: 11.5,),),
                  onTap: () {
                    final path = entry.value
                            .firstWhere((s) => s.workspacePath != null,
                                orElse: () => entry.value.first,)
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
  );
}

String _basename(String p) {
  final n = p.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
  final i = n.lastIndexOf('/');
  return i >= 0 && i < n.length - 1 ? n.substring(i + 1) : p;
}
