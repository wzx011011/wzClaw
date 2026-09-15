// ============================================================
// zcode_notifier_test — 通知器前台守卫单元测试
//
// 覆盖：
// - resumed（前台可交互）时 showTaskDone 跳过系统通知（不打扰）
// - 后台/最小化（paused/inactive/hidden）及未知状态照常弹出
// - 守卫跟随最新生命周期状态切换
// - 懒挂观察者后能收到 Binding 派发的生命周期事件（等价引擎路径）
//
// 测试替身覆写 @visibleForTesting 的 showSystemNotification 记录调用，
// 绕开 flutter_local_notifications 平台插件在单测环境不可用的问题；
// 生命周期状态通过直接驱动 didChangeAppLifecycleState 注入
// （与引擎经 WidgetsBinding 派发到观察者的路径等价）。
// ============================================================

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:wzxclaw_android/zcode/zcode_notifier.dart';

/// 通知器替身：记录 showSystemNotification（实际弹通知动作）的调用
class RecordingZcodeNotifier extends ZcodeNotifier {
  final List<Map<String, dynamic>> shown = [];

  @override
  void showSystemNotification({
    required String title,
    required String body,
    String? payload,
  }) {
    shown.add({'title': title, 'body': body, 'payload': payload});
  }
}

void main() {
  // _ensureObserverAttached 会访问 WidgetsBinding.instance，需先初始化测试 Binding
  TestWidgetsFlutterBinding.ensureInitialized();

  late RecordingZcodeNotifier notifier;

  setUp(() {
    notifier = RecordingZcodeNotifier();
  });

  tearDown(() {
    // 清理懒挂的观察者（也顺带覆盖 dispose 的移除路径）
    notifier.dispose();
  });

  test('前台（resumed）时 showTaskDone 跳过系统通知', () {
    notifier.didChangeAppLifecycleState(AppLifecycleState.resumed);
    notifier.showTaskDone(status: 'success', tokens: 120, sessionId: 's1');
    expect(notifier.shown, isEmpty);
  });

  test('后台（paused）时照常弹通知，且透传标题与 payload', () {
    notifier.didChangeAppLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: 120, sessionId: 's1');
    expect(notifier.shown, hasLength(1));
    expect(notifier.shown.first['title'], 'ZCode 任务完成');
    expect(notifier.shown.first['body'], contains('success'));
    expect(notifier.shown.first['payload'], 's1');
  });

  test('inactive/hidden（失焦/最小化）时照常弹通知', () {
    notifier.didChangeAppLifecycleState(AppLifecycleState.hidden);
    notifier.showTaskDone(status: 'success', tokens: 1, sessionId: null);
    expect(notifier.shown, hasLength(1));

    notifier.didChangeAppLifecycleState(AppLifecycleState.inactive);
    notifier.showTaskDone(status: 'failed', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(2));
    expect(notifier.shown.last['title'], 'ZCode 任务失败');
  });

  test('守卫跟随最新生命周期状态切换（后台→前台→后台）', () {
    notifier.didChangeAppLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1));

    notifier.didChangeAppLifecycleState(AppLifecycleState.resumed);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1)); // 前台跳过，数量不变

    notifier.didChangeAppLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(2));
  });

  test('懒挂观察者后能收到 Binding 派发的生命周期事件', () {
    // 首次 showTaskDone 触发观察者懒挂；未知状态（尚未收到任何事件）按后台处理
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1));

    // 经 Binding 派发 resumed（与引擎 SystemChannels.lifecycle 同路径）
    WidgetsBinding.instance
        .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1)); // 收到 resumed → 前台跳过

    WidgetsBinding.instance
        .handleAppLifecycleStateChanged(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(2));
  });
}
