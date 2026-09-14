import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'config/app_colors.dart';
import 'pages/file_browser_page.dart';
import 'pages/home_page.dart';
import 'pages/settings_page.dart';
import 'pages/zcode_page.dart';
import 'services/file_sync_service.dart';
import 'services/push_wake_service.dart';
import 'services/session_sync_service.dart';
import 'zcode/zcode_notifier.dart';

/// 全局导航 key（ZCode 任务完成通知点击跳转用）
final GlobalKey<NavigatorState> zcodeNavigatorKey = GlobalKey<NavigatorState>();

/// Global theme mode notifier — allows settings page to switch theme at runtime.
final ValueNotifier<ThemeMode> themeNotifier = ValueNotifier(ThemeMode.system);

/// Global accent color notifier ('green' or 'purple').
final ValueNotifier<String> accentNotifier = ValueNotifier('green');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Initialize services early so they start listening (lightweight — only subscribes to streams)
  SessionSyncService.instance;
  FileSyncService.instance;
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
  // ZCode 任务完成通知：点击跳转到 ZCode 远程控制页
  ZcodeNotifier.instance.onTapPayload = (_) {
    final navigator = zcodeNavigatorKey.currentState;
    if (navigator == null) return; // 导航器未就绪（首帧前）时忽略本次点击
    // 路由守卫：当前可见层已是 ZcodePage（含其上方仅盖着对话框/权限弹层）
    // 时不再重复 push——避免重复点击通知堆叠多个 ZcodePage，
    // 也不会把待答的权限对话框埋进隐藏页面
    if (_isZcodePageVisible(navigator)) return;
    navigator.push(
      MaterialPageRoute(builder: (_) => const ZcodePage()),
    );
  };
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

/// 判断导航栈当前“可见层”是否已有 [ZcodePage]（通知点击的路由守卫）。
///
/// 实现方式：从 Navigator 的元素树向下遍历查找已挂载的 ZcodePage，
/// 并用 [TickerMode.valuesOf] 过滤被不透明页面完全盖住的实例——
/// 盖住后 Overlay 仍会保持其元素挂载（offstage，仅停止布局/绘制），
/// 但会同时关闭该子树的 Ticker，据此区分“真正在可见层”与“被埋住”：
/// - ZcodePage 位于栈顶，或其上仅有对话框等非全屏路由（如待答权限弹层）
///   → 在可见层 → 命中 → 跳过 push（避免堆叠页面、埋掉待答对话框）；
/// - ZcodePage 被不透明页面（如配对扫码页）完全盖住 → 不在可见层
///   → 正常 push（保留“从其他页面点通知跳转 ZcodePage”的能力）。
/// 通知点击是低频事件，一次元素树遍历的开销可忽略。
bool _isZcodePageVisible(NavigatorState navigator) {
  var found = false;
  void visit(Element element) {
    if (found) return;
    if (element.widget is ZcodePage) {
      // valuesOf 无上层 TickerMode 时默认 enabled=true（保守按可见处理）
      if (TickerMode.valuesOf(element).enabled) found = true;
      // ZcodePage 子树内不会再有 ZcodePage，无需继续下钻；
      // 兄弟节点（栈上更靠上的路由）仍会被继续遍历
      return;
    }
    element.visitChildElements(visit);
  }

  navigator.context.visitChildElements(visit);
  return found;
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
              navigatorKey: zcodeNavigatorKey,
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
                // 入口直进 ZCode 远程控制（PLAN-zcode-remote-v2 P0.2 入口简化）：
                // 已配对自动重连，未配对先进配对视图。旧 LandingPage 流程退役。
                '/': (context) => const ZcodePage(),
                '/chat': (context) => const ChatPage(),
                '/settings': (context) => const SettingsPage(),
                '/files': (context) => const FileBrowserPage(),
              },
            );
          },
        );
      },
    );
  }
}
