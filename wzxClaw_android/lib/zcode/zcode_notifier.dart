// ============================================================
// zcode_notifier — ZCode 远程任务完成通知（flutter_local_notifications 封装）
//
// 职责：
// - initialize()：初始化插件 + 创建 Android 通知渠道 + 申请权限（幂等）
// - showTaskDone()：回合结束时弹通知（payload 带会话 id）
// - 点击通知 → onTapPayload 回调（路由跳转由 UI 层接线）
//
// 运行时使用 ZcodeNotifier.instance 单例（与 PushWakeService 风格一致）；
// 测试通过 setInstanceForTest 注入替身。
// 仅以 Android 为主（现有 App 就是 Android）。
// ============================================================

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// 通知渠道
const String _channelId = 'zcode_remote';
const String _channelName = 'ZCode 远程任务';

/// ZCode 远程任务通知器
class ZcodeNotifier {
  /// 公开构造便于测试替换替身；运行时请使用 [instance]。
  ZcodeNotifier();

  static ZcodeNotifier _instance = ZcodeNotifier();

  /// 全局单例
  static ZcodeNotifier get instance => _instance;

  /// 仅测试使用：替换全局单例，注入替身
  @visibleForTesting
  static void setInstanceForTest(ZcodeNotifier notifier) {
    _instance = notifier;
  }

  /// 仅测试使用：恢复默认单例
  @visibleForTesting
  static void resetInstanceForTest() {
    _instance = ZcodeNotifier();
  }

  /// 点击通知回调（payload 为会话 id；由 UI 层接线做路由跳转）
  void Function(String? sessionId)? onTapPayload;

  FlutterLocalNotificationsPlugin? _plugin;
  bool _initialized = false;

  /// 初始化插件、通知渠道并申请权限（幂等；仅 Android 生效）
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    if (!Platform.isAndroid) return;

    final plugin = FlutterLocalNotificationsPlugin();
    _plugin = plugin;

    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/launcher_icon'),
    );
    await plugin.initialize(
      settings,
      onDidReceiveNotificationResponse: _onNotificationResponse,
    );

    // 创建通知渠道
    const channel = AndroidNotificationChannel(
      _channelId,
      _channelName,
      description: 'ZCode 远程任务完成/失败提醒',
      importance: Importance.high,
    );
    await plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(channel);

    // Android 13+ 申请通知权限
    await plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();
  }

  /// 任务完成/失败通知
  ///
  /// [status] turn.terminal 的 status（success → 完成，其他 → 失败）
  /// [tokens] 本回合 token 数（展示用，可空）
  /// [sessionId] 点击通知时回传的 payload（可空）
  void showTaskDone({
    required String status,
    int? tokens,
    String? sessionId,
  }) {
    final plugin = _plugin;
    if (plugin == null) return; // 未初始化（测试/非 Android）静默跳过

    final ok = status == 'success';
    final title = ok ? 'ZCode 任务完成' : 'ZCode 任务失败';
    final body = StringBuffer('状态: $status');
    if (tokens != null) body.write(' · $tokens tokens');

    plugin.show(
      2001,
      title,
      body.toString(),
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          channelDescription: 'ZCode 远程任务完成/失败提醒',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: sessionId,
    );
  }

  /// 点击通知：解析 payload 里的会话 id，转发给 UI 层回调
  void _onNotificationResponse(NotificationResponse response) {
    final payload = response.payload;
    onTapPayload?.call(payload == null || payload.isEmpty ? null : payload);
  }
}
