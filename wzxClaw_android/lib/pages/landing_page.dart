import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../services/app_restore_state.dart';
import '../services/connection_manager.dart';
import '../services/session_sync_service.dart';
import '../widgets/workspace_picker_card.dart';

class LandingPage extends StatefulWidget {
  const LandingPage({super.key});

  @override
  State<LandingPage> createState() => _LandingPageState();
}

class _LandingPageState extends State<LandingPage>
    with TickerProviderStateMixin {
  WsConnectionState _state = WsConnectionState.disconnected;
  List<DesktopInfo> _desktops = [];
  String? _serverHost;

  StreamSubscription<WsConnectionState>? _stateSub;
  StreamSubscription<List<DesktopInfo>>? _desktopsSub;
  bool _didNavigate = false;
  String? _savedWorkspacePath;

  // 呼吸动画控制器（状态B）
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnim;

  @override
  void initState() {
    super.initState();

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);

    _pulseAnim = Tween<double>(begin: 14, end: 22).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _state = ConnectionManager.instance.state;
    _desktops = List.from(ConnectionManager.instance.desktops);

    _stateSub = ConnectionManager.instance.stateStream.listen((s) {
      if (mounted) setState(() => _state = s);
    });

    _desktopsSub = ConnectionManager.instance.desktopsStream.listen((list) {
      if (mounted) setState(() => _desktops = list);
    });

    _autoConnect();
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _stateSub?.cancel();
    _desktopsSub?.cancel();
    super.dispose();
  }

  Future<void> _autoConnect() async {
    final prefs = await SharedPreferences.getInstance();
    final serverUrl = prefs.getString('server_url');
    _savedWorkspacePath = await AppRestoreState.getLastWorkspacePath();
    if (serverUrl != null && serverUrl.isNotEmpty) {
      final token = prefs.getString('auth_token') ?? '';
      try {
        final uri = Uri.parse(serverUrl);
        setState(() {
          _serverHost = uri.host;
        });
        if (ConnectionManager.instance.state == WsConnectionState.disconnected) {
          final params = Map<String, String>.from(uri.queryParameters);
          params['role'] = 'mobile';
          if (token.isNotEmpty) params['token'] = token;
          final fullUrl = uri.replace(queryParameters: params).toString();
          ConnectionManager.instance.connect(fullUrl);
        }
      } catch (e) {
        debugPrint('[LandingPage] auto-connect failed: $e');
      }
    }
  }

  /// 选择桌面端后，获取工作区列表。
  /// 单工作区或匹配已保存工作区时自动选择，否则弹出选择器。
  void _onSelectDesktop(DesktopInfo desktop) {
    _didNavigate = false;
    ConnectionManager.instance.selectDesktop(desktop.desktopId);

    // 监听一次工作区列表响应
    StreamSubscription<List<WorkspaceItem>>? sub;
    sub = SessionSyncService.instance.workspacesStream.listen((workspaces) {
      sub?.cancel();

      if (!mounted) return;

      // 单工作区 → 自动选择，跳过弹窗
      if (workspaces.length == 1) {
        final path = workspaces.first.primaryPath;
        if (path != null && path.isNotEmpty) {
          SessionSyncService.instance.switchWorkspace(path);
        }
        _navigateToChat();
        return;
      }

      // 有保存的工作区且匹配 → 自动选择，跳过弹窗
      if (_savedWorkspacePath != null) {
        final match = workspaces
            .where((w) => w.primaryPath == _savedWorkspacePath)
            .firstOrNull;
        if (match != null && match.primaryPath != null) {
          SessionSyncService.instance.switchWorkspace(match.primaryPath!);
          _navigateToChat();
          return;
        }
      }

      // 多个工作区且无匹配 → 弹出选择器
      _showWorkspacePicker(workspaces);
    });

    // 请求工作区列表
    SessionSyncService.instance.fetchWorkspaces();

    // 超时保护：3 秒后如果没收到响应，直接进聊天
    Future.delayed(const Duration(seconds: 3), () {
      sub?.cancel();
      if (mounted && !_didNavigate) {
        _navigateToChat();
      }
    });
  }

  void _navigateToChat() {
    if (_didNavigate) return;
    _didNavigate = true;
    AppRestoreState.setLastRoute('/chat');
    Navigator.pushNamed(context, '/chat');
  }

  void _showWorkspacePicker(List<WorkspaceItem> workspaces) {
    final colors = AppColors.of(context);
    showModalBottomSheet(
      context: context,
      isDismissible: false,
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
                  Text('选择工作区',
                      style: TextStyle(
                          color: colors.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.bold)),
                  const Spacer(),
                  GestureDetector(
                    onTap: () {
                      Navigator.pop(ctx);
                      _navigateToChat();
                    },
                    child: Text('跳过',
                        style: TextStyle(color: colors.textMuted, fontSize: 13)),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            if (workspaces.isEmpty)
              // 空状态
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 20),
                child: Column(
                  children: [
                    Icon(Icons.folder_off_outlined, size: 40, color: colors.textMuted),
                    const SizedBox(height: 12),
                    Text('暂无工作区',
                        style: TextStyle(color: colors.textSecondary, fontSize: 14)),
                    const SizedBox(height: 6),
                    Text('请在桌面端打开项目后重试',
                        style: TextStyle(color: colors.textMuted, fontSize: 12)),
                  ],
                ),
              )
            else
            ConstrainedBox(
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
                      _navigateToChat();
                    },
                    onSessionTap: (sessionId) {
                      Navigator.pop(ctx);
                      final path = ws.primaryPath;
                      if (path != null && path.isNotEmpty) {
                        SessionSyncService.instance.switchWorkspace(path);
                      }
                      SessionSyncService.instance.setActiveSession(sessionId);
                      _navigateToChat();
                    },
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    ).then((_) {
      // 用户点击跳过或底部 sheet 关闭 → 导航到聊天
      if (mounted && !_didNavigate) {
        _navigateToChat();
      }
    });
  }

  void _onDisconnect() {
    final colors = AppColors.of(context);
    showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('断开连接', style: TextStyle(color: colors.textPrimary)),
        content: Text('确定要断开 Relay 服务器连接吗？',
            style: TextStyle(color: colors.textSecondary)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('取消', style: TextStyle(color: colors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('断开', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    ).then((confirmed) {
      if (confirmed == true) {
        AppRestoreState.setLastRoute('/');
        ConnectionManager.instance.disconnect();
      }
    });
  }

  // ── 判断当前状态 ────────────────────────────────────────────────────

  bool get _isConnected => _state == WsConnectionState.connected;
  bool get _isConnecting =>
      _state == WsConnectionState.connecting ||
      _state == WsConnectionState.reconnecting;

  // ── Build ──────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: _isConnected && _desktops.isNotEmpty
            ? Text('wzxClaw', style: TextStyle(color: colors.textPrimary, fontSize: 18))
            : null,
        actions: [
          IconButton(
            icon: Icon(Icons.settings_outlined, color: colors.textSecondary),
            tooltip: '设置',
            onPressed: () => Navigator.pushNamed(context, '/settings'),
          ),
        ],
      ),
      body: SafeArea(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 350),
          switchInCurve: Curves.easeInOut,
          switchOutCurve: Curves.easeInOut,
          child: _buildBody(colors),
        ),
      ),
    );
  }

  Widget _buildBody(AppColors colors) {
    // 状态 B：连接中
    if (_isConnecting) {
      return _buildConnectingState(colors);
    }

    // 状态 D：已连接，有桌面
    if (_isConnected && _desktops.isNotEmpty) {
      return _buildDesktopListState(colors);
    }

    // 状态 C：已连接，无桌面
    if (_isConnected && _desktops.isEmpty) {
      return _buildNoDesktopState(colors);
    }

    // 状态 A：未配置/未连接
    return _buildUnconfiguredState(colors);
  }

  // ── 状态 A：未配置 ─────────────────────────────────────────────────

  Widget _buildUnconfiguredState(AppColors colors) {
    return Center(
      key: const ValueKey('state_a'),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.terminal,
              size: 72,
              color: colors.accent.withValues(alpha: 0.9),
            ),
            const SizedBox(height: 16),
            Text('wzxClaw',
                style: TextStyle(color: colors.textPrimary, fontSize: 28,
                    fontWeight: FontWeight.bold)),
            const SizedBox(height: 6),
            Text('AI 编程助手',
                style: TextStyle(color: colors.textSecondary, fontSize: 14)),
            const SizedBox(height: 48),
            Text(
              '扫描桌面端的二维码\n快速连接到你的工作站',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 14),
            ),
            const SizedBox(height: 32),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: () => Navigator.pushNamed(context, '/settings'),
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('扫码连接'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16)),
                ),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              height: 44,
              child: OutlinedButton(
                onPressed: () => Navigator.pushNamed(context, '/settings'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: colors.textSecondary,
                  side: BorderSide(color: colors.border),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16)),
                ),
                child: const Text('手动配置'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── 状态 B：连接中 ─────────────────────────────────────────────────

  Widget _buildConnectingState(AppColors colors) {
    return Center(
      key: const ValueKey('state_b'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedBuilder(
            animation: _pulseAnim,
            builder: (context, _) {
              final size = _pulseAnim.value;
              return Container(
                width: size,
                height: size,
                decoration: BoxDecoration(
                  color: colors.accent,
                  shape: BoxShape.circle,
                ),
              );
            },
          ),
          const SizedBox(height: 24),
          Text('正在连接 Relay 服务器',
              style: TextStyle(color: colors.textPrimary, fontSize: 16)),
          const SizedBox(height: 6),
          if (_serverHost != null)
            Text(_serverHost!,
                style: TextStyle(color: colors.textMuted, fontSize: 13)),
          const SizedBox(height: 32),
          TextButton(
            onPressed: () => ConnectionManager.instance.disconnect(),
            child: Text('取消', style: TextStyle(color: colors.textSecondary)),
          ),
        ],
      ),
    );
  }

  // ── 状态 C：已连接无桌面 ────────────────────────────────────────────

  Widget _buildNoDesktopState(AppColors colors) {
    return Column(
      key: const ValueKey('state_c'),
      children: [
        _buildRelayStatusChip(colors),
        Expanded(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.computer_outlined, size: 56, color: colors.textMuted),
                const SizedBox(height: 16),
                Text('等待桌面端上线',
                    style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                Text('请在电脑上打开 wzxClaw',
                    style: TextStyle(color: colors.textSecondary, fontSize: 13)),
                const SizedBox(height: 24),
                OutlinedButton.icon(
                  onPressed: () => Navigator.pushNamed(context, '/settings'),
                  icon: Icon(Icons.qr_code_scanner, color: colors.textSecondary),
                  label: Text('重新扫码',
                      style: TextStyle(color: colors.textSecondary)),
                  style: OutlinedButton.styleFrom(
                    side: BorderSide(color: colors.border),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // ── 状态 D：有桌面列表 ─────────────────────────────────────────────

  Widget _buildDesktopListState(AppColors colors) {
    return Column(
      key: const ValueKey('state_d'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildRelayStatusChip(colors),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Row(
            children: [
              Text('桌面端',
                  style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 13,
                      fontWeight: FontWeight.bold)),
              const Spacer(),
              Text('${_desktops.length} 台在线',
                  style: TextStyle(color: colors.textMuted, fontSize: 12)),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 80),
            itemCount: _desktops.length,
            itemBuilder: (context, i) => _DesktopCard(
              desktop: _desktops[i],
              onTap: () => _onSelectDesktop(_desktops[i]),
              colors: colors,
              index: i,
            ),
          ),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TextButton.icon(
              onPressed: () => Navigator.pushNamed(context, '/settings'),
              icon: Icon(Icons.qr_code_scanner,
                  size: 16, color: colors.textMuted),
              label: Text('扫码添加桌面',
                  style: TextStyle(color: colors.textMuted, fontSize: 12)),
            ),
          ),
        ),
      ],
    );
  }

  // ── RelayStatusChip ────────────────────────────────────────────────

  Widget _buildRelayStatusChip(AppColors colors) {
    final host = _serverHost ?? 'relay';
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: colors.success.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.success.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: colors.success, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Text('Relay 已连接',
              style: TextStyle(color: colors.textPrimary, fontSize: 13)),
          const SizedBox(width: 4),
          Expanded(
            child: Text('· $host',
                style: TextStyle(color: colors.textMuted, fontSize: 12),
                overflow: TextOverflow.ellipsis),
          ),
          GestureDetector(
            onTap: _onDisconnect,
            child: Text('断开',
                style: TextStyle(color: colors.error, fontSize: 12)),
          ),
        ],
      ),
    );
  }
}

