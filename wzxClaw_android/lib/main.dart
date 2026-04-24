import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'config/app_colors.dart';
import 'pages/file_browser_page.dart';
import 'pages/home_page.dart';
import 'pages/settings_page.dart';
import 'services/file_sync_service.dart';
import 'services/session_sync_service.dart';

/// Global theme mode notifier — allows settings page to switch theme at runtime.
final ValueNotifier<ThemeMode> themeNotifier = ValueNotifier(ThemeMode.system);

/// Global accent color notifier ('green' or 'purple').
final ValueNotifier<String> accentNotifier = ValueNotifier('green');

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Initialize services early so they start listening
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
                '/': (context) => const HomePage(),
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
