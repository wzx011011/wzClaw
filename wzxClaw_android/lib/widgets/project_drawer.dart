import 'dart:async';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../pages/files_placeholder_page.dart';
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_desktop_registry.dart';
import '../zcode/zcode_pair_scanner.dart';
import 'session_list_tile.dart';

/// 路径分隔符（末级目录名提取用；预编译避免每次重建重复构造）
final RegExp _trailingPathSep = RegExp(r'[/\\]+$');
final RegExp _pathSep = RegExp(r'[/\\]');

/// 抽屉：桌面 ZCode 会话列表（zcode 换芯版）。
///
/// 数据源从旧 relay 协议栈（ConnectionManager / SessionSyncService /
/// ChatStore / WorkspacePickerCard）整体改绑 ZcodeChatStore：
/// - AnimatedBuilder(store) 单一驱动，替代原先多个 StreamBuilder 订阅；
/// - 头部连接状态点映射 ZcodeConnState（配色对齐 zcode_page 的
///   _buildConnBadge：matched 绿 / waiting 橙 / connecting accent / idle 灰），
///   副标题 = 当前活动会话 workspacePath 的末级目录名；
/// - 会话区块 = store.sessions → 按工作区分组（zcode 桌面端同款）→
///   SessionListTile，tap 即 store.openSession 并收起抽屉（聊天页由
///   外层响应 store 的视口变化）；分组可折叠（默认展开）；store.error
///   非空时在区块顶部显示一行错误提示（点击重试 = refreshSessions）；
/// - 「浏览文件」入口保留位置但置灰：zcode app-server 暂无文件树 API，
///   点击进入 FilesPlaceholderPage 占位页。
class ProjectDrawer extends StatefulWidget {
  const ProjectDrawer({super.key, this.store});

  /// 测试注入替身用；null 时使用全局单例
  /// （home_page 的 `const ProjectDrawer()` 形态保持兼容）
  final ZcodeChatStore? store;

  @override
  State<ProjectDrawer> createState() => _ProjectDrawerState();
}

class _ProjectDrawerState extends State<ProjectDrawer> {
  /// 新建会话 in-flight 闩：防连点重复发 session/create（完成后释放）
  bool _creating = false;

  /// 折叠中的工作区分组 key（workspaceKey ?? workspacePath；默认全展开）
  final Set<String> _collapsedGroups = {};

