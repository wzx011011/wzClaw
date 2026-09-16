// ============================================================
// zcode_keepalive_controller — 把 Android 前台服务接到 zcode 连接状态
//
// 旧 ConnectionManager 退役后，后台保活由本控制器接管：
// - paused 且（Android && 开关开 && 已配对且连接未彻底 idle）→ 启动前台
//   服务。relay 客户端自带 pair_status_query 保活 ping 与指数退避重连
//   （zcode_relay_client），无需在此另起心跳。
// - 回前台 → 停前台服务；若已配对但未 matched → 立即重连
//   （对应 ConnectionManager._resumeCheck 的快速重连语义）。
// 设置项沿用原 pref key（background_keepalive_enabled），老用户开关保留。
// ============================================================

import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/android_foreground_keepalive.dart';
import 'zcode_chat_store.dart';
import 'zcode_desktop_registry.dart';

class ZcodeKeepAliveController with WidgetsBindingObserver {
  ZcodeKeepAliveController._();

  static final ZcodeKeepAliveController instance = ZcodeKeepAliveController._();

  static const _prefKey = 'background_keepalive_enabled';

  bool _enabled = false;
  bool _initialized = false;

  /// 链路存活判定（生产由 ConnectionManager 注入；未注入时视为不活——
  /// v3 注册表接线后其 store 也可独立满足条件）。
  /// 曾因数据源只查「有意未接线」的 registry 导致 _shouldRun 恒 false、
  /// 前台服务在产线一次都启动不了（假开关）——判定必须是双数据源。
  static bool Function()? linkedProvider;

  /// 仅测试使用：平台覆盖（测试环境 Platform.isAndroid 恒 false）
  @visibleForTesting
  static bool debugAndroidOverride = false;

  /// 仅测试使用：前台服务调用记录（'start' / 'stop'）
  @visibleForTesting
  final List<String> debugForegroundCalls = <String>[];

  /// 全部桌面 store（多桌面：每个桌面独立连接与状态）
  Iterable<ZcodeChatStore> get _stores => ZcodeDesktopRegistry.instance.stores;

  bool get _isAndroid => debugAndroidOverride || Platform.isAndroid;

  bool get _linked => linkedProvider?.call() ?? false;

  /// 是否应运行前台服务：Android + 开关开 +（活跃链路存活 或 任一 v3 桌面已配对）
  bool get _shouldRun {
    if (!_isAndroid || !_enabled) return false;
    if (_linked) return true;
    return _stores.any(
      (s) => s.pairing != null && s.connState != ZcodeConnState.idle,
    );
  }

  Future<void> _fgStart() async {
    debugForegroundCalls.add('start');
    await AndroidForegroundKeepAlive.instance.start();
  }

  Future<void> _fgStop() async {
    debugForegroundCalls.add('stop');
    await AndroidForegroundKeepAlive.instance.stop();
  }

  /// 读 pref 并注册生命周期观察（幂等；App 启动时调用一次）
  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    WidgetsBinding.instance.addObserver(this);
    try {
      final prefs = await SharedPreferences.getInstance();
      _enabled = prefs.getBool(_prefKey) ?? false;
    } catch (_) {
      _enabled = false;
    }
  }

  /// 设置开关（设置页用）；关闭时立即停掉前台服务
  Future<void> setEnabled(bool enabled) async {
    _enabled = enabled;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefKey, enabled);
    } catch (_) {}
    if (!enabled) {
      await _fgStop();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
        if (_shouldRun) {
          unawaited(_fgStart());
        }
        break;
      case AppLifecycleState.resumed:
        unawaited(_fgStop());
        // 任一桌面已配对但连接不健康 → 立即重连（不等退避计时器）
        for (final store in _stores) {
          if (store.pairing != null &&
              store.connState != ZcodeConnState.matched) {
            unawaited(store.reconnect());
          }
        }
        break;
      default:
        break;
    }
  }
}
