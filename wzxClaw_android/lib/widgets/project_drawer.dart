import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/session_meta.dart';
import '../models/task_model.dart';
import '../services/chat_store.dart';
import '../services/connection_manager.dart';
import '../services/session_sync_service.dart';
import '../services/task_service.dart';
import 'session_list_tile.dart';
import 'task_drawer.dart';

/// Drawer widget displaying the current desktop workspace and its sessions.
class ProjectDrawer extends StatelessWidget {
  const ProjectDrawer({super.key});

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
                _buildTaskSection(context, colors),
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
                String title;
                String subtitle;
                if (connected && identity != null) {
                  title = identity;
                  subtitle = desktop?.platform != null ? '${desktop!.platform}' : '已连接';
                } else if (connected) {
                  title = 'wzxClaw';
                  subtitle = '等待桌面端...';
                } else {
                  title = 'wzxClaw';
                  subtitle = '未连接';
                }
                return Container(
                  height: 120,
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
                                fontSize: 20,
                                color: colors.textPrimary,
                                fontWeight: FontWeight.w500,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        subtitle,
                        style: TextStyle(
                          fontSize: 14,
                          color: colors.textSecondary,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  /// Task section — top-level context showing active task and its projects.
  /// Hierarchy: 任务 → 工程 (projects) → 会话 (below, in session section)
  Widget _buildTaskSection(BuildContext context, AppColors colors) {
    return StreamBuilder<String?>(
      stream: TaskService.instance.activeTaskIdStream,
      initialData: TaskService.instance.activeTaskId,
      builder: (context, activeSnap) {
        final activeId = activeSnap.data;
        final task = activeId != null
            ? TaskService.instance.tasks
                .where((t) => t.id == activeId)
                .firstOrNull
            : null;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Section header row
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 6),
              child: Row(
                children: [
                  Icon(Icons.task_alt, size: 15, color: colors.textSecondary),
                  const SizedBox(width: 8),
                  Text(
                    '任务',
                    style: TextStyle(
                      fontSize: 13,
                      color: colors.textSecondary,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0.3,
                    ),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: () {
                      final navigator = Navigator.of(context);
                      Navigator.pop(context);
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        showTaskDrawer(navigator.context);
                      });
                    },
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
            // Task card or empty state
            if (task != null)
              _buildActiveTaskCard(context, colors, task)
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
                      '未选择任务',
                      style:
                          TextStyle(color: colors.textMuted, fontSize: 13),
                    ),
                    const Spacer(),
                    GestureDetector(
                      onTap: () {
                        final navigator = Navigator.of(context);
                        Navigator.pop(context);
                        WidgetsBinding.instance.addPostFrameCallback((_) {
                          showTaskDrawer(navigator.context);
                        });
                      },
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

  /// Card showing the active task title and its associated projects (工程).
  Widget _buildActiveTaskCard(
      BuildContext context, AppColors colors, TaskModel task,) {
    return StreamBuilder<List<TaskModel>>(
      stream: TaskService.instance.tasksStream,
      initialData: TaskService.instance.tasks,
      builder: (context, snapshot) {
        final latestTask = (snapshot.data ?? [])
                .where((t) => t.id == task.id)
                .firstOrNull ??
            task;
        return Container(
          margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: colors.accent.withValues(alpha: 0.07),
            borderRadius: BorderRadius.circular(8),
            border:
                Border.all(color: colors.accent.withValues(alpha: 0.22)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Task title row
              Row(
                children: [
                  Icon(Icons.play_arrow_rounded,
                      size: 14, color: colors.accent,),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      latestTask.title,
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
              // Projects (工程) — hierarchy level below task
              if (latestTask.projects.isNotEmpty) ...[
                const SizedBox(height: 8),
                ...latestTask.projects.map(
                  (proj) => Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Row(
                      children: [
                        const SizedBox(width: 20),
                        Icon(Icons.folder_outlined,
                            size: 12, color: colors.textMuted,),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(
                            proj.name,
                            style: TextStyle(
                              color: colors.textSecondary,
                              fontSize: 11,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
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
    return StreamBuilder<String?>(
      stream: TaskService.instance.activeTaskIdStream,
      initialData: TaskService.instance.activeTaskId,
      builder: (context, taskSnap) {
        final hasTask = taskSnap.data != null;
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
        if (!hasTask)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text(
              '请先选择任务',
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
