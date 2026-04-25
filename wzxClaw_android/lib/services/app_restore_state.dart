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
  static const _sessionViewPrefix = 'session_view';
  static const _liveChatSentinel = '__live__';
  static const _noTaskSentinel = '__no_task__';

  static Future<void> setLastRoute(String route) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastRouteKey, route);
  }

  static Future<String?> getLastRoute() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_lastRouteKey);
  }

  static Future<void> setLastViewedSession({
    required String desktopId,
    required String? taskId,
    required String? sessionId,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final value = sessionId ?? _liveChatSentinel;
    await prefs.setString(_sessionViewKey(desktopId, taskId), value);
  }

  static Future<SessionViewRestoreState> getLastViewedSession({
    required String desktopId,
    required String? taskId,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_sessionViewKey(desktopId, taskId));
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

  static String _sessionViewKey(String desktopId, String? taskId) =>
      '$_sessionViewPrefix::$desktopId::${taskId ?? _noTaskSentinel}';
}