import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'config/app_colors.dart';
import 'pages/files_placeholder_page.dart';
import 'pages/home_page.dart';
import 'pages/landing_page.dart';
import 'pages/remote_control_page.dart';
import 'pages/settings_page.dart';
import 'zcode/zcode_chat_store.dart';
import 'zcode/zcode_desktop_registry.dart';
import 'zcode/zcode_keepalive_controller.dart';
import 'zcode/zcode_notifier.dart';

/// 全局导航 key（ZCode 任务完成通知点击跳转聊天页用）
final GlobalKey<NavigatorState> zcodeNavigatorKey = GlobalKey<NavigatorState>();

/// Global theme mode notifier — allows settings page to switch theme at runtime.
final ValueNotifier<ThemeMode> themeNotifier = ValueNotifier(ThemeMode.system);

/// Global accent color notifier ('green' or 'purple').
final ValueNotifier<String> accentNotifier = ValueNotifier('green');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 恢复多桌面注册表（每桌面 store + 配对；含旧版单配对迁移），并启动保活
  // 控制器（均异步执行，不阻塞首帧）
  unawaited(ZcodeDesktopRegistry.instance.restore());
  unawaited(ZcodeKeepAliveController.instance.initialize());
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
  // ZCode 任务完成通知：点击切到对应桌面/会话再进聊天页
  ZcodeNotifier.instance.onTapPayload = (payload) {
    String? sessionId;
    String? desktopId;
    if (payload != null && payload.isNotEmpty) {
      // 多桌面 payload 为 JSON{d,s}；旧版为纯 sessionId
      if (payload.startsWith('{')) {
        try {
          final decoded = jsonDecode(payload);
          if (decoded is Map) {
            desktopId = decoded['d']?.toString();
            sessionId = decoded['s']?.toString();
          }
        } catch (_) {
          sessionId = payload;
        }
      } else {
        sessionId = payload;
      }
    }
    if (desktopId != null && desktopId.isNotEmpty) {
      ZcodeDesktopRegistry.instance.setActive(desktopId);
    }
    if (sessionId != null && sessionId.isNotEmpty) {
      unawaited(ZcodeChatStore.instance.openSession(sessionId));
    }
    final navigator = zcodeNavigatorKey.currentState;
    if (navigator == null) return; // 导航器未就绪（首帧前）时忽略本次点击
    // 路由守卫：当前可见层已是 ChatPage（含其上方仅盖着对话框/权限弹层）
    // 时不再重复 push——避免重复点击通知堆叠多个 ChatPage，
    // 也不会把待答的权限对话框埋进隐藏页面
    if (_isChatPageVisible(navigator)) return;
    navigator.push(
      MaterialPageRoute(builder: (_) => const ChatPage()),
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

/// 判断导航栈当前“可见层”是否已有 [ChatPage]（通知点击的路由守卫）。
///
/// 实现方式：从 Navigator 的元素树向下遍历查找已挂载的 ChatPage，
/// 并用 [TickerMode.valuesOf] 过滤被不透明页面完全盖住的实例——
/// 盖住后 Overlay 仍会保持其元素挂载（offstage，仅停止布局/绘制），
/// 但会同时关闭该子树的 Ticker，据此区分“真正在可见层”与“被埋住”：
/// - ChatPage 位于栈顶，或其上仅有对话框等非全屏路由（如待答权限弹层）
///   → 在可见层 → 命中 → 跳过 push（避免堆叠页面、埋掉待答对话框）；
/// - ChatPage 被不透明页面（如设置页）完全盖住 → 不在可见层
///   → 正常 push（保留“从其他页面点通知跳转 ChatPage”的能力）。
/// 通知点击是低频事件，一次元素树遍历的开销可忽略。
bool _isChatPageVisible(NavigatorState navigator) {
  var found = false;
  void visit(Element element) {
    if (found) return;
    if (element.widget is ChatPage) {
      // valuesOf 无上层 TickerMode 时默认 enabled=true（保守按可见处理）
      if (TickerMode.valuesOf(element).enabled) found = true;
      // ChatPage 子树内不会再有 ChatPage，无需继续下钻；
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
                // 入口还原为旧 Landing 配对流程（回退 PR #15 直进 ZCode 方向）；
                // ZCode 不再作为首屏入口（设置页仍保留手动进入），聊天/会话
                // 数据层由 ZcodeChatStore 承接。
                '/': (context) => const LandingPage(),
                '/chat': (context) => const ChatPage(),
                '/settings': (context) => const SettingsPage(),
                // zcode app-server 协议暂无文件树 API，保留占位页防旧深链落空
                '/files': (context) => const FilesPlaceholderPage(),
                // v3 大脑网络：经 NAS relay 遥控任意大脑节点（旧协议栈复用）
                '/remote': (context) => const RemoteControlPage(),
              },
            );
          },
        );
      },
    );
  }
}
