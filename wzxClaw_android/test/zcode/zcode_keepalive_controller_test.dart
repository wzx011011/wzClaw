// ============================================================
// zcode_keepalive_controller 回归测试
//
// 回归背景（2026-09-16 审查发现）：_shouldRun 曾只查 v3 注册表，而
// registry 有意未接线 → 恒 false → 前台服务在产线一次都无法启动，
// 「后台保持连接」开关成了假开关（打开只写 pref，paused 时啥也不做）。
// 修复后 _shouldRun 为双数据源（活跃栈 ConnectionManager || v3 注册表）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:wzxclaw_android/zcode/zcode_keepalive_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final c = ZcodeKeepAliveController.instance;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeKeepAliveController.debugAndroidOverride = false;
    ZcodeKeepAliveController.linkedProvider = null;
    c.debugForegroundCalls.clear();
  });

  tearDown(() {
    ZcodeKeepAliveController.debugAndroidOverride = false;
    ZcodeKeepAliveController.linkedProvider = null;
    c.debugForegroundCalls.clear();
  });

  test('paused 且开关开且活跃链路活 → 启动前台服务（假开关回归锚）', () async {
    await c.initialize();
    await c.setEnabled(true);
    ZcodeKeepAliveController.debugAndroidOverride = true;
    ZcodeKeepAliveController.linkedProvider = () => true;

    c.didChangeAppLifecycleState(AppLifecycleState.paused);
    await Future<void>.delayed(Duration.zero);

    expect(c.debugForegroundCalls, contains('start'));
  });

  test('开关关 → paused 不启动前台服务（关闭即时生效）', () async {
    await c.initialize();
    await c.setEnabled(false);
    ZcodeKeepAliveController.debugAndroidOverride = true;
    ZcodeKeepAliveController.linkedProvider = () => true;

    c.didChangeAppLifecycleState(AppLifecycleState.paused);
    await Future<void>.delayed(Duration.zero);

    expect(c.debugForegroundCalls, isNot(contains('start')));
  });

  test('链路不活（未连接）且注册表空 → paused 不启动', () async {
    await c.initialize();
    await c.setEnabled(true);
    ZcodeKeepAliveController.debugAndroidOverride = true;
    ZcodeKeepAliveController.linkedProvider = () => false;

    c.didChangeAppLifecycleState(AppLifecycleState.paused);
    await Future<void>.delayed(Duration.zero);

    expect(c.debugForegroundCalls, isNot(contains('start')));
  });

  test('resumed → 停止前台服务（前台不占常驻通知）', () async {
    await c.initialize();
    await c.setEnabled(true);
    ZcodeKeepAliveController.debugAndroidOverride = true;
    ZcodeKeepAliveController.linkedProvider = () => true;

    c.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);

    expect(c.debugForegroundCalls, contains('stop'));
  });
}
