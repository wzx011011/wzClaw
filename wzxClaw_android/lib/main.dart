import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'config/app_colors.dart';
import 'pages/files_placeholder_page.dart';
import 'pages/goal_panel_page.dart';
import 'pages/home_page.dart';
import 'pages/landing_page.dart';
import 'pages/settings_page.dart';
import 'services/file_sync_service.dart';
import 'services/goal_store.dart';
import 'services/push_wake_service.dart';
import 'zcode/zcode_keepalive_controller.dart';
import 'zcode/zcode_notifier.dart';
import 'services/session_sync_service.dart';

/// Global theme mode notifier — allows settings page to switch theme at runtime.
final ValueNotifier<ThemeMode> themeNotifier = ValueNotifier(ThemeMode.system);

/// Global accent color notifier ('green' or 'purple').
final ValueNotifier<String> accentNotifier = ValueNotifier('green');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Initialize services early so they start listening (lightweight — only subscribes to streams)
  SessionSyncService.instance;
  FileSyncService.instance;
  GoalStore.instance; // 尽早订阅 goal 快照广播（回合驱动刷新即开始积累状态）
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
  // PushWakeService init (notification channel setup, permission request) is not
  // needed before the first frame — defer so runApp() is called immediately.
  unawaited(PushWakeService.instance.initialize());
  // ZCode 任务完成通知：渠道创建 + 权限申请（幂等；当前聊天栈
  // services/chat_store 的 turn done 也会调用它，不再依赖 zcode 桌面注册表先加载）
  unawaited(ZcodeNotifier.instance.initialize());
  // 后台保活控制器（幂等）：注册生命周期观察——paused 起前台服务、
  // 回前台停服务并对注册表内各桌面 store 做快速重连快检。
  // 注意：registry.restore() 此处**有意不调用**——当前聊天 UI 走
  // ConnectionManager（自建 client，回前台快检在 _resumeCheck），
  // 提前恢复注册表会为每个桌面开无 UI 消费端的平行连接；等 zcode
  // 聊天页落地时随页接线。
  unawaited(ZcodeKeepAliveController.instance.initialize());
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
class WzxClawApp extends StatelessWidget {
  const WzxClawApp({super.key});

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
                // app-server 未实测到文件树/读取接口；保留旧深链但不再触发会超时的旧协议。
                '/files': (context) => const FilesPlaceholderPage(),
              },
            );
          },
        );
      },
    );
  }
}
