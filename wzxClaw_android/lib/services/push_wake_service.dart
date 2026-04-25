import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/ws_message.dart';
import 'connection_manager.dart';

const _pushEnabledKey = 'push_notifications_enabled';

/// 通知渠道 ID
const _channelId = 'wzx_task_done';

/// 推送唤醒服务：监听 ConnectionManager.messageStream，
/// 当 App 在后台且收到任务完成/出错事件时，弹出本地通知。
///
/// 依赖链：
///   启用通知 → 同时开启后台保活 → 前台 Service 保持进程存活
///   → WebSocket 保持连接 → messageStream 实时触达 → 本地通知
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
    await _notif.initialize(initSettings);

    // 创建通知渠道
    const channel = AndroidNotificationChannel(
      _channelId,
      'wzxClaw 任务通知',
      description: '任务完成或出错时弹出提醒',
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

    if (_enabled) {
      _startListening();
      // 开启前台保活，确保进程不被系统杀死
      await ConnectionManager.instance.setBackgroundKeepAliveEnabled(true);
    }
  }

  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_pushEnabledKey, enabled);

    if (!Platform.isAndroid) return;

    if (enabled) {
      _startListening();
      await ConnectionManager.instance.setBackgroundKeepAliveEnabled(true);
    } else {
      _stopListening();
      // 只有在用户也没有单独开启后台保活时才关掉
      if (!ConnectionManager.instance.backgroundKeepAliveEnabled) {
        await ConnectionManager.instance.setBackgroundKeepAliveEnabled(false);
      }
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
    _notif.show(
      isDone ? 1001 : 1002,
      isDone ? '✅ 任务执行完成' : '❌ 任务执行出错',
      isDone ? '点击打开 wzxClaw 查看结果' : '点击打开 wzxClaw 查看错误信息',
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          'wzxClaw 任务通知',
          channelDescription: '任务完成或出错时弹出提醒',
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
    );
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
