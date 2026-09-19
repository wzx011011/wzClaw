// ============================================================
// zcode_notifier — ZCode 远程任务完成通知（flutter_local_notifications 封装）
//
// 职责：
// - initialize()：初始化插件 + 创建 Android 通知渠道 + 申请权限（幂等）
// - showTaskDone()：回合结束时弹通知（payload 带会话 id）；
//   前台守卫——App 处于 resumed（用户正看着界面）时跳过系统通知，
//   仅后台/最小化时弹出，避免前台打扰
// - 点击通知 → onTapPayload 回调（路由跳转由 UI 层接线）
//
// 运行时使用 ZcodeNotifier.instance 单例；通知偏好在本类内持久化并生效，
// 生命周期状态由 App 根入口转发。测试通过 setInstanceForTest 注入替身。
// ============================================================

import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 通知渠道
const String _channelId = 'zcode_remote';
const String _channelName = 'ZCode 远程任务';
const String _enabledKey = 'push_notifications_enabled';

/// ZCode 远程任务通知器。
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
  bool _enabled = true;

  /// 最近一次由根生命周期入口转发的状态（null 保守视为后台）。
  AppLifecycleState? _lifecycleState;

  /// 初始化插件、通知渠道并申请权限（幂等；仅 Android 生效）
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      _enabled = prefs.getBool(_enabledKey) ?? true;
    } catch (e) {
      debugPrint('[zcode-notifier] 读取通知偏好失败: $e');
    }
    if (!Platform.isAndroid) return;

    try {
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
    } catch (_) {
      // 插件不可用（测试环境/权限缺失）：保持 _plugin 为 null，
      // showTaskDone 静默跳过——通知是尽力而为的能力，不阻断主流程
    }
  }

  bool get enabled => _enabled;

  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_enabledKey, enabled);
  }

  /// 任务完成/失败通知
  ///
  /// 前台守卫：App 处于 [AppLifecycleState.resumed]（前台可见可交互）时，
  /// 用户已经看着界面——会话的流式输出与回合完成状态本身可见，
  /// 跳过系统通知避免打扰；后台/最小化（paused/inactive/hidden）及
  /// 状态未知（保守按后台）时照常弹出。
  ///
  /// [status] turn.terminal 的 status（success → 完成，其他 → 失败）
  /// [tokens] 本回合 token 数（展示用，可空）
  /// [sessionId] 点击通知时回传的 payload（可空）
  /// [desktopId]/[desktopName] 多桌面：payload 变为 JSON（含桌面 id 供路由
  /// 切换），标题带桌面名区分来源
  void showTaskDone({
    required String status,
    int? tokens,
    String? sessionId,
    String? desktopId,
    String? desktopName,
  }) {
    if (!_enabled || _lifecycleState == AppLifecycleState.resumed) return;

    final ok = status == 'success';
    final title = desktopName == null || desktopName.isEmpty
        ? (ok ? 'ZCode 任务完成' : 'ZCode 任务失败')
        : (ok ? '$desktopName · 任务完成' : '$desktopName · 任务失败');
    final body = StringBuffer('状态: $status');
    if (tokens != null) body.write(' · $tokens tokens');
    // 多桌面 payload：JSON{桌面id, 会话id}；单桌面/旧路径保持纯 sessionId
    final payload = desktopId == null
        ? sessionId
        : jsonEncode({'d': desktopId, if (sessionId != null) 's': sessionId});
    showSystemNotification(
      title: title,
      body: body.toString(),
      payload: payload,
    );
  }

  /// 反向请求通知：任务挂起等待用户操作（权限确认 / 引擎提问）。
  ///
  /// 守卫与 [showTaskDone] 一致（总开关 + 前台 resumed 跳过）——用户正看着
  /// 界面时权限条/问题条本身可见。反向请求帧不携带会话/桌面信息，
  /// payload 为空：点击仅打开 App，提醒是主目标。
  void showReverseRequest({required bool isAskUser, String? summary}) {
    if (!_enabled || _lifecycleState == AppLifecycleState.resumed) return;
    final title = isAskUser ? 'ZCode 任务在等你回答' : 'ZCode 任务在等你确认';
    var body = isAskUser ? '引擎提出了一个问题' : '有一个工具调用等待批准';
    final detail = summary?.trim() ?? '';
    if (detail.isNotEmpty) {
      body = detail.length <= 80 ? detail : '${detail.substring(0, 80)}…';
    }
    // 与完成通知（2001）分开 id，避免互相覆盖
    showSystemNotification(
      title: title,
      body: body,
      notificationId: isAskUser ? 2003 : 2002,
    );
  }

  /// 实际展示系统通知（[showTaskDone] 的落地动作）。
  ///
  /// 独立成可覆写方法便于测试：生产路径仅由本类内部调用（行为不变）；
  /// 测试替身覆写它即可断言“是否尝试弹通知”，从而绕开
  /// flutter_local_notifications 平台插件在单测环境不可用的问题。
  @visibleForTesting
  void showSystemNotification({
    required String title,
    required String body,
    String? payload,
    int notificationId = 2001,
  }) {
    final plugin = _plugin;
    if (plugin == null) return; // 未初始化（测试/非 Android）静默跳过

    // 尽力而为能力：展示失败只留观测，不允许未捕获异步异常冒泡
    plugin
        .show(
      notificationId,
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          channelDescription: 'ZCode 远程任务完成/失败提醒',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: payload,
    )
        .catchError((Object error) {
      debugPrint('[zcode-notifier] 通知展示失败: $error');
    });
  }

  /// 根生命周期入口转发；resumed 视为前台，其余状态均可通知。
  void handleLifecycleState(AppLifecycleState state) {
    _lifecycleState = state;
  }

  /// 点击通知：解析 payload 里的会话 id，转发给 UI 层回调
  void _onNotificationResponse(NotificationResponse response) {
    final payload = response.payload;
    onTapPayload?.call(payload == null || payload.isEmpty ? null : payload);
  }
}
