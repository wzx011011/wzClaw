import 'dart:io';

import 'package:flutter/services.dart';

class AndroidForegroundKeepAlive {
  AndroidForegroundKeepAlive._();

  static final AndroidForegroundKeepAlive instance =
      AndroidForegroundKeepAlive._();
  static const MethodChannel _channel =
      MethodChannel('wzxclaw_android/foreground_keepalive');

  bool _running = false;

  Future<void> start() async {
    if (!Platform.isAndroid || _running) return;

    try {
      await _channel.invokeMethod<void>('startForegroundKeepAlive');
      _running = true;
    } catch (_) {
      _running = false;
    }
  }

  Future<void> stop() async {
    if (!Platform.isAndroid) return;

    try {
      await _channel.invokeMethod<void>('stopForegroundKeepAlive');
    } catch (_) {
      // 原生服务未启动时忽略 stop 请求。
    } finally {
      _running = false;
    }
  }
}