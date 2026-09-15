// ============================================================
// zcode_model_heal — 「模型已不可用」发送自愈（共享尾段）
//
// 历史/桌面端改配的会话可能钉在一个已下线的模型上：session/send 被
// 拒（字符串 result 或错误帧 -32031 / ZCODE_RUNTIME_MODEL_UNAVAILABLE）。
// 两条发送路径（旧 UI 换芯桥 ConnectionManager.command:send 与
// ZcodeChatStore.sendMessage）共用本模块的自愈时序，避免两份实现漂移。
//
// 时序出处：relay/zcode/probe-modelheal4.js 真链路验证
// （RESULT: healed-by-setmodel-rematerialize）：
//   setModel → close → resume → send
// - setModel 只接受 {providerId, modelId} 对象，字符串 'p/m' 被 -32602 拒
// - close + resume 重新物化运行时是关键：只 setModel 后重发仍 -32031
// 可用模型的解析（缓存 vs resume 现取）由调用方各自完成。
// ============================================================

/// app-server 请求函数形状（ZcodeRelayClient.request 的签名子集）
typedef ZcodeRequestFn = Future<dynamic> Function(
  String method, [
  Map<String, dynamic>? params,
]);

/// setModel + 重新物化 + 重发一次。
///
/// 返回 null = 重发已被接受（订阅由调用方按各自链路补发）；
/// 非 null = 给用户看的错误文案（已含原始 [reason]）。
Future<String?> zcodeSetModelResend({
  required ZcodeRequestFn request,
  required String sessionId,
  required String content,
  required String providerId,
  required String modelId,
  required String reason,
}) async {
  try {
    await request('session/setModel', {
      'sessionId': sessionId,
      'model': {'providerId': providerId, 'modelId': modelId},
    });
    await request('session/close', {'sessionId': sessionId});
    await request('session/resume', {'sessionId': sessionId});
    final retry = await request('session/send', {
      'sessionId': sessionId,
      'content': content,
    });
    if (retry is String) {
      return '发送失败：$retry。已自动切换可用模型仍被拒，请新建会话继续。';
    }
    return null;
  } catch (e) {
    // 自愈链任何一步失败 → 带上真实失败原因。吞掉真实错误会造成误导：
    // 网络断开/setModel -32602 会被误报成「历史模型已下线」
    return '发送失败：$reason。自动切换可用模型未成功（$e），请新建会话继续。';
  }
}