  ZcodeChatStore get _store => widget.store ?? ZcodeChatStore.instance;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final store = _store;
    return Drawer(
      backgroundColor: colors.bgPrimary,
      width: 304,
      child: AnimatedBuilder(
        animation: store,
        builder: (context, _) {
          return Column(
            children: [
              _buildHeader(colors, store),
              Expanded(
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    _buildBrainNetworkEntry(context, colors),
                    Divider(color: colors.border, height: 1),
                    _buildSessionSection(context, colors, store),
                    Divider(color: colors.border, height: 1),
                    _buildFileBrowseEntry(context, colors),
                  ],
                ),
              ),
              _buildFooter(colors, store),
            ],
          );
        },
      ),
    );
  }

  /// 头部：连接状态点 + 标题 + 活动会话的工作区名；点击弹出桌面切换器
  Widget _buildHeader(AppColors colors, ZcodeChatStore store) {
    final dotColor = _connColor(colors, store.connState);
    final activeId = store.activeSessionId;
    final activeWs = _activeMeta(store)?.workspacePath;

    // 副标题三态：无活动会话 / 活动会话带工作区 / 视口已打开但列表快照
    // 缺该会话（列表刷新失败或尚未包含）——最后一态用中性占位，不误报
    final String subtitle;
    final Color subtitleColor;
    if (activeId == null) {
      subtitle = '未选择会话';
      subtitleColor = colors.textMuted;
    } else if (activeWs != null && activeWs.isNotEmpty) {
      subtitle = _workspaceLabel(activeWs);
      subtitleColor = colors.textSecondary;
    } else {
      subtitle = '会话已打开';
      subtitleColor = colors.textSecondary;
    }

    return GestureDetector(
      onTap: () => _showDesktopSwitcher(context),
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
                    color: dotColor,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '桌面 ZCode',
                    style: TextStyle(
                      fontSize: 18,
                      color: colors.textPrimary,
                      fontWeight: FontWeight.w500,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                // 多桌面切换入口提示
                Icon(Icons.swap_horiz, size: 16, color: colors.textMuted),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              subtitle,
              style: TextStyle(
                fontSize: 13,
                color: subtitleColor,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }

  /// 桌面切换器：列出全部已配对桌面（名称 + 连接状态点 + 活动标记 + 删除），
  /// 底部「扫描添加新桌面」。切换 = 换注册表活动指针（页面零重建成本）。
  Future<void> _showDesktopSwitcher(BuildContext context) async {
    final registry = ZcodeDesktopRegistry.instance;
    final colors = AppColors.of(context);
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: colors.bgPrimary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetContext) => AnimatedBuilder(
        animation: registry,
        builder: (context, _) {
          final entries = registry.entries;
          return SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '已配对桌面（${entries.length}）',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: colors.textSecondary,
                      ),
                    ),
                  ),
                ),
                if (entries.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 20, vertical: 12,),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        '暂无已配对桌面，扫码添加第一台',
                        style: TextStyle(
                            fontSize: 13, color: colors.textMuted,),
                      ),
                    ),
                  )
                else
                  for (final entry in entries)
                    ListTile(
                      leading: Icon(
                        Icons.desktop_windows_outlined,
                        size: 20,
                        color: registry.activeId == entry.id
                            ? colors.accent
                            : colors.textMuted,
                      ),
                      title: Text(
                        entry.name,
                        style: TextStyle(
                          fontSize: 14,
                          color: registry.activeId == entry.id
                              ? colors.textPrimary
                              : colors.textSecondary,
                          fontWeight: registry.activeId == entry.id
                              ? FontWeight.w500
                              : FontWeight.w400,
                        ),
                      ),
                      subtitle: _connSubtitle(registry, entry, colors),
                      trailing: IconButton(
                        icon: Icon(Icons.delete_outline,
                            size: 18, color: colors.textMuted,),
                        tooltip: '解除配对',
                        onPressed: () {
                          registry.remove(entry.id);
                        },
                      ),
                      onTap: () {
                        registry.setActive(entry.id);
                        Navigator.pop(sheetContext);
                      },
                    ),
                const Divider(height: 1),
                ListTile(
                  leading: Icon(Icons.qr_code_scanner,
                      size: 20, color: colors.accent,),
                  title: Text(
                    '扫描添加新桌面',
                    style: TextStyle(fontSize: 14, color: colors.textPrimary),
                  ),
                  onTap: () async {
                    Navigator.pop(sheetContext);
                    final scanned = await Navigator.push<String>(
                      context,
                      MaterialPageRoute(
                          builder: (_) => const ZcodePairScannerPage(),),
                    );
                    if (scanned == null || scanned.isEmpty) return;
                    final ok =
                        await registry.addFromPairingUrl(scanned);
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(ok ? '桌面已添加并切换' : '配对链接无效'),
                        ),
                      );
                    }
                  },
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// 切换器条目副标题：该桌面的连接状态文案
  Widget? _connSubtitle(
    ZcodeDesktopRegistry registry,
    ZcodeDesktopEntry entry,
    AppColors colors,
  ) {
    final store = registry.storeOf(entry.id);
    if (store == null) return null;
    return Text(
      _connLabel(store.connState),
      style: TextStyle(fontSize: 12, color: colors.textMuted),
    );
  }

  /// 会话区块：错误提示 / 新建刷新按钮 / 加载占位 / 会话瓦片列表
  Widget _buildSessionSection(
    BuildContext context,
    AppColors colors,
    ZcodeChatStore store,
  ) {
    final sessions = store.sessions;
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
              GestureDetector(
                onTap: _creating ? null : _onNewSession,
                child: Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: _creating
                      ? SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.5,
                            color: colors.textMuted,
                          ),
                        )
                      : Icon(Icons.add, size: 16, color: colors.textMuted),
                ),
              ),
              GestureDetector(
                onTap: store.sessionsLoading
                    ? null
                    : () => unawaited(store.refreshSessions()),
                child: store.sessionsLoading
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
              ),
            ],
          ),
        ),
        // 错误面：store 的失败文案（新建/打开/刷新失败等），点击重试刷新
        if (store.error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: GestureDetector(
              onTap: () => unawaited(store.refreshSessions()),
              child: Text(
                store.error!,
                style: TextStyle(color: colors.error, fontSize: 12),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        // 首次加载中先出加载占位，避免空态闪现
        if (store.sessionsLoading)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text(
              '会话加载中…',
              style: TextStyle(color: colors.textMuted, fontSize: 13),
            ),
          )
        else if (sessions.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text(
              '暂无会话记录',
              style: TextStyle(color: colors.textMuted, fontSize: 13),
            ),
          )
        else
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final group in _groupSessions(sessions))
                _buildGroup(context, colors, store, group),
            ],
          ),
      ],
    );
  }

  /// 会话按工作区分组（zcode 桌面端同款）：workspaceKey ?? workspacePath
  /// 聚合；组内 updatedAt 降序，组间按组内最新降序。探针实测（probe-
  /// workspaces.js）：session/list 全量条目带 workspace（key+path），
  /// 组名 = 路径末级目录名，与桌面端分组完全吻合
  List<MapEntry<String, List<ZcodeSessionMeta>>> _groupSessions(
    List<ZcodeSessionMeta> sessions,
  ) {
    final byKey = <String, List<ZcodeSessionMeta>>{};
    for (final s in sessions) {
      final key = s.workspaceKey ?? s.workspacePath ?? '';
      byKey.putIfAbsent(key, () => []).add(s);
    }
    final groups = byKey.entries.map((e) {
      final list = e.value
        ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
      return MapEntry(e.key, list);
    }).toList();
    groups.sort(
      (a, b) => b.value.first.updatedAt.compareTo(a.value.first.updatedAt),
    );
    return groups;
  }

  /// 分组显示名：组内首个带路径会话的末级目录名；无路径退回 key
  /// （default 工作区即此形态）；key 也为空 → 未分组
  String _groupLabel(String key, List<ZcodeSessionMeta> group) {
    for (final s in group) {
      final p = s.workspacePath;
      if (p != null && p.isNotEmpty) return _workspaceLabel(p);
    }
    return key.isEmpty ? '未分组' : key;
  }

  /// 单个工作区分组：可折叠组头（chevron + folder + 组名 + 任务数 + 组内新建）
  /// + 组内瓦片，对齐官方 web 的"工作区卡片"形态
  Widget _buildGroup(
    BuildContext context,
    AppColors colors,
    ZcodeChatStore store,
    MapEntry<String, List<ZcodeSessionMeta>> group,
  ) {
    final collapsed = _collapsedGroups.contains(group.key);
    final ws = _groupWorkspace(group.value);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: () => setState(() {
            collapsed
                ? _collapsedGroups.remove(group.key)
                : _collapsedGroups.add(group.key);
          }),
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Row(
              children: [
                AnimatedRotation(
                  turns: collapsed ? -0.25 : 0,
                  duration: const Duration(milliseconds: 150),
                  child: Icon(
                    Icons.expand_more,
                    size: 16,
                    color: colors.textMuted,
                  ),
                ),
                const SizedBox(width: 4),
                Icon(Icons.folder_outlined, size: 14, color: colors.textMuted),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    _groupLabel(group.key, group.value),
                    style: TextStyle(
                      fontSize: 12,
                      color: colors.textMuted,
                      fontWeight: FontWeight.w500,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  '${group.value.length} 个任务',
                  style: TextStyle(fontSize: 11, color: colors.textMuted),
                ),
                const SizedBox(width: 10),
                // 组内新建：在该工作区下创建会话（session/create 带 workspace）
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: (_creating || ws == null)
                      ? null
                      : () => unawaited(_onNewSessionIn(ws.$1, ws.$2)),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: _creating
                        ? SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(
                              strokeWidth: 1.5,
                              color: colors.textMuted,
                            ),
                          )
                        : Icon(
                            Icons.add,
                            size: 15,
                            color: ws == null
                                ? colors.textMuted.withValues(alpha: 0.4)
                                : colors.textMuted,
                          ),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (!collapsed)
          Column(
            mainAxisSize: MainAxisSize.min,
            children: group.value.map((session) {
              final isActive = session.sessionId == store.activeSessionId;
              return SessionListTile(
                session: session,
                isActive: isActive,
                onTap: () => _onSessionTap(context, store, session.sessionId),
              );
            }).toList(),
          ),
      ],
    );
  }

  /// 组内可用的工作区 (key, path)：取组内首个 key+path 齐全的会话；
  /// 全组缺失（仅 path 聚合的旧数据）→ null，"+"置灰
  (String, String)? _groupWorkspace(List<ZcodeSessionMeta> group) {
    for (final s in group) {
      final k = s.workspaceKey;
      final p = s.workspacePath;
      if (k != null && k.isNotEmpty && p != null && p.isNotEmpty) {
        return (k, p);
      }
    }
    return null;
  }

  /// 新建会话 in-flight 期间禁用「+」，完成后收起抽屉（新会话已由
  /// store.newSession 内部打开，聊天页由外层响应 store）
  Future<void> _onNewSessionIn(String workspaceKey, String workspacePath) async {
    if (_creating) return;
    setState(() => _creating = true);
    try {
      await _store.newSession(
        workspaceKey: workspaceKey,
        workspacePath: workspacePath,
      );
    } finally {
      if (mounted) setState(() => _creating = false);
    }
    if (mounted) Navigator.pop(context);
  }

  /// 新建会话：in-flight 期间禁用「+」，完成后收起抽屉（新会话已由
  /// store.newSession 内部打开，聊天页由外层响应 store）
  Future<void> _onNewSession() async {
    if (_creating) return;
    setState(() => _creating = true);
    try {
      await _store.newSession();
    } finally {
      if (mounted) setState(() => _creating = false);
    }
    if (mounted) Navigator.pop(context);
  }

  /// 打开会话并收起抽屉（聊天页由外层响应 store 的视口变化）
  void _onSessionTap(
    BuildContext context,
    ZcodeChatStore store,
    String sessionId,
  ) {
    unawaited(store.openSession(sessionId));
    Navigator.pop(context);
  }

  /// 「大脑网络」入口：经 NAS relay 遥控任意大脑节点（v3 P1，旧协议栈复用）
  Widget _buildBrainNetworkEntry(BuildContext context, AppColors colors) {
    return ListTile(
      leading: Icon(Icons.hub_outlined, color: colors.accent, size: 20),
      title: Text(
        '大脑网络',
        style: TextStyle(color: colors.textPrimary, fontSize: 14),
      ),
      subtitle: Text(
        '经 NAS relay 遥控任意环境的节点',
        style: TextStyle(color: colors.textMuted, fontSize: 11),
      ),
      dense: true,
      onTap: () {
        Navigator.pop(context);
        Navigator.pushNamed(context, '/remote');
      },
    );
  }

  /// 「浏览文件」入口：zcode 协议暂无文件树 API，置灰占位（可点进占位页）
  Widget _buildFileBrowseEntry(BuildContext context, AppColors colors) {
    return ListTile(
      leading: Icon(Icons.folder_open, color: colors.textMuted, size: 20),
      title: Text(
        '浏览文件',
        style: TextStyle(color: colors.textMuted, fontSize: 14),
      ),
      subtitle: Text(
        '等待 v3 workspace 支持',
        style: TextStyle(color: colors.textMuted, fontSize: 11),
      ),
      dense: true,
      onTap: () {
        Navigator.pop(context);
        Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => const FilesPlaceholderPage()),
        );
      },
    );
  }

  Widget _buildFooter(AppColors colors, ZcodeChatStore store) {
    final state = store.connState;
    final dotColor = _connColor(colors, state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: colors.border, width: 0.5),
        ),
      ),
      child: Row(
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
            _connLabel(state),
            style: TextStyle(
              color: dotColor,
              fontSize: 13,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  /// 当前活动会话的 meta（从 session/list 快照中按视口 id 查找）
  ZcodeSessionMeta? _activeMeta(ZcodeChatStore store) {
    final id = store.activeSessionId;
    if (id == null) return null;
    return store.sessions.where((s) => s.sessionId == id).firstOrNull;
  }

  /// 工作区路径只显示最后一级目录名（与 zcode_page._workspaceLabel 同逻辑；
  /// 先去掉结尾分隔符，'C:\repo\' → 'repo'）
  String _workspaceLabel(String path) {
    final trimmed = path.replaceAll(_trailingPathSep, '');
    final parts = trimmed.split(_pathSep);
    return parts.isEmpty || parts.last.isEmpty ? path : parts.last;
  }

  /// 连接状态点配色（对齐 zcode_page._buildConnBadge）
  Color _connColor(AppColors colors, ZcodeConnState state) {
    switch (state) {
      case ZcodeConnState.matched:
        return colors.success;
      case ZcodeConnState.waiting:
        return colors.warning;
      case ZcodeConnState.connecting:
        return colors.accent;
      case ZcodeConnState.idle:
        return colors.textMuted;
    }
  }

  /// 连接状态文案（对齐 zcode_page._buildConnBadge）
  String _connLabel(ZcodeConnState state) {
    switch (state) {
      case ZcodeConnState.matched:
        return '已连接';
      case ZcodeConnState.waiting:
        return '等待桌面端';
      case ZcodeConnState.connecting:
        return '连接中';
      case ZcodeConnState.idle:
        return '未连接';
    }
  }
}
