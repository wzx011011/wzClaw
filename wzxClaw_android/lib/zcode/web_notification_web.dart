// web_notification_web — 浏览器通知通道（web 平台编译目标）
//
// web 上无 flutter_local_notifications 插件：后台标签页里回合完成与
// 权限/AskUser 挂起没有任何被动观测通道（uiNotices 是转瞬即逝的
// SnackBar）——这里接浏览器 Notification API 作为最小兜底
// （审查 f-web-platform-degrade-4）。授权失败静默：通知是尽力而为
// 能力，回前台后 UI 状态本身可见。

import 'dart:async';
import 'dart:html' as html;

/// 弹浏览器通知。返回是否成功送达（未授权/不支持/抛错均 false）。
Future<bool> showWebNotification({
  required String title,
  required String body,
}) async {
  if (!html.Notification.supported) return false;
  // 权限未决时先请求；用户已拒绝（denied）则不再骚扰
  if (html.Notification.permission == 'default') {
    try {
      await html.Notification.requestPermission();
    } catch (_) {
      return false;
    }
  }
  if (html.Notification.permission != 'granted') return false;
  try {
    html.Notification(title, body: body);
    return true;
  } catch (_) {
    return false;
  }
}