// ── DesktopCard widget ─────────────────────────────────────────────────

class _DesktopCard extends StatefulWidget {
  const _DesktopCard({
    required this.desktop,
    required this.onTap,
    required this.colors,
    required this.index,
  });

  final DesktopInfo desktop;
  final VoidCallback onTap;
  final AppColors colors;
  final int index;

  @override
  State<_DesktopCard> createState() => _DesktopCardState();
}

class _DesktopCardState extends State<_DesktopCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _fadeController;
  late final Animation<double> _fadeAnim;

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
    _fadeAnim =
        CurvedAnimation(parent: _fadeController, curve: Curves.easeIn);

    // Staggered entrance: delay by index * 50ms
    Future.delayed(Duration(milliseconds: widget.index * 50), () {
      if (mounted) _fadeController.forward();
    });
  }

  @override
  void dispose() {
    _fadeController.dispose();
    super.dispose();
  }

  IconData _platformIcon(String? platform) {
    switch (platform?.toLowerCase()) {
      case 'windows':
        return Icons.computer;
      case 'macos':
        return Icons.laptop_mac;
      case 'linux':
        return Icons.terminal;
      default:
        return Icons.desktop_windows_outlined;
    }
  }

  String _formatConnectedAt(int? connectedAtMs) {
    if (connectedAtMs == null) return '刚刚连接';
    final connected = DateTime.fromMillisecondsSinceEpoch(connectedAtMs);
    final diff = DateTime.now().difference(connected);
    if (diff.inMinutes < 1) return '刚刚连接';
    if (diff.inMinutes < 60) return '连接于 ${diff.inMinutes} 分钟前';
    final h = connected.hour.toString().padLeft(2, '0');
    final m = connected.minute.toString().padLeft(2, '0');
    return '连接于 $h:$m';
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.desktop;
    final colors = widget.colors;
    final label = d.name ?? '桌面端 ${widget.index + 1}';

    return FadeTransition(
      opacity: _fadeAnim,
      child: Card(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: colors.border),
        ),
        color: colors.bgSecondary,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: widget.onTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: colors.bgTertiary,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(_platformIcon(d.platform), size: 24, color: colors.accent),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label,
                          style: TextStyle(
                              color: colors.textPrimary,
                              fontSize: 15,
                              fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      Text(_formatConnectedAt(d.connectedAt),
                          style:
                              TextStyle(color: colors.textMuted, fontSize: 12)),
                    ],
                  ),
                ),
                Icon(Icons.arrow_forward_ios, size: 14, color: colors.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
