import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/session_meta.dart';
import '../services/chat_store.dart';
import '../services/connection_manager.dart';
import '../services/session_sync_service.dart';
import 'session_list_tile.dart';
import 'workspace_picker_card.dart';

/// Drawer widget displaying the current desktop workspace and its sessions.
class ProjectDrawer extends StatefulWidget {
  const ProjectDrawer({super.key});

  @override
  State<ProjectDrawer> createState() => _ProjectDrawerState();
}

class _ProjectDrawerState extends State<ProjectDrawer> {

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Drawer(
      backgroundColor: colors.bgPrimary,
      width: 304,
      child: Column(
        children: [
          _buildHeader(colors),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                _buildWorkspaceSection(context, colors),
                Divider(color: colors.border, height: 1),
                _buildSessionSection(context, colors),
                Divider(color: colors.border, height: 1),
                _buildFileBrowseEntry(context, colors),
              ],
            ),
          ),
          _buildFooter(colors),
        ],
      ),
    );
  }

  Widget _buildHeader(AppColors colors) {
    return StreamBuilder<WsConnectionState>(
      stream: ConnectionManager.instance.stateStream,
      initialData: ConnectionManager.instance.state,
      builder: (context, connSnap) {
        final connState = connSnap.data ?? WsConnectionState.disconnected;
        return StreamBuilder<String?>(
          stream: ConnectionManager.instance.selectedDesktopIdStream,
          initialData: ConnectionManager.instance.selectedDesktopId,
          builder: (context, selectedSnap) {
            return StreamBuilder<String?>(
              stream: ConnectionManager.instance.desktopIdentityStream,
              initialData: ConnectionManager.instance.desktopIdentity,
              builder: (context, identitySnap) {
                final identity = identitySnap.data;
                final selectedId = selectedSnap.data;
                final desktops = ConnectionManager.instance.desktops;
                final desktop = selectedId != null
                    ? desktops.where((d) => d.desktopId == selectedId).firstOrNull
                    : null;
                final connected = connState == WsConnectionState.connected;

                // Build subtitle with workspace name integrated
                String subtitle;
                if (connected && desktop?.platform != null) {
                  subtitle = desktop!.platform!;
                } else if (connected) {
                  subtitle = '已连接';
                } else {
                  subtitle = '未连接';
                }

                String title;
                if (connected && identity != null) {
                  title = identity;
                } else {
                  title = 'wzxClaw';
                }

                return GestureDetector(
                  onTap: connected ? () => _showDesktopSwitcher(colors) : null,
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                    decoration: BoxDecoration(
                      color: colors.bgSecondary,
                      border: Border(
                        bottom: BorderSide(color: colors.accent, width: 3),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: connected ? Colors.green : Colors.red,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                title,
                                style: TextStyle(
                                  fontSize: 18,
                                  color: colors.textPrimary,
                                  fontWeight: FontWeight.w500,
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (connected)
                              Icon(
                                Icons.swap_horiz,
                                size: 16,
                                color: colors.textMuted,
                              ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        _buildWorkspaceSubtitle(colors, subtitle, connected),
                      ],
                    ),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  /// Subtitle line: platform · workspaceName (integrated, not separate row)
  Widget _buildWorkspaceSubtitle(AppColors colors, String platformInfo, bool connected) {
    if (!connected) {
      return Text(
        platformInfo,
        style: TextStyle(fontSize: 13, color: colors.textSecondary),
        overflow: TextOverflow.ellipsis,
      );
    }
    return StreamBuilder<WorkspaceInfo?>(
      stream: SessionSyncService.instance.workspaceInfoStream,
      initialData: SessionSyncService.instance.workspaceInfo,
      builder: (context, wsSnap) {
        final wsInfo = wsSnap.data;
        final wsName = wsInfo?.workspaceName ?? '';
        final display = wsName.isNotEmpty
            ? '$platformInfo · $wsName'
            : platformInfo;
        return Text(
          display,
          style: TextStyle(
            fontSize: 13,
            color: wsName.isNotEmpty ? colors.textSecondary : colors.textMuted,
          ),
          overflow: TextOverflow.ellipsis,
        );
      },
    );
  }

  /// 弹出桌面端选择器
  void _showDesktopSwitcher(AppColors colors) {
    final desktops = ConnectionManager.instance.desktops;
    if (desktops.isEmpty) return;

    showModalBottomSheet(
      context: context,
      backgroundColor: colors.bgSecondary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        final selectedId = ConnectionManager.instance.selectedDesktopId;
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Row(
                  children: [
                    Text('选择桌面端',
                        style: TextStyle(
                            color: colors.textPrimary,
                            fontSize: 16,
                            fontWeight: FontWeight.bold)),
                    const Spacer(),
                    IconButton(
                      icon: Icon(Icons.close, color: colors.textMuted),
                      onPressed: () => Navigator.pop(ctx),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(),
                    ),
                  ],
                ),
              ),
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(ctx).size.height * 0.45,
                ),
                child: ListView.builder(
                  shrinkWrap: true,
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  itemCount: desktops.length,
                  itemBuilder: (ctx, i) {
                    final d = desktops[i];
                    final isSelected = d.desktopId == selectedId;
                    return ListTile(
                      leading: Icon(
                        isSelected ? Icons.computer : Icons.computer_outlined,
                        color: isSelected ? colors.accent : colors.textSecondary,
                      ),
                      title: Text(
                        d.displayLabel,
                        style: TextStyle(
                          color: isSelected ? colors.accent : colors.textPrimary,
                          fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                        ),
                      ),
                      subtitle: d.platform != null
                          ? Text(d.platform!,
                              style: TextStyle(
                                  color: colors.textMuted, fontSize: 11))
                          : null,
                      trailing: isSelected
                          ? Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: colors.accent.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text('当前',
                                  style: TextStyle(
                                      color: colors.accent, fontSize: 11)),
                            )
                          : null,
                      onTap: () {
                        Navigator.pop(ctx);
                        ConnectionManager.instance.selectDesktop(d.desktopId);
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  /// 弹出工作区切换选择器
  void _showWorkspaceSwitcher(AppColors colors) {
    SessionSyncService.instance.fetchWorkspaces();

    showModalBottomSheet(
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
                  Text('切换工作区',
                      style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.bold)),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => Navigator.pop(ctx),
                    child: Text('关闭',
                        style: TextStyle(color: colors.textMuted, fontSize: 13)),
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
                    child: Text('暂无工作区',
                        style: TextStyle(color: colors.textMuted, fontSize: 14)),
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

  /// Workspace section — 显示当前工作区及切换按钮。
  Widget _buildWorkspaceSection(BuildContext context, AppColors colors) {
    return StreamBuilder<WorkspaceInfo?>(
      stream: SessionSyncService.instance.workspaceInfoStream,
      initialData: SessionSyncService.instance.workspaceInfo,
      builder: (context, wsSnap) {
        final wsInfo = wsSnap.data;
        final wsName = wsInfo?.workspaceName ?? '';

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Section header row
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 6),
              child: Row(
                children: [
                  Icon(Icons.folder_outlined, size: 15, color: colors.textSecondary),
                  const SizedBox(width: 8),
                  Text(
                    '工作区',
                    style: TextStyle(
                      fontSize: 13,
                      color: colors.textSecondary,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0.3,
                    ),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => _showWorkspaceSwitcher(colors),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(
                        Icons.swap_horiz_rounded,
                        size: 17,
                        color: colors.textMuted,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            // Workspace card or empty state
            if (wsName.isNotEmpty)
              Container(
                margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                decoration: BoxDecoration(
                  color: colors.accent.withValues(alpha: 0.07),
                  borderRadius: BorderRadius.circular(8),
                  border:
                      Border.all(color: colors.accent.withValues(alpha: 0.22)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.folder_open, size: 14, color: colors.accent),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        wsName,
                        style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                child: Row(
                  children: [
                    Icon(
                      Icons.radio_button_unchecked,
                      size: 13,
                      color: colors.textMuted,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '未选择工作区',
                      style:
                          TextStyle(color: colors.textMuted, fontSize: 13),
                    ),
                    const Spacer(),
                    GestureDetector(
                      onTap: () => _showWorkspaceSwitcher(colors),
                      child: Text(
                        '选择',
                        style:
                            TextStyle(color: colors.accent, fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildFileBrowseEntry(BuildContext context, AppColors colors) {
    return ListTile(
      leading: Icon(Icons.folder_open, color: colors.textSecondary, size: 20),
      title: Text(
        '浏览文件',
        style: TextStyle(color: colors.textSecondary, fontSize: 14),
      ),
      dense: true,
      onTap: () {
        Navigator.pop(context);
        Navigator.pushNamed(context, '/files');
      },
    );
  }

  Widget _buildSessionSection(BuildContext context, AppColors colors) {
    return StreamBuilder<WorkspaceInfo?>(
      stream: SessionSyncService.instance.workspaceInfoStream,
      initialData: SessionSyncService.instance.workspaceInfo,
      builder: (context, wsSnap) {
        final hasWorkspace = wsSnap.data != null;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Row(
            children: [
              Icon(Icons.history, size: 16, color: colors.textSecondary),
              const SizedBox(width: 8),
              Text(
                '会话',
                style: TextStyle(
                  fontSize: 14,
                  color: colors.textSecondary,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const Spacer(),
              Builder(
                builder: (context) => GestureDetector(
                  onTap: () async {
                    final result =
                        await SessionSyncService.instance.createSession();
                    if (result != null) {
                      final sessionId = result['id'] as String?;
                      if (sessionId != null) {
                        SessionSyncService.instance.setActiveSession(sessionId);
                        ChatStore.instance.switchToSession(sessionId);
                        if (context.mounted) Navigator.pop(context);
                      }
                    }
                  },
                  child: Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child:
                        Icon(Icons.add, size: 16, color: colors.textMuted),
                  ),
                ),
              ),
              StreamBuilder<bool>(
                stream: SessionSyncService.instance.loadingStream,
                initialData: SessionSyncService.instance.isLoading,
                builder: (context, snapshot) {
                  final isLoading = snapshot.data ?? false;
                  return GestureDetector(
                    onTap: isLoading
                        ? null
                        : () =>
                            SessionSyncService.instance.fetchSessions(),
                    child: isLoading
                        ? SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(
                              strokeWidth: 1.5,
                              color: colors.textMuted,
                            ),
                          )
                        : Icon(
                            Icons.refresh,
                            size: 16,
                            color: colors.textMuted,
                          ),
                  );
                },
              ),
            ],
          ),
        ),
        if (!hasWorkspace)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text(
              '请先选择工作区',
              style: TextStyle(color: colors.textMuted, fontSize: 13),
            ),
          )
        else
        StreamBuilder<List<SessionMeta>>(
          stream: SessionSyncService.instance.sessionsStream,
          initialData: SessionSyncService.instance.sessions,
          builder: (context, snapshot) {
            final sessions = snapshot.data ?? [];

            if (sessions.isEmpty) {
              return Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Text(
                  '暂无会话记录',
                  style: TextStyle(color: colors.textMuted, fontSize: 13),
                ),
              );
            }

            return StreamBuilder<String?>(
              stream: SessionSyncService.instance.activeSessionStream,
              initialData: SessionSyncService.instance.activeSessionId,
              builder: (context, activeSnapshot) {
                final activeId = activeSnapshot.data;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: sessions.map((session) {
                    final isActive = session.id == activeId;
                    return SessionListTile(
                      session: session,
                      isActive: isActive,
                      onTap: () => _onSessionTap(context, session),
                    );
                  }).toList(),
                );
              },
            );
          },
        ),
          ],
        );
      },
    );
  }

  Future<void> _onSessionTap(BuildContext context, SessionMeta session) async {
    SessionSyncService.instance.setActiveSession(session.id);

    try {
      final result =
          await SessionSyncService.instance.loadSessionMessages(session.id);
      final messages = result['messages'] as List<dynamic>? ?? [];
      ChatStore.instance.switchToSession(session.id);
      if (messages.isNotEmpty) {
        ChatStore.instance.loadFetchedMessages(messages.cast());
      }
    } catch (_) {
      ChatStore.instance.switchToSession(session.id);
    }

    if (context.mounted) Navigator.pop(context);
  }

  Widget _buildFooter(AppColors colors) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: colors.border, width: 0.5),
        ),
      ),
      child: StreamBuilder<WsConnectionState>(
        stream: ConnectionManager.instance.stateStream,
        initialData: ConnectionManager.instance.state,
        builder: (context, snapshot) {
          final state = snapshot.data ?? WsConnectionState.disconnected;
          final dotColor = _statusColor(state);
          return Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: dotColor,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                state.label,
                style: TextStyle(
                  color: dotColor,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Color _statusColor(WsConnectionState state) {
    switch (state) {
      case WsConnectionState.connected:
        return Colors.green;
      case WsConnectionState.connecting:
      case WsConnectionState.reconnecting:
        return Colors.orange;
      case WsConnectionState.disconnected:
        return Colors.red;
    }
  }
}
