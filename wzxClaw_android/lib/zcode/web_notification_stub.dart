// web_notification_stub — 浏览器通知通道 stub（非 web 平台编译目标）
//
// 条件 import 见 zcode_notifier.dart。返回 false = 通道不可用/未授权；
// 通知是尽力而为能力，失败静默不阻断主流程。

Future<bool> showWebNotification({
  required String title,
  required String body,
}) async =>
    false;
