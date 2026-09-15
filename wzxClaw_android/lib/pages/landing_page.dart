import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../services/app_restore_state.dart';
import '../services/connection_manager.dart';
import '../services/pairing_store.dart';
import '../services/session_sync_service.dart';
import '../services/zcode_protocol_translate.dart'
    show normalizeQrScanToServerUrl, parsePairingUrlAny;
import '../zcode/zcode_relay_client.dart';
import 'qr_scanner_page.dart';
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

  // 多配对：probe 在线探测结果（sid → 是否在线）与进行中标记；
  // 切换连接后匹配成功自动进入的目标桌面
  final Map<String, bool> _probeStatus = {};
  final Set<String> _probingSids = {};
  String? _pendingAutoSelectSid;

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
      // 切换连接后：新桌面匹配成功 → 自动走工作区选择进入聊天
      if (s == WsConnectionState.connected && _pendingAutoSelectSid != null) {
        final sid = _pendingAutoSelectSid!;
        _pendingAutoSelectSid = null;
        if (mounted &&
            ConnectionManager.instance.selectedDesktopId == sid) {
          _onSelectDesktop(DesktopInfo(desktopId: sid, connectedAt: 0));
        }
      }
    });

    _desktopsSub = ConnectionManager.instance.desktopsStream.listen((list) {
      if (mounted) setState(() => _desktops = list);
    });

    // 多配对：设备列表持久常驻 + 探测其余桌面在线状态
    unawaited(ConnectionManager.instance.refreshDesktops().then((_) {
      if (mounted) _refreshOnlineStatus();
    }));

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
      try {
        final host = Uri.parse(serverUrl).host;
        if (mounted) setState(() => _serverHost = host);
      } catch (_) {}
    }
    // 恢复上次活动桌面（多配对存储优先，旧 server_url 兜底）
    if (ConnectionManager.instance.state == WsConnectionState.disconnected) {
      unawaited(ConnectionManager.instance.connectFromSavedConfiguration());
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
    Navigator.pushNamed(context, '/chat').then((_) {
      // 从聊天返回设备列表：恢复可进入状态并刷新在线探测
      _didNavigate = false;
      if (mounted) _refreshOnlineStatus();
    });
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

  /// 未连接态的中继条：灰点 + 重连活动桌面入口
  Widget _buildRelayOfflineChip(AppColors colors) {
    final host = _serverHost ?? 'relay';
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration:
                BoxDecoration(color: colors.textMuted, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Text('未连接',
              style: TextStyle(color: colors.textPrimary, fontSize: 13)),
          const SizedBox(width: 4),
          Expanded(
            child: Text('· ' + host,
                style: TextStyle(color: colors.textMuted, fontSize: 12),
                overflow: TextOverflow.ellipsis),
          ),
          GestureDetector(
            onTap: () => unawaited(
                ConnectionManager.instance.connectFromSavedConfiguration()),
            child:
                Text('重连', style: TextStyle(color: colors.accent, fontSize: 12)),
          ),
        ],
      ),
    );
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
    // 状态 D：有已保存桌面 —— 列表常驻（含离线），点按连接/切换
    if (_desktops.isNotEmpty) {
      return _buildDesktopListState(colors);
    }

    // 状态 B：连接中（尚未有任何配对）
    if (_isConnecting) {
      return _buildConnectingState(colors);
    }

    // 状态 C：已连接但无桌面（边界）
    if (_isConnected) {
      return _buildNoDesktopState(colors);
    }

    // 状态 A：未配置
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
    final onlineCount = _desktops.where((d) => d.online).length;
    return Column(
      key: const ValueKey('state_d'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _isConnected
            ? _buildRelayStatusChip(colors)
            : _buildRelayOfflineChip(colors),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Row(
            children: [
              Text('设备',
                  style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 13,
                      fontWeight: FontWeight.bold)),
              const Spacer(),
              IconButton(
                onPressed: _refreshOnlineStatus,
                icon: Icon(Icons.refresh, size: 18, color: colors.textMuted),
                tooltip: '刷新在线状态',
                visualDensity: VisualDensity.compact,
              ),
              Text('$onlineCount/${_desktops.length} 在线',
                  style: TextStyle(color: colors.textMuted, fontSize: 12)),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 80),
            itemCount: _desktops.length,
            itemBuilder: (context, i) {
              final d = _desktops[i];
              return _DesktopCard(
                desktop: d,
                status: _statusFor(d),
                onTap: () => _onDeviceTap(d),
                onLongPress: () => _showDeviceActions(d),
                colors: colors,
                index: i,
              );
            },
          ),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TextButton.icon(
              onPressed: _addDesktopViaScan,
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

  // ── 多配对：连接/切换/探测/管理 ────────────────────────────────────

  /// 设备行点击：在线 → 进入；连接中 → 取消；其余 → 切换连接
  void _onDeviceTap(DesktopInfo d) {
    if (d.online) {
      _onSelectDesktop(d);
      return;
    }
    final isCurrent =
        ConnectionManager.instance.selectedDesktopId == d.desktopId;
    if (isCurrent && _isConnecting) {
      _pendingAutoSelectSid = null;
      ConnectionManager.instance.disconnect();
      return;
    }
    _switchTo(d.desktopId);
  }

  void _switchTo(String sid) {
    _pendingAutoSelectSid = sid;
    unawaited(ConnectionManager.instance.connectToStored(sid));
  }

  /// 扫码添加桌面：新码入库并自动连接切换；重扫已有桌面直接切换
  Future<void> _addDesktopViaScan() async {
    final raw = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const QrScannerPage()),
    );
    if (raw == null || raw.isEmpty || !mounted) return;
    final pairingUrl = normalizeQrScanToServerUrl(raw);
    final parsed = pairingUrl != null ? parsePairingUrlAny(pairingUrl) : null;
    if (parsed == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('不是桌面端配对二维码'),
        duration: Duration(seconds: 2),
      ));
      return;
    }
    _pendingAutoSelectSid = parsed.sid;
    final switched =
        await ConnectionManager.instance.connectToStored(parsed.sid);
    if (!switched) {
      // 新桌面：connect() 会入库并连接
      ConnectionManager.instance.connect(pairingUrl!);
    }
  }

  /// 长按设备：连接/进入 + 删除
  void _showDeviceActions(DesktopInfo d) {
    final colors = AppColors.of(context);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: colors.bgSecondary,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            ListTile(
              leading: Icon(d.online ? Icons.login : Icons.link,
                  color: colors.accent),
              title: Text(d.online ? '进入此桌面' : '连接此桌面',
                  style: TextStyle(color: colors.textPrimary)),
              onTap: () {
                Navigator.pop(ctx);
                _onDeviceTap(d);
              },
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: colors.error),
              title:
                  Text('删除此桌面', style: TextStyle(color: colors.error)),
              onTap: () {
                Navigator.pop(ctx);
                _confirmRemovePairing(d);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  void _confirmRemovePairing(DesktopInfo d) {
    final colors = AppColors.of(context);
    showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgElevated,
        title: Text('删除桌面', style: TextStyle(color: colors.textPrimary)),
        content: Text('将移除「' + (d.name ?? '桌面 ZCode') + '」的配对，需要重新扫码才能再连接。确定删除吗？',
            style: TextStyle(color: colors.textSecondary)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('取消', style: TextStyle(color: colors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('删除', style: TextStyle(color: colors.error)),
          ),
        ],
      ),
    ).then((confirmed) {
      if (confirmed != true) return;
      unawaited(ConnectionManager.instance.removePairing(d.desktopId)
          .then((_) {
        if (mounted) setState(() => _probeStatus.remove(d.desktopId));
      }));
    });
  }

  /// probe 其余桌面：每条配对一个短连 probe，waiting=离线 / matched=在线
  Future<void> _refreshOnlineStatus() async {
    final stored = await PairingStore.instance.loadAll();
    if (!mounted) return;
    final currentSid = ConnectionManager.instance.selectedDesktopId;
    for (final sp in stored) {
      final sid = sp.info.sid;
      if (sid == currentSid) continue; // 当前桌面状态跟随连接本身
      if (_probingSids.contains(sid)) continue;
      _probingSids.add(sid);
      unawaited(_probeOne(sp).whenComplete(() => _probingSids.remove(sid)));
    }
  }

  Future<void> _probeOne(StoredPairing sp) async {
    final completer = Completer<bool>();
    final client = ZcodeRelayClient(
      pairing: sp.info,
      onStateChange: (state, paired) {
        if (completer.isCompleted) return;
        if (state == ZcodeRelayState.matched) completer.complete(true);
        if (state == ZcodeRelayState.waiting) completer.complete(false);
      },
    );
    // 超时视为离线（relay 不可达/网络异常/凭据失效）
    Timer(const Duration(seconds: 6), () {
      if (!completer.isCompleted) completer.complete(false);
    });
    try {
      client.connect();
      final online = await completer.future;
      client.close();
      if (mounted) setState(() => _probeStatus[sp.info.sid] = online);
    } catch (_) {
      client.close();
      if (mounted) setState(() => _probeStatus[sp.info.sid] = false);
    }
  }

  _DeviceStatus _statusFor(DesktopInfo d) {
    if (d.online) return _DeviceStatus.online;
    final isCurrent =
        ConnectionManager.instance.selectedDesktopId == d.desktopId;
    if (isCurrent && _isConnecting) return _DeviceStatus.connecting;
    final probed = _probeStatus[d.desktopId];
    if (probed == true) return _DeviceStatus.online;
    if (probed == false) return _DeviceStatus.offline;
    return _DeviceStatus.unknown;
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
    required this.status,
    required this.onTap,
    required this.onLongPress,
    required this.colors,
    required this.index,
  });

  final DesktopInfo desktop;
  final _DeviceStatus status;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
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
    final status = widget.status;
    final label = d.name ?? '桌面端 ${widget.index + 1}';

    final badgeColor = switch (status) {
      _DeviceStatus.online => colors.success,
      _DeviceStatus.connecting => Colors.orange,
      _DeviceStatus.offline => colors.textMuted,
      _DeviceStatus.unknown => colors.textMuted,
    };
    final badgeText = switch (status) {
      _DeviceStatus.online => '在线',
      _DeviceStatus.connecting => '连接中…',
      _DeviceStatus.offline => '离线',
      _DeviceStatus.unknown => '未连接',
    };
    final subtitle = switch (status) {
      _DeviceStatus.online =>
        ConnectionManager.instance.selectedDesktopId == d.desktopId
            ? _formatConnectedAt(d.connectedAt)
            : '在线 · 点按切换',
      _DeviceStatus.connecting => '点按取消',
      _DeviceStatus.offline => '桌面端不在线 · 点按连接',
      _DeviceStatus.unknown => '已配对 · 点按连接',
    };

    return FadeTransition(
      opacity: _fadeAnim,
      child: Card(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(
              color:
                  status == _DeviceStatus.online ? colors.accent : colors.border,),
        ),
        color: colors.bgSecondary,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: widget.onTap,
          onLongPress: widget.onLongPress,
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
                      Text(subtitle,
                          style:
                              TextStyle(color: colors.textMuted, fontSize: 12)),
                    ],
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: badgeColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 6,
                        height: 6,
                        decoration:
                            BoxDecoration(color: badgeColor, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 5),
                      Text(badgeText,
                          style:
                              TextStyle(color: badgeColor, fontSize: 11)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 设备行的展示状态
enum _DeviceStatus { online, connecting, offline, unknown }
