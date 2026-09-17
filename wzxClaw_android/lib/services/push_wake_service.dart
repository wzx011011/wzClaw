import 'dart:async';
import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../zcode/zcode_chat_store.dart';

const _pushEnabledKey = 'push_notifications_enabled';

/// 通知渠道 ID
const _channelId = 'wzx_workspace_notification';

/// 推送唤醒服务：监听 ConnectionManager.messageStream，
/// 当 App 在后台且收到工作区完成/出错事件时，弹出本地通知。
///
/// 通知偏好与后台保活偏好彼此独立：通知只决定是否订阅和展示提醒；
/// 后台保活由 ZcodeKeepAliveController 的单独设置决定。
class PushWakeService {
  PushWakeService._();

  static final PushWakeService instance = PushWakeService._();

  bool _initialized = false;


  final FlutterLocalNotificationsPlugin _notif = FlutterLocalNotificationsPlugin();

  // ──────────────────────────────────────────────
  // 公共 API
  // ──────────────────────────────────────────────

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;

    if (!Platform.isAndroid) return;


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

  }

  Future<void> setEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_pushEnabledKey, enabled);

    if (!Platform.isAndroid) return;

  }

  // ──────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────



  void _onNotificationTapped(NotificationResponse response) {
    final sessionId = response.payload;
    if (sessionId != null && sessionId.isNotEmpty) {
      ZcodeChatStore.instance.openSession(sessionId);
    }
  }

}
