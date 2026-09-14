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
// 运行时使用 ZcodeNotifier.instance 单例（与 PushWakeService 风格一致）；
// 测试通过 setInstanceForTest 注入替身。
// 仅以 Android 为主（现有 App 就是 Android）。
// ============================================================

import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// 通知渠道
const String _channelId = 'zcode_remote';
const String _channelName = 'ZCode 远程任务';

/// ZCode 远程任务通知器
///
/// 混入 [WidgetsBindingObserver] 仅为跟踪应用前后台状态（前台守卫用），
/// 观察者懒挂（首次 showTaskDone 时），可经 dispose 正确移除。
class ZcodeNotifier with WidgetsBindingObserver {
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

  // ---------- 前台守卫：生命周期观察 ----------

  /// 最近一次观察到的应用生命周期状态（null = 尚未收到任何事件）
  AppLifecycleState? _lifecycleState;

  /// 观察者是否已挂到 WidgetsBinding（懒挂幂等标记）
  bool _observerAttached = false;

  /// 初始化插件、通知渠道并申请权限（幂等；仅 Android 生效）
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
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
  void showTaskDone({
    required String status,
    int? tokens,
    String? sessionId,
  }) {
    // 懒挂生命周期观察者：首次真正需要判断前后台时才注册（幂等）
    _ensureObserverAttached();
    if (_lifecycleState == AppLifecycleState.resumed) return; // 前台跳过

    final ok = status == 'success';
    final title = ok ? 'ZCode 任务完成' : 'ZCode 任务失败';
    final body = StringBuffer('状态: $status');
    if (tokens != null) body.write(' · $tokens tokens');
    showSystemNotification(
      title: title,
      body: body.toString(),
      payload: sessionId,
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
  }) {
    final plugin = _plugin;
    if (plugin == null) return; // 未初始化（测试/非 Android）静默跳过

    plugin.show(
      2001,
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
    );
  }

  /// 懒挂 WidgetsBindingObserver（幂等）。
  ///
  /// 挂载时用 Binding 当前的 lifecycleState 播种，避免“挂载前引擎已派发过
  /// 状态”导致首条通知误判前后台；此后由 didChangeAppLifecycleState 持续刷新。
  /// 用 ??= 而非直接赋值：测试/复用实例场景下已显式注入过状态时尊重现有值。
  void _ensureObserverAttached() {
    if (_observerAttached) return;
    _observerAttached = true;
    _lifecycleState ??= WidgetsBinding.instance.lifecycleState;
    WidgetsBinding.instance.addObserver(this);
  }

  /// 移除生命周期观察者并复位挂载标记。
  ///
  /// 单例随 App 全程存活，生产路径无需调用；测试替换/复用实例时清理，
  /// 避免观察者泄漏与重复回调。
  @visibleForTesting
  void dispose() {
    if (!_observerAttached) return;
    _observerAttached = false;
    WidgetsBinding.instance.removeObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 仅记录最新状态：resumed = 前台可交互，其余均视为不在前台
    _lifecycleState = state;
  }

  /// 点击通知：解析 payload 里的会话 id，转发给 UI 层回调
  void _onNotificationResponse(NotificationResponse response) {
    final payload = response.payload;
    onTapPayload?.call(payload == null || payload.isEmpty ? null : payload);
  }
}
