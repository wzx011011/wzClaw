import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/app_colors.dart';
import '../main.dart' show themeNotifier, accentNotifier;
import '../models/connection_state.dart';
import '../services/connection_manager.dart';
import '../services/push_wake_service.dart';
import '../services/session_sync_service.dart';

/// Settings page for configuring WebSocket connection parameters.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _serverUrlController = TextEditingController();
  final _tokenController = TextEditingController();
  bool _obscureToken = true;
  bool _loading = true;
  bool _pushEnabled = true;
  bool _backgroundKeepAliveEnabled = false;

  static const _serverUrlKey = 'server_url';
  static const _authTokenKey = 'auth_token';
  static const _pushEnabledKey = 'push_notifications_enabled';
  static const _backgroundKeepAliveEnabledKey = 'background_keepalive_enabled';

  @override
  void initState() {
    super.initState();
    _loadSavedValues();
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _loadSavedValues() async {
    final prefs = await SharedPreferences.getInstance();
    _serverUrlController.text = prefs.getString(_serverUrlKey) ?? '';
    _tokenController.text = prefs.getString(_authTokenKey) ?? '';
    _pushEnabled = prefs.getBool(_pushEnabledKey) ?? true;
    _backgroundKeepAliveEnabled =
      prefs.getBool(_backgroundKeepAliveEnabledKey) ?? false;
    setState(() => _loading = false);
  }

  Future<void> _saveValues() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_serverUrlKey, _serverUrlController.text.trim());
    await prefs.setString(_authTokenKey, _tokenController.text.trim());
  }

  void _connect() {
    final serverUrl = _serverUrlController.text.trim();
    final token = _tokenController.text.trim();
    if (serverUrl.isEmpty) return;

    _saveValues();

    final uri = Uri.parse(serverUrl);
    final params = Map<String, String>.from(uri.queryParameters);
    params['role'] = 'mobile';
    if (token.isNotEmpty) {
      params['token'] = token;
    }
    final fullUrl = uri.replace(queryParameters: params).toString();
    ConnectionManager.instance.connect(fullUrl);

    // 返回首页（LandingPage），清除导航栈
    if (mounted) {
      Navigator.pushNamedAndRemoveUntil(context, '/', (_) => false);
    }
  }

  void _disconnect() {
    ConnectionManager.instance.disconnect();
  }

  Future<void> _togglePushNotifications(bool value) async {
    setState(() => _pushEnabled = value);
    await PushWakeService.instance.setEnabled(value);
  }

  Future<void> _toggleBackgroundKeepAlive(bool value) async {
    setState(() => _backgroundKeepAliveEnabled = value);
    await ConnectionManager.instance.setBackgroundKeepAliveEnabled(value);
  }

  Future<void> _scanQrCode() async {
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (context) => const _QrScannerPage()),
    );
    if (result != null && result.isNotEmpty && mounted) {
      // Accept wss://, ws:// (direct WebSocket) and https://, http:// (relay URLs)
      final isWebSocket = result.startsWith('wss://') || result.startsWith('ws://');
      final isHttp     = result.startsWith('https://') || result.startsWith('http://');
      if (!isWebSocket && !isHttp) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('请扫描桌面端 wzxClaw 的连接二维码'),
            duration: Duration(seconds: 2),
          ),
        );
        return;
      }
      try {
        final uri = Uri.parse(result);
        // Extract token from QR code URL query params
        final token = uri.queryParameters['token'] ?? '';
        // Convert http/https → ws/wss for WebSocket; strip token from URL
        // (token goes in the separate token field, _connect() re-adds it)
        final wsScheme = uri.scheme == 'https'
            ? 'wss'
            : uri.scheme == 'http'
                ? 'ws'
                : uri.scheme;
        final serverUrl = uri
            .replace(scheme: wsScheme, queryParameters: {})
            .toString();
        _serverUrlController.text = serverUrl;
        _tokenController.text = token;
        setState(() {});
        _saveValues();
        _connect();
        // _connect() already navigates to LandingPage
      } catch (e) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('二维码内容无法解析'),
            duration: Duration(seconds: 2),
          ),
        );
      }
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
                // -- Server URL field with scan button --
                Text(
                  '服务器地址',
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
                          hintText: 'wss://5945.top/relay/',
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
                      icon: Icon(Icons.qr_code_scanner,
                          color: colors.accent, size: 28,),
                      onPressed: _scanQrCode,
                      tooltip: '扫描二维码',
                    ),
                  ],
                ),
                const SizedBox(height: 20),

                // -- Token field --
                Text(
                  'Token',
                  style: TextStyle(color: colors.textSecondary, fontSize: 14),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _tokenController,
                  obscureText: _obscureToken,
                  style: TextStyle(color: colors.textPrimary),
                  decoration: InputDecoration(
                    hintText: '输入连接令牌',
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
                    suffixIcon: IconButton(
                      icon: Icon(
                        _obscureToken
                            ? Icons.visibility_off
                            : Icons.visibility,
                        color: colors.textSecondary,
                      ),
                      onPressed: () {
                        setState(() => _obscureToken = !_obscureToken);
                      },
                    ),
                  ),
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
                                        fontSize: 14,),
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
                  title: Text('推送通知',
                      style: TextStyle(
                          color: colors.textPrimary, fontSize: 14,),),
                  subtitle: Text(
                  'AI 任务完成时发送通知，并在点开后快速重连',
                  style: TextStyle(
                    color: colors.textSecondary, fontSize: 13,),
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
                  title: Text('后台保持连接',
                      style: TextStyle(
                          color: colors.textPrimary, fontSize: 14,),),
                  subtitle: Text(
                    '切到后台后启用常驻通知与前台服务，尽量保持 Relay 在线',
                    style: TextStyle(
                        color: colors.textSecondary, fontSize: 13,),
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
                          _themeButton('跟随系统', ThemeMode.system, currentMode, colors),
                          _themeButton('浅色', ThemeMode.light, currentMode, colors),
                          _themeButton('深色', ThemeMode.dark, currentMode, colors),
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
                        _accentButton('紫色', 'purple', const Color(0xFF7C3AED), currentAccent, colors),
                        const SizedBox(width: 8),
                        _accentButton('绿色', 'green', const Color(0xFF10B981), currentAccent, colors),
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
                    final connState = connSnap.data ?? WsConnectionState.disconnected;
                    return StreamBuilder<String?>(
                      stream: ConnectionManager.instance.desktopIdentityStream,
                      initialData: ConnectionManager.instance.desktopIdentity,
                      builder: (context, identitySnap) {
                        final identity = identitySnap.data;
                        final desktops = ConnectionManager.instance.desktops;
                        final desktop = desktops.isNotEmpty ? desktops.first : null;
                        return Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: colors.bgSecondary,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('桌面端',
                                  style: TextStyle(
                                      color: colors.textSecondary,
                                      fontSize: 14,
                                      fontWeight: FontWeight.w500,),),
                              const SizedBox(height: 8),
                              if (connState == WsConnectionState.connected && identity != null)
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
                                      style: TextStyle(color: colors.textPrimary, fontSize: 14),
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
                              StreamBuilder<WorkspaceInfo?>(
                                stream: SessionSyncService.instance.workspaceInfoStream,
                                initialData: SessionSyncService.instance.workspaceInfo,
                                builder: (context, wsSnap) {
                                  final wsInfo = wsSnap.data;
                                  if (wsInfo != null && connState == WsConnectionState.connected) {
                                    return Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        wsInfo.workspaceName,
                                        style: TextStyle(color: colors.textMuted, fontSize: 12),
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

                // -- Version info --
                Center(
                  child: Text(
                    'wzxClaw Android v2.0',
                    style: TextStyle(color: colors.textMuted, fontSize: 12),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _themeButton(String label, ThemeMode mode, ThemeMode current, AppColors colors) {
    final selected = mode == current;
    return Expanded(
      child: GestureDetector(
        onTap: () async {
          themeNotifier.value = mode;
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('theme_mode', mode == ThemeMode.light ? 'light' : mode == ThemeMode.dark ? 'dark' : 'system');
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected ? colors.accent.withValues(alpha: 0.15) : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: selected ? Border.all(color: colors.accent, width: 1.5) : null,
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

  Widget _accentButton(String label, String accent, Color color, String current, AppColors colors) {
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
            color: selected ? color.withValues(alpha: 0.15) : Colors.transparent,
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

/// Full-screen QR scanner page with scan frame overlay and torch toggle.
class _QrScannerPage extends StatefulWidget {
  const _QrScannerPage();

  @override
  State<_QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<_QrScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  bool _torchOn = false;
  bool _scanned = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final size = MediaQuery.of(context).size;
    final scanSize = size.width * 0.7;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描二维码'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
        actions: [
          IconButton(
            icon: Icon(_torchOn ? Icons.flash_on : Icons.flash_off,
                color: colors.textSecondary,),
            onPressed: () {
              setState(() => _torchOn = !_torchOn);
              _controller.toggleTorch();
            },
            tooltip: '手电筒',
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              if (_scanned) return;
              if (capture.barcodes.isEmpty) return;
              final barcode = capture.barcodes.first;
              if (barcode.rawValue != null) {
                _scanned = true;
                _controller.stop();
                Navigator.pop(context, barcode.rawValue);
              }
            },
          ),
          // Dimmed overlay with transparent scan window
          ColorFiltered(
            colorFilter: ColorFilter.mode(
                Colors.black.withValues(alpha: 0.5), BlendMode.srcOut,),
            child: Stack(
              children: [
                Container(
                  decoration: const BoxDecoration(
                    color: Colors.black,
                    backgroundBlendMode: BlendMode.dstOut,
                  ),
                ),
                Center(
                  child: Container(
                    width: scanSize,
                    height: scanSize,
                    decoration: BoxDecoration(
                      color: Colors.red,
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ],
            ),
          ),
          // Scan frame corners
          Center(
            child: SizedBox(
              width: scanSize,
              height: scanSize,
              child: CustomPaint(
                  painter: _ScanFramePainter(color: colors.accent),),
            ),
          ),
          // Hint text
          Positioned(
            left: 0,
            right: 0,
            bottom: size.height * 0.2,
            child: Text(
              '将二维码放入框内自动扫描',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }
}

/// Paints four corner brackets for the scan frame.
class _ScanFramePainter extends CustomPainter {
  final Color color;
  const _ScanFramePainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    const cornerLen = 24.0;
    const strokeWidth = 3.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // Top-left
    canvas.drawLine(const Offset(0, cornerLen), Offset.zero, paint);
    canvas.drawLine(Offset.zero, const Offset(cornerLen, 0), paint);
    // Top-right
    canvas.drawLine(
        Offset(size.width - cornerLen, 0), Offset(size.width, 0), paint,);
    canvas.drawLine(
        Offset(size.width, 0), Offset(size.width, cornerLen), paint,);
    // Bottom-left
    canvas.drawLine(
        Offset(0, size.height), Offset(0, size.height - cornerLen), paint,);
    canvas.drawLine(
        Offset(0, size.height), Offset(cornerLen, size.height), paint,);
    // Bottom-right
    canvas.drawLine(Offset(size.width, size.height - cornerLen),
        Offset(size.width, size.height), paint,);
    canvas.drawLine(Offset(size.width - cornerLen, size.height),
        Offset(size.width, size.height), paint,);
  }

  @override
  bool shouldRepaint(covariant _ScanFramePainter oldDelegate) =>
      color != oldDelegate.color;
}
