import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/ws_message.dart';
import 'connection_manager.dart';
import 'session_sync_service.dart';

const _pushEnabledKey = 'push_notifications_enabled';

/// 通知渠道 ID
const _channelId = 'wzx_workspace_notification';

/// 推送唤醒服务：监听 ConnectionManager.messageStream，
/// 当 App 在后台且收到工作区完成/出错事件时，弹出本地通知。
///
/// 通知偏好与后台保活偏好彼此独立：通知只决定是否订阅和展示提醒；
/// 后台保活由 ZcodeKeepAliveController 的单独设置决定。
class PushWakeService with WidgetsBindingObserver {
  PushWakeService._();

  static final PushWakeService instance = PushWakeService._();

  bool _initialized = false;
  bool _enabled = true;

  /// App 是否在前台（WidgetsBindingObserver 驱动）
  bool _inForeground = true;

  StreamSubscription<WsMessage>? _msgSub;
  final FlutterLocalNotificationsPlugin _notif = FlutterLocalNotificationsPlugin();

  // ──────────────────────────────────────────────
  // 公共 API
  // ──────────────────────────────────────────────

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    if (!Platform.isAndroid) return;

    _enabled = await _loadEnabled();

    // 初始化本地通知
    const initSettings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/launcher_icon'),
    );
    await _notif.initialize(
      initSettings,
      onDidReceiveNotificationResponse: _onNotificationTapped,
    );

    // 创建通知渠道
    const channel = AndroidNotificationChannel(
      _channelId,
      'wzxClaw 工作区通知',
      description: '工作区完成或出错时弹出提醒',
      importance: Importance.high,
    );
    await _notif
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(channel);

    // Android 13+ 申请通知权限
    await _notif
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();

    // 监听 App 生命周期
    WidgetsBinding.instance.addObserver(this);

    if (_enabled) _startListening();
  }

  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_pushEnabledKey, enabled);

    if (!Platform.isAndroid) return;

    if (enabled) {
      _startListening();
    } else {
      _stopListening();
    }
  }

  /// 兼容旧版 main.dart 调用（前台 Service 方案无需处理待处理事件）
  Future<void> applyPendingWakeReconnect() async {}

  // ──────────────────────────────────────────────
  // WidgetsBindingObserver
  // ──────────────────────────────────────────────

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _inForeground = true;
        break;
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        _inForeground = false;
        break;
      default:
        break;
    }
  }

  // ──────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────

  void _startListening() {
    if (_msgSub != null) return; // 已在监听
    _msgSub = ConnectionManager.instance.messageStream.listen(_onMessage);
  }

  void _stopListening() {
    _msgSub?.cancel();
    _msgSub = null;
  }

  void _onMessage(WsMessage msg) {
    if (_inForeground) return; // App 在前台，无需通知
    if (msg.event != WsEvents.agentDone && msg.event != WsEvents.agentError) return;

    final isDone = msg.event == WsEvents.agentDone;
    final data = msg.data;
    final sessionId = data is Map ? data['sessionId'] as String? : null;

    // 查找会话标题
    String sessionTitle = '';
    if (sessionId != null) {
      final sessions = SessionSyncService.instance.sessions;
      final match = sessions.where((s) => s.id == sessionId).firstOrNull;
      if (match != null) sessionTitle = match.title;
    }

    final title = isDone ? '工作区执行完成' : '工作区执行出错';
    final body = sessionTitle.isNotEmpty
        ? (isDone ? '「$sessionTitle」已完成' : '「$sessionTitle」执行出错')
        : (isDone ? '点击打开 wzxClaw 查看结果' : '点击打开 wzxClaw 查看错误信息');

    _notif.show(
      isDone ? 1001 : 1002,
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'wzxClaw 工作区通知',
          channelDescription: '工作区完成或出错时弹出提醒',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: sessionId,
    );
  }

  void _onNotificationTapped(NotificationResponse response) {
    final sessionId = response.payload;
    if (sessionId != null && sessionId.isNotEmpty) {
      SessionSyncService.instance.setActiveSession(sessionId);
    }
  }

  Future<bool> _loadEnabled() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(_pushEnabledKey) ?? true;
    } catch (_) {
      return true;
    }
  }
}
