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
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/zcode/zcode_notifier.dart';

/// 通知器替身：记录 showSystemNotification（实际弹通知动作）的调用
class RecordingZcodeNotifier extends ZcodeNotifier {
  final List<Map<String, dynamic>> shown = [];

  @override
  void showSystemNotification({
    required String title,
    required String body,
    String? payload,
    int notificationId = 2001,
  }) {
    shown.add({
      'title': title,
      'body': body,
      'payload': payload,
      'notificationId': notificationId,
    });
  }
}

void main() {
  // _ensureObserverAttached 会访问 WidgetsBinding.instance，需先初始化测试 Binding
  TestWidgetsFlutterBinding.ensureInitialized();

  late RecordingZcodeNotifier notifier;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    notifier = RecordingZcodeNotifier();
  });

  test('前台（resumed）时 showTaskDone 跳过系统通知', () {
    notifier.handleLifecycleState(AppLifecycleState.resumed);
    notifier.showTaskDone(status: 'success', tokens: 120, sessionId: 's1');
    expect(notifier.shown, isEmpty);
  });

  test('后台（paused）时照常弹通知，且透传标题与 payload', () {
    notifier.handleLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: 120, sessionId: 's1');
    expect(notifier.shown, hasLength(1));
    expect(notifier.shown.first['title'], 'ZCode 任务完成');
    expect(notifier.shown.first['body'], contains('success'));
    expect(notifier.shown.first['payload'], 's1');
  });

  test('inactive/hidden（失焦/最小化）时照常弹通知', () {
    notifier.handleLifecycleState(AppLifecycleState.hidden);
    notifier.showTaskDone(status: 'success', tokens: 1, sessionId: null);
    expect(notifier.shown, hasLength(1));

    notifier.handleLifecycleState(AppLifecycleState.inactive);
    notifier.showTaskDone(status: 'failed', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(2));
    expect(notifier.shown.last['title'], 'ZCode 任务失败');
  });

  test('守卫跟随最新生命周期状态切换（后台→前台→后台）', () {
    notifier.handleLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1));

    notifier.handleLifecycleState(AppLifecycleState.resumed);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(1)); // 前台跳过，数量不变

    notifier.handleLifecycleState(AppLifecycleState.paused);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);
    expect(notifier.shown, hasLength(2));
  });

  test('通知开关关闭后不展示并持久化', () async {
    notifier.handleLifecycleState(AppLifecycleState.paused);
    await notifier.setEnabled(false);
    notifier.showTaskDone(status: 'success', tokens: null, sessionId: null);

    expect(notifier.enabled, isFalse);
    expect(notifier.shown, isEmpty);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('push_notifications_enabled'), isFalse);
  });

  group('showReverseRequest（反向请求：权限确认 / 引擎提问）', () {
    test('后台时权限请求弹通知：独立 id，摘要带工具名', () {
      notifier.handleLifecycleState(AppLifecycleState.paused);
      notifier.showReverseRequest(isAskUser: false, summary: 'Bash');
      expect(notifier.shown, hasLength(1));
      expect(notifier.shown.first['title'], 'ZCode 任务在等你确认');
      expect(notifier.shown.first['body'], 'Bash');
      expect(notifier.shown.first['notificationId'], 2002);
    });

    test('AskUser 请求弹「等你回答」通知，id 与权限通知分开', () {
      notifier.handleLifecycleState(AppLifecycleState.paused);
      notifier.showReverseRequest(isAskUser: true, summary: '选择部署目标');
      expect(notifier.shown.first['title'], 'ZCode 任务在等你回答');
      expect(notifier.shown.first['body'], '选择部署目标');
      expect(notifier.shown.first['notificationId'], 2003);
    });

    test('前台（resumed）时跳过——权限条/问题条本身可见', () {
      notifier.handleLifecycleState(AppLifecycleState.resumed);
      notifier.showReverseRequest(isAskUser: false, summary: 'Bash');
      expect(notifier.shown, isEmpty);
    });

    test('摘要为空时用兜底文案；超长截断到 80 字符', () {
      notifier.handleLifecycleState(AppLifecycleState.paused);
      notifier.showReverseRequest(isAskUser: false, summary: '  ');
      expect(notifier.shown.first['body'], '有一个工具调用等待批准');

      notifier.showReverseRequest(isAskUser: true, summary: '问' * 100);
      final body = notifier.shown.last['body'] as String;
      expect(body.length, 81); // 80 字符 + 省略号
      expect(body.endsWith('…'), isTrue);
    });

    test('总开关关闭时同样不展示', () async {
      notifier.handleLifecycleState(AppLifecycleState.paused);
      await notifier.setEnabled(false);
      notifier.showReverseRequest(isAskUser: false, summary: 'Bash');
      expect(notifier.shown, isEmpty);
    });
  });
}
