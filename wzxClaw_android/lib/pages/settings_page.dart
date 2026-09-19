import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../models/ui_prefs.dart';
import 'qr_scanner_page.dart';
import '../main.dart' show themeNotifier, accentNotifier;
import '../models/connection_state.dart';
import '../services/connection_manager.dart';
import '../services/pairing_url.dart' show normalizeQrScanToServerUrl;
import '../zcode/zcode_chat_store.dart';
import '../zcode/zcode_keepalive_controller.dart';
import '../zcode/zcode_notifier.dart';

/// Settings page for configuring WebSocket connection parameters.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _serverUrlController = TextEditingController();
  bool _loading = true;
  bool _pushEnabled = true;
  bool _backgroundKeepAliveEnabled = false;
  bool _checkingUpdate = false;
  String _appVersion = '';

  static const _pushEnabledKey = 'push_notifications_enabled';
  static const _backgroundKeepAliveEnabledKey = 'background_keepalive_enabled';

  /// 检查更新：拉 NAS 发布目录只读列表（autoindex），解析最高版本号
  /// 与本机比对。发现新版 → 提示去 NAS share/zcode 下载安装。
  Future<void> _checkForUpdate() async {
    setState(() => _checkingUpdate = true);
    String message;
    try {
      final request = await HttpClient()
          .getUrl(Uri.parse('https://zcode.5945.top/zcode-releases/'));
      final response = await request.close();
      if (response.statusCode != 200) {
        throw HttpException('服务不可用（${response.statusCode}）');
      }
      final body = await response.transform(utf8.decoder).join();
      final versions = RegExp(r'wzxClaw-android-release-v(\d+)\.(\d+)\.(\d+)\.apk')
          .allMatches(body)
          .map((m) => m.groups([1, 2, 3]).map((g) => int.parse(g!)).toList())
          .toList();
      if (versions.isEmpty) throw StateError('发布目录为空');
      versions.sort((a, b) {
        for (var i = 0; i < 3; i++) {
          if (a[i] != b[i]) return b[i] - a[i];
        }
        return 0;
      });
      final latest = versions.first.join('.');
      final current = _appVersion;
      if (current.isNotEmpty && latest == current) {
        message = '已是最新版本（v$current）';
      } else if (current.isNotEmpty) {
        message = '发现新版本 v$latest（当前 v$current），'
            '请到 NAS share/zcode 下载安装';
      } else {
        message = '最新版本 v$latest';
      }
    } catch (e) {
      message = '检查更新失败：$e';
    }
    if (!mounted) return;
    setState(() => _checkingUpdate = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        duration: const Duration(seconds: 4),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  void initState() {
    super.initState();
    _loadSavedValues();
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    super.dispose();
  }

  Future<void> _loadSavedValues() async {
    final prefs = await SharedPreferences.getInstance();
    final package = await PackageInfo.fromPlatform();
    _pushEnabled = prefs.getBool(_pushEnabledKey) ?? true;
    _backgroundKeepAliveEnabled =
        prefs.getBool(_backgroundKeepAliveEnabledKey) ?? false;
    if (!mounted) return;
    setState(() {
      _appVersion = '${package.version}+${package.buildNumber}';
      _loading = false;
    });
  }

  void _connect() => unawaited(_connectSafely());

  Future<void> _connectSafely() async {
    final pairingUrl = _parsePairingUrl(_serverUrlController.text);
    if (pairingUrl == null) return;
    final connected = await ConnectionManager.instance.connect(pairingUrl);
    if (mounted && connected) {
      Navigator.pushNamedAndRemoveUntil(context, '/', (_) => false);
    }
  }

  String? _parsePairingUrl(String raw) {
    final normalized = normalizeQrScanToServerUrl(raw.trim());
    if (normalized == null) {
      _showConnectionError('请输入桌面端生成的配对链接');
      return null;
    }
    return normalized;
  }

  void _showConnectionError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  void _disconnect() {
    ConnectionManager.instance.disconnect();
  }

  Future<void> _togglePushNotifications(bool value) async {
    setState(() => _pushEnabled = value);
    await ZcodeNotifier.instance.setEnabled(value);
  }

  Future<void> _toggleBackgroundKeepAlive(bool value) async {
    setState(() => _backgroundKeepAliveEnabled = value);
    await ZcodeKeepAliveController.instance.setEnabled(value);
  }

  Future<void> _confirmAndClearCache() async {
    final colors = AppColors.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: colors.bgPrimary,
        title: Text(
          '清空本地缓存？',
          style: TextStyle(color: colors.textPrimary),
        ),
        content: Text(
          '将清除手机端所有已缓存的会话与消息。'
          '若当前已连接桌面，会立即重新同步；否则下次连接时再同步。',
          style: TextStyle(color: colors.textSecondary, fontSize: 14),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(
              '取消',
              style: TextStyle(color: colors.textSecondary),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(
              '清空',
              style: TextStyle(color: colors.accent),
            ),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    if (!mounted) return;

    try {
      await ZcodeChatStore.instance.clearLocalCache();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('本地缓存已清空')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('清空失败：$e')),
      );
    }
  }

  Future<void> _scanQrCode() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const QrScannerPage()),
    );
    if (result != null && result.isNotEmpty && mounted) {
      final isWebSocket =
          result.startsWith('wss://') || result.startsWith('ws://');
      final isHttp =
          result.startsWith('https://') || result.startsWith('http://');
      if (!isWebSocket && !isHttp) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('请扫描桌面端 wzxClaw 的连接二维码'),
            duration: Duration(seconds: 2),
          ),
        );
        return;
      }
      final pairingUrl = _parsePairingUrl(result);
      if (pairingUrl == null) return;
      _serverUrlController.text = pairingUrl;
      setState(() {});
      await _connectSafely();
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);

    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        title: const Text('设置'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
      ),
      body: _loading
          ? Center(child: CircularProgressIndicator(color: colors.accent))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // -- Pairing link field with scan button --
                Text(
                  '配对链接',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _serverUrlController,
                        style: TextStyle(color: colors.textPrimary),
                        decoration: InputDecoration(
                          hintText: 'https://…/pair?sid=…&hash=…',
                          hintStyle: TextStyle(color: colors.textMuted),
                          filled: true,
                          fillColor: colors.bgSecondary,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8),
                            borderSide: BorderSide.none,
                          ),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 14,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      icon: Icon(
                        Icons.qr_code_scanner,
                        color: colors.accent,
                        size: 28,
                      ),
                      onPressed: _scanQrCode,
                      tooltip: '扫描二维码',
                    ),
                  ],
                ),
                const SizedBox(height: 24),

                // -- Connect / Disconnect buttons --
                Row(
                  children: [
                    Expanded(
                      child: ElevatedButton(
                        onPressed: _connect,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: colors.accent,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        child: const Text('连接'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _disconnect,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: colors.textPrimary,
                          side: BorderSide(color: colors.border),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        child: const Text('断开'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),

                // -- Connection state label --
                StreamBuilder<WsConnectionState>(
                  stream: ConnectionManager.instance.stateStream,
                  initialData: ConnectionManager.instance.state,
                  builder: (context, snapshot) {
                    final state =
                        snapshot.data ?? WsConnectionState.disconnected;
                    return StreamBuilder<String?>(
                      stream: ConnectionManager.instance.errorStream,
                      initialData: ConnectionManager.instance.lastError,
                      builder: (context, errorSnap) {
                        final error = errorSnap.data;
                        final hasError = error != null &&
                            error.isNotEmpty &&
                            state != WsConnectionState.connected;
                        return Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: colors.bgSecondary,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Text(
                                    '当前状态: ',
                                    style: TextStyle(
                                      color: colors.textSecondary,
                                      fontSize: 14,
                                    ),
                                  ),
                                  Text(
                                    state.label,
                                    style: TextStyle(
                                      color: _stateColor(state),
                                      fontSize: 14,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ],
                              ),
                              if (hasError) ...[
                                const SizedBox(height: 6),
                                Text(
                                  error,
                                  style: TextStyle(
                                    color: colors.textMuted,
                                    fontSize: 12,
                                  ),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
                const SizedBox(height: 24),

                // -- Push notification toggle --
                SwitchListTile(
                  title: Text(
                    '推送通知',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 14,
                    ),
                  ),
                  subtitle: Text(
                    'AI 工作区完成时发送通知，并在点开后快速重连',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                  value: _pushEnabled,
                  activeTrackColor: colors.accent.withValues(alpha: 0.4),
                  activeThumbColor: colors.accent,
                  inactiveThumbColor: colors.textSecondary,
                  inactiveTrackColor: colors.border,
                  onChanged: _togglePushNotifications,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                ),
                SwitchListTile(
                  title: Text(
                    '后台保持连接',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 14,
                    ),
                  ),
                  subtitle: Text(
                    '切到后台后启用常驻通知与前台服务，尽量保持 Relay 在线',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                  value: _backgroundKeepAliveEnabled,
                  activeTrackColor: colors.accent.withValues(alpha: 0.4),
                  activeThumbColor: colors.accent,
                  inactiveThumbColor: colors.textSecondary,
                  inactiveTrackColor: colors.border,
                  onChanged: _toggleBackgroundKeepAlive,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                ),
                ValueListenableBuilder<bool>(
                  valueListenable: UiPrefs.enterToSend,
                  builder: (context, enterToSend, _) => SwitchListTile(
                    title: Text(
                      '回车键发送消息',
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 14,
                      ),
                    ),
                    subtitle: Text(
                      '开启后键盘发送键直接发送；关闭则回车换行，点按钮发送',
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 13,
                      ),
                    ),
                    value: enterToSend,
                    activeTrackColor: colors.accent.withValues(alpha: 0.4),
                    activeThumbColor: colors.accent,
                    inactiveThumbColor: colors.textSecondary,
                    inactiveTrackColor: colors.border,
                    onChanged: (v) => UiPrefs.setEnterToSend(v),
                    contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 4,),
                  ),
                ),
                const SizedBox(height: 24),

                // -- Connection diagnostics --
                Text(
                  '连接诊断',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                Container(
                  decoration: BoxDecoration(
                    color: colors.bgSecondary,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: ListTile(
                    leading: Icon(
                      Icons.network_check,
                      color: colors.accent,
                    ),
                    title: Text(
                      '查看连接日志与路径体检',
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 14,
                      ),
                    ),
                    subtitle: Text(
                      '连接尝试/失败原因一览；可测 IPv4/IPv6 可达性并复制报告上报',
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                    onTap: () =>
                        Navigator.pushNamed(context, '/connection-diagnostics'),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
                const SizedBox(height: 24),

                // -- Clear local cache --
                Text(
                  '本地数据',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                Container(
                  decoration: BoxDecoration(
                    color: colors.bgSecondary,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: ListTile(
                    leading: Icon(
                      Icons.cleaning_services_outlined,
                      color: colors.accent,
                    ),
                    title: Text(
                      '清空本地缓存',
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 14,
                      ),
                    ),
                    subtitle: Text(
                      '清除手机端缓存的消息和会话元数据；下次打开会从桌面端重新同步',
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                    onTap: _confirmAndClearCache,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
                const SizedBox(height: 24),

                // -- Theme mode selector --
                Text(
                  '主题模式',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                ValueListenableBuilder<ThemeMode>(
                  valueListenable: themeNotifier,
                  builder: (context, currentMode, _) {
                    return Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: colors.bgSecondary,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        children: [
                          _themeButton(
                            '跟随系统',
                            ThemeMode.system,
                            currentMode,
                            colors,
                          ),
                          _themeButton(
                            '浅色',
                            ThemeMode.light,
                            currentMode,
                            colors,
                          ),
                          _themeButton(
                            '深色',
                            ThemeMode.dark,
                            currentMode,
                            colors,
                          ),
                        ],
                      ),
                    );
                  },
                ),

                const SizedBox(height: 16),

                // -- Accent color selector --
                Text(
                  '主题颜色',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                ValueListenableBuilder<String>(
                  valueListenable: accentNotifier,
                  builder: (context, currentAccent, _) {
                    return Row(
                      children: [
                        _accentButton(
                          '紫色',
                          'purple',
                          const Color(0xFF7C3AED),
                          currentAccent,
                          colors,
                        ),
                        const SizedBox(width: 8),
                        _accentButton(
                          '绿色',
                          'green',
                          const Color(0xFF10B981),
                          currentAccent,
                          colors,
                        ),
                      ],
                    );
                  },
                ),

                const SizedBox(height: 24),

                // -- Connected desktop info --
                StreamBuilder<WsConnectionState>(
                  stream: ConnectionManager.instance.stateStream,
                  initialData: ConnectionManager.instance.state,
                  builder: (context, connSnap) {
                    final connState =
                        connSnap.data ?? WsConnectionState.disconnected;
                    return StreamBuilder<String?>(
                      stream: ConnectionManager.instance.desktopIdentityStream,
                      initialData: ConnectionManager.instance.desktopIdentity,
                      builder: (context, identitySnap) {
                        final identity = identitySnap.data;
                        final desktops = ConnectionManager.instance.desktops;
                        // 多配对下优先展示当前在线桌面
                        final desktop = desktops.isNotEmpty
                            ? (desktops.any((d) => d.online)
                                ? desktops.firstWhere((d) => d.online)
                                : desktops.first)
                            : null;
                        return Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: colors.bgSecondary,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '桌面端',
                                style: TextStyle(
                                  color: colors.textSecondary,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                              const SizedBox(height: 8),
                              if (connState == WsConnectionState.connected &&
                                  identity != null)
                                Row(
                                  children: [
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: const BoxDecoration(
                                        color: Colors.green,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      desktop?.platform != null
                                          ? '$identity · ${desktop!.platform}'
                                          : identity,
                                      style: TextStyle(
                                        color: colors.textPrimary,
                                        fontSize: 14,
                                      ),
                                    ),
                                  ],
                                )
                              else if (connState == WsConnectionState.connected)
                                Row(
                                  children: [
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: const BoxDecoration(
                                        color: Colors.orange,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      '已连接中继，等待桌面',
                                      style: TextStyle(
                                        color: colors.textSecondary,
                                        fontSize: 14,
                                      ),
                                    ),
                                  ],
                                )
                              else
                                Text(
                                  '未连接',
                                  style: TextStyle(
                                    color: colors.textMuted,
                                    fontSize: 14,
                                  ),
                                ),
                              // Show workspace name as subtitle when available
                              Builder(
                                builder: (context) {
                                  final wsPath = ZcodeChatStore
                                      .instance.selectedWorkspacePath;
                                  if (wsPath != null &&
                                      wsPath.isNotEmpty &&
                                      connState ==
                                          WsConnectionState.connected) {
                                    return Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        wsPath
                                            .replaceAll('\\', '/')
                                            .split('/')
                                            .last,
                                        style: TextStyle(
                                          color: colors.textMuted,
                                          fontSize: 12,
                                        ),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    );
                                  }
                                  return const SizedBox.shrink();
                                },
                              ),
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
                const SizedBox(height: 24),

                // -- Version info + 更新检查（NAS 发布目录只读列表）--
                Center(
                  child: Column(
                    children: [
                      Text(
                        _appVersion.isEmpty
                            ? 'wzxClaw Android'
                            : 'wzxClaw Android v$_appVersion',
                        style: TextStyle(color: colors.textMuted, fontSize: 12),
                      ),
                      const SizedBox(height: 4),
                      TextButton(
                        onPressed: _checkingUpdate ? null : _checkForUpdate,
                        child: Text(
                          _checkingUpdate ? '正在检查…' : '检查更新',
                          style: TextStyle(color: colors.accent, fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }

  Widget _themeButton(
    String label,
    ThemeMode mode,
    ThemeMode current,
    AppColors colors,
  ) {
    final selected = mode == current;
    return Expanded(
      child: GestureDetector(
        onTap: () async {
          themeNotifier.value = mode;
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString(
            'theme_mode',
            mode == ThemeMode.light
                ? 'light'
                : mode == ThemeMode.dark
                    ? 'dark'
                    : 'system',
          );
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected
                ? colors.accent.withValues(alpha: 0.15)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border:
                selected ? Border.all(color: colors.accent, width: 1.5) : null,
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: selected ? colors.accent : colors.textSecondary,
              fontSize: 13,
              fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
            ),
          ),
        ),
      ),
    );
  }

  Widget _accentButton(
    String label,
    String accent,
    Color color,
    String current,
    AppColors colors,
  ) {
    final selected = accent == current;
    return Expanded(
      child: GestureDetector(
        onTap: () async {
          accentNotifier.value = accent;
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('accent_color', accent);
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color:
                selected ? color.withValues(alpha: 0.15) : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: selected ? Border.all(color: color, width: 1.5) : null,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 6),
              Text(
                label,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: selected ? color : colors.textSecondary,
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Color _stateColor(WsConnectionState state) {
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
