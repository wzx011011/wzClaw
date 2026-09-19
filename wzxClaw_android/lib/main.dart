import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'config/app_colors.dart';
import 'models/connection_state.dart';
import 'pages/connection_diagnostics_page.dart';
import 'pages/goal_panel_page.dart';
import 'pages/home_page.dart';
import 'pages/landing_page.dart';
import 'pages/settings_page.dart';
import 'services/connection_manager.dart';
import 'services/goal_store.dart';
import 'zcode/zcode_chat_store.dart';
import 'zcode/zcode_keepalive_controller.dart';
import 'models/ui_prefs.dart';
import 'zcode/zcode_notifier.dart';

/// Global theme mode notifier — allows settings page to switch theme at runtime.
final ValueNotifier<ThemeMode> themeNotifier = ValueNotifier(ThemeMode.system);

/// Global accent color notifier ('green' or 'purple').
final ValueNotifier<String> accentNotifier = ValueNotifier('green');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Initialize services early so they start listening (lightweight — only subscribes to streams)
  // Load persisted theme mode
  final prefs = await SharedPreferences.getInstance();
  final saved = prefs.getString('theme_mode');
  if (saved == 'light') {
    themeNotifier.value = ThemeMode.light;
  } else if (saved == 'dark') {
    themeNotifier.value = ThemeMode.dark;
  }
  // Load persisted accent color
  final savedAccent = prefs.getString('accent_color') ?? 'green';
  accentNotifier.value = savedAccent;
  GoalStore.instance;
  await ZcodeNotifier.instance.initialize();
  await ZcodeKeepAliveController.instance.initialize();
  await UiPrefs.load();
  runApp(const WzxClawApp());
}

ThemeData _buildTheme(AppColors colors, Brightness brightness) {
  return ThemeData(
    brightness: brightness,
    scaffoldBackgroundColor: colors.bgPrimary,
    primaryColor: colors.accent,
    extensions: [colors],
    appBarTheme: AppBarTheme(
      backgroundColor: colors.bgSecondary,
      foregroundColor: colors.textPrimary,
      elevation: 0,
    ),
    colorScheme: ColorScheme.fromSeed(
      seedColor: colors.accent,
      brightness: brightness,
      surface: colors.bgSecondary,
    ).copyWith(
      primary: colors.accent,
      secondary: colors.accent,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: colors.bgElevated,
      contentTextStyle: TextStyle(color: colors.textPrimary),
    ),
    dividerColor: colors.border,
    useMaterial3: true,
  );
}

/// Root widget for wzxClaw Android.
class WzxClawApp extends StatefulWidget {
  const WzxClawApp({super.key});

  @override
  State<WzxClawApp> createState() => _WzxClawAppState();
}

class _WzxClawAppState extends State<WzxClawApp> with WidgetsBindingObserver {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ZcodeNotifier.instance.onTapPayload = _handleNotificationTap;
    final state = WidgetsBinding.instance.lifecycleState;
    if (state != null) _forwardLifecycle(state);
  }

  @override
  void dispose() {
    ZcodeNotifier.instance.onTapPayload = null;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _forwardLifecycle(state);
  }

  void _forwardLifecycle(AppLifecycleState state) {
    ConnectionManager.instance.handleLifecycleState(state);
    ZcodeKeepAliveController.instance.handleLifecycleState(state);
    ZcodeNotifier.instance.handleLifecycleState(state);
  }

  Future<void> _handleNotificationTap(String? payload) async {
    if (payload == null || payload.isEmpty) return;
    String? desktopId;
    String? sessionId = payload;
    if (payload.startsWith('{')) {
      try {
        final decoded = jsonDecode(payload);
        if (decoded is Map) {
          desktopId = decoded['d']?.toString();
          sessionId = decoded['s']?.toString();
        }
      } catch (e) {
        debugPrint('[notification] 无法解析通知 payload: $e');
        return;
      }
    }
    if (desktopId != null &&
        desktopId != ConnectionManager.instance.selectedDesktopId) {
      final found = await ConnectionManager.instance.connectToStored(desktopId);
      if (!found) return;
    } else if (ConnectionManager.instance.state ==
        WsConnectionState.disconnected) {
      await ConnectionManager.instance.connectFromSavedConfiguration();
    }
    if (ConnectionManager.instance.state != WsConnectionState.connected) {
      try {
        await ConnectionManager.instance.stateStream
            .firstWhere((state) => state == WsConnectionState.connected)
            .timeout(const Duration(seconds: 10));
      } on TimeoutException {
        return;
      }
    }
    if (sessionId == null || sessionId.isEmpty) return;
    await ZcodeChatStore.instance.openSession(sessionId);
    _navigatorKey.currentState?.pushNamedAndRemoveUntil('/chat', (_) => false);
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeNotifier,
      builder: (context, mode, _) {
        return ValueListenableBuilder<String>(
          valueListenable: accentNotifier,
          builder: (context, accent, _) {
            final isGreen = accent == 'green';
            return MaterialApp(
              navigatorKey: _navigatorKey,
              title: 'wzxClaw',
              theme: _buildTheme(
                isGreen ? AppColors.lightGreen : AppColors.light,
                Brightness.light,
              ),
              darkTheme: _buildTheme(
                isGreen ? AppColors.darkGreen : AppColors.dark,
                Brightness.dark,
              ),
              themeMode: mode,
              initialRoute: '/',
              routes: {
                '/': (context) => const LandingPage(),
                '/chat': (context) => const ChatPage(),
                '/goal-panel': (context) => const GoalPanelPage(),
                '/settings': (context) => const SettingsPage(),
                '/connection-diagnostics': (context) =>
                    const ConnectionDiagnosticsPage(),
                // app-server 未实测到文件树/读取接口；保留旧深链但不再触发会超时的旧协议。
              },
            );
          },
        );
      },
    );
  }
}
