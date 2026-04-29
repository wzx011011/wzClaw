import 'package:shared_preferences/shared_preferences.dart';

class SessionViewRestoreState {
  const SessionViewRestoreState({
    required this.hasSavedSelection,
    required this.sessionId,
  });

  final bool hasSavedSelection;
  final String? sessionId;
}

class AppRestoreState {
  AppRestoreState._();

  static const _lastRouteKey = 'last_route';
  static const _lastWorkspacePathKey = 'last_workspace_path';
  static const _sessionViewPrefix = 'session_view';
  static const _liveChatSentinel = '__live__';

  static Future<void> setLastRoute(String route) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastRouteKey, route);
  }

  static Future<String?> getLastRoute() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastRouteKey);
  }

  static Future<void> setLastWorkspacePath(String path) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastWorkspacePathKey, path);
  }

  static Future<String?> getLastWorkspacePath() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastWorkspacePathKey);
  }

  static Future<void> setLastViewedSession({
    required String desktopId,
    required String? sessionId,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final value = sessionId ?? _liveChatSentinel;
    await prefs.setString(_sessionViewKey(desktopId), value);
  }

  static Future<SessionViewRestoreState> getLastViewedSession({
    required String desktopId,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_sessionViewKey(desktopId));
    if (value == null) {
      return const SessionViewRestoreState(
        hasSavedSelection: false,
        sessionId: null,
      );
    }
    return SessionViewRestoreState(
      hasSavedSelection: true,
      sessionId: value == _liveChatSentinel ? null : value,
    );
  }

  static String _sessionViewKey(String desktopId) =>
      '$_sessionViewPrefix::$desktopId';
}
