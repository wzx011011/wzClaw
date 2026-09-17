import 'package:flutter/material.dart';
import 'dart:async';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../services/connection_manager.dart';
import '../zcode/zcode_chat_store.dart';
import 'session_list_tile.dart';
import 'swipe_actions_tile.dart';
import 'workspace_switcher_sheet.dart';

/// Drawer widget displaying the current desktop workspace and its sessions.
class ProjectDrawer extends StatefulWidget {
  const ProjectDrawer({super.key});

  @override
  State<ProjectDrawer> createState() => _ProjectDrawerState();
}

class _ProjectDrawerState extends State<ProjectDrawer> {
  static const _kPinnedKey = 'wzxclaw-zcode-pinned-sessions';
  static const _kArchivedKey = 'wzxclaw-zcode-archived-sessions';

  Set<String> _pinnedIds = {};
  Set<String> _archivedIds = {};
  bool _showArchived = false;

  // 会话状态指示：最近一次构建时在跑的会话 / 完成 待查看的绿点
  // （内存态——应用重启后绿点不追溯，正在跑的由 store 实时状态恢复）
  final Set<String> _busySeen = {};
  final Set<String> _resultDots = {};

  @override
  void initState() {
    super.initState();
    _loadLocalState();
  }

  Future<void> _loadLocalState() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _pinnedIds = (prefs.getStringList(_kPinnedKey) ?? const []).toSet();
      _archivedIds = (prefs.getStringList(_kArchivedKey) ?? const []).toSet();
    });
  }

  Future<void> _togglePin(String sessionId) async {
    final next = Set<String>.from(_pinnedIds);
    if (!next.remove(sessionId)) next.add(sessionId);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_kPinnedKey, next.toList());
    if (!mounted) return;
    setState(() => _pinnedIds = next);
  }

  /// 归档 = 本地隐藏（引擎无归档概念）：主列表不显示，收进「已归档」折叠区
  Future<void> _toggleArchive(String sessionId) async {
    final next = Set<String>.from(_archivedIds);
    if (!next.remove(sessionId)) next.add(sessionId);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_kArchivedKey, next.toList());
    if (!mounted) return;
    setState(() => _archivedIds = next);
  }

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
                _buildGoalPanelEntry(context, colors),
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
                                color: connected ? colors.success : colors.error,
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
    return ListenableBuilder(
      listenable: ZcodeChatStore.instance,
      builder: (context, _) {
        final wsName = _currentWorkspaceName();
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

  /// 当前工作区名：取 store 选择态路径末段（无选择/空 = ''）
  String _currentWorkspaceName() {
    final path = ZcodeChatStore.instance.selectedWorkspacePath;
    if (path == null || path.isEmpty) return '';
    return _workspaceDisplayName(path);
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
                        fontWeight: FontWeight.bold,),),
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
                            color: colors.textMuted, fontSize: 12,),)
                          : null,
                      trailing: isSelected
                          ? Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2,),
                              decoration: BoxDecoration(
                                color: colors.accent.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text('当前',
                                  style: TextStyle(
                                      color: colors.accent, fontSize: 12,),),
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

  /// 弹出工作区切换选择器（共享实现，欢迎页同款）
  void _showWorkspaceSwitcher(AppColors colors) {
    showWorkspaceSwitcherSheet(context);
  }

  /// 主列表范围：当前选中工作区的未归档会话（列表跟随上方选择；
  /// 未选择工作区或会话缺工作区信息时不隐藏）。工作区条目的计数徽标
  /// 与会话列表共用同一口径。
  List<ZcodeSessionMeta> _scopedSessions() {
    final store = ZcodeChatStore.instance;
    final selectedKey = store.selectedWorkspaceKey;
    final selectedPath = store.selectedWorkspacePath;
    final hasScope = (selectedKey?.isNotEmpty ?? false) ||
        (selectedPath?.isNotEmpty ?? false);
    bool inScope(ZcodeSessionMeta s) {
      if (_archivedIds.contains(s.sessionId)) return false;
      if (!hasScope) return true;
      if (selectedKey != null &&
          selectedKey.isNotEmpty &&
          s.workspaceKey == selectedKey) {
        return true;
      }
      if (selectedPath != null &&
          selectedPath.isNotEmpty &&
          s.workspacePath == selectedPath) {
        return true;
      }
      return false;
    }

    return store.sessions.where(inScope).toList();
  }

  /// Workspace section — 显示当前工作区及切换按钮。
  Widget _buildWorkspaceSection(BuildContext context, AppColors colors) {
    return ListenableBuilder(
      listenable: ZcodeChatStore.instance,
      builder: (context, _) {
        final wsName = _currentWorkspaceName();
        // 会话计数与会话列表同一口径（当前工作区未归档会话）
        final sessionCount = _scopedSessions().length;

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
                    Text(
                      '$sessionCount 会话',
                      style: TextStyle(
                        fontSize: 11,
                        color: colors.textMuted,
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

  /// 任务面板（悬浮窗还原：目标/进程/计划/智能体）
  Widget _buildGoalPanelEntry(BuildContext context, AppColors colors) {
    return ListTile(
      leading: Icon(Icons.monitor_heart_outlined,
          color: colors.textSecondary, size: 20,),
      title: Text(
        '任务面板',
        style: TextStyle(color: colors.textSecondary, fontSize: 14),
      ),
      dense: true,
      onTap: () {
        Navigator.pop(context);
        Navigator.pushNamed(context, '/goal-panel');
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

  /// 会话区 —— Option A：数据源为手机本地索引（只含手机创建/导入的
  /// 会话），引擎 session/list 仅在「从引擎导入」时显式拉取。
  Widget _buildSessionSection(BuildContext context, AppColors colors) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
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
              // 新任务：进入欢迎态（首条消息时才建引擎会话）
              Builder(
                builder: (context) => GestureDetector(
                  onTap: () {
                    ZcodeChatStore.instance.closeSessionView();
                    if (context.mounted) Navigator.pop(context);
                  },
                  child: Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child:
                        Icon(Icons.add, size: 16, color: colors.textMuted),
                  ),
                ),
              ),
              ListenableBuilder(
                listenable: ZcodeChatStore.instance,
                builder: (context, _) {
                  final isLoading = ZcodeChatStore.instance.sessionsLoading;
                  return GestureDetector(
                    onTap: isLoading
                        ? null
                        : () => ZcodeChatStore.instance.refreshSessions(),
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
        ListenableBuilder(
          listenable: ZcodeChatStore.instance,
          builder: (context, _) {
        final store = ZcodeChatStore.instance;
        // 主列表 = 当前工作区的未归档会话（对齐官方：列表跟随上方
        // 选中的工作区）
        final sessions = _scopedSessions();

            final activeId = store.activeSessionId;

            // 状态转换跟踪：运行中 → 记住；从运行转为非运行 → 挂绿点
            // （点开会话时清除）。绿点只在「看过它跑」的前提下出现，
            // 不伪造官方的云端未读语义。
            for (final s in sessions) {
              final busy = store.isSessionBusy(s.sessionId) ||
                  s.status == 'running';
              if (busy) {
                _busySeen.add(s.sessionId);
                _resultDots.remove(s.sessionId);
              } else if (_busySeen.remove(s.sessionId)) {
                _resultDots.add(s.sessionId);
              }
            }

            Widget mainList;
            if (sessions.isEmpty) {
              final hasElsewhere = store.sessions
                  .any((s) => !_archivedIds.contains(s.sessionId));
              final allArchived = _archivedIds.isNotEmpty;
              mainList = Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Text(
                  hasElsewhere
                      ? '当前工作区暂无会话\n可切换工作区查看其他会话'
                      : (allArchived
                          ? '会话已全部归档\n可在下方展开查看'
                          : '暂无会话记录\n连接大脑节点后自动加载'),
                  style: TextStyle(color: colors.textMuted, fontSize: 13),
                ),
              );
            } else {
            // 列表跟随上方选中的工作区，不再渲染工作区分组头：工作区名
            // 与会话计数由上方专门的工作区条目承载（2026-09-18 用户定）。
            // 排序：置顶优先，其余按引擎排序（新→旧）
            sessions.sort((a, b) {
              final ra = _pinnedIds.contains(a.sessionId) ? 0 : 1;
              final rb = _pinnedIds.contains(b.sessionId) ? 0 : 1;
              if (ra != rb) return ra - rb;
              return b.updatedAt.compareTo(a.updatedAt);
            });

            mainList = Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final session in sessions)
                  SwipeActionsTile(
                      actions: [
                        SwipeAction(
                          label: _pinnedIds.contains(session.sessionId)
                              ? '取消置顶'
                              : '置顶',
                          icon: Icons.push_pin,
                          color: colors.accent,
                          onTap: () => _togglePin(session.sessionId),
                        ),
                        SwipeAction(
                          label: '归档',
                          icon: Icons.archive_outlined,
                          color: const Color(0xFF8B5CF6),
                          onTap: () => _toggleArchive(session.sessionId),
                        ),
                        SwipeAction(
                          label: '结束',
                          icon: Icons.stop_circle_outlined,
                          color: colors.error,
                          onTap: () => ZcodeChatStore.instance
                              .closeSession(session.sessionId),
                        ),
                      ],
                      child: SessionListTile(
                        session: session,
                        pinned: _pinnedIds.contains(session.sessionId),
                        busy: store.isSessionBusy(session.sessionId),
                        resultDot: _resultDots.contains(session.sessionId),
                        isActive: session.sessionId == activeId,
                        onTap: () => _onSessionTap(context, session),
                      ),
                    ),
              ],
            );
            }

            // ── 已归档折叠区：归档会话本地隐藏于此，可取消归档或直接打开 ──
            final archivedSessions = store.sessions
                .where((s) => _archivedIds.contains(s.sessionId))
                .toList()
              ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));

            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                mainList,
                if (archivedSessions.isNotEmpty)
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      InkWell(
                        onTap: () =>
                            setState(() => _showArchived = !_showArchived),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                          child: Row(children: [
                            Icon(
                              _showArchived
                                  ? Icons.expand_less
                                  : Icons.expand_more,
                              size: 14,
                              color: colors.textMuted,
                            ),
                            const SizedBox(width: 6),
                            Text('已归档 ${archivedSessions.length}',
                                style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    color: colors.textMuted,),),
                          ],),
                        ),
                      ),
                      if (_showArchived)
                        for (final session in archivedSessions)
                          SwipeActionsTile(
                            actions: [
                              SwipeAction(
                                label: '取消归档',
                                icon: Icons.unarchive_outlined,
                                color: colors.accent,
                                onTap: () =>
                                    _toggleArchive(session.sessionId),
                              ),
                            ],
                            child: SessionListTile(
                              session: session,
                              isActive: session.sessionId == activeId,
                              onTap: () => _onSessionTap(context, session),
                            ),
                          ),
                    ],
                  ),
              ],
            );
          },
        ),
      ],
    );
  }

  Future<void> _onSessionTap(
    BuildContext context,
    ZcodeSessionMeta session,
  ) async {
    // 统一入口：openSession（materialize + 订阅 + 补放）；抽屉先收起，
    // 拉取在后台继续。点开即消费完成绿点。
    _resultDots.remove(session.sessionId);
    _busySeen.remove(session.sessionId);
    unawaited(ZcodeChatStore.instance.openSession(session.sessionId));
    if (context.mounted) Navigator.pop(context);
  }

  /// 工作区组名：取路径末段（E:\ai\wzxClaw → wzxClaw；非路径 key 原样）
  String _workspaceDisplayName(String key) {
    final normalized = key.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
    final idx = normalized.lastIndexOf('/');
    if (idx >= 0 && idx < normalized.length - 1) {
      return normalized.substring(idx + 1);
    }
    return key;
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
