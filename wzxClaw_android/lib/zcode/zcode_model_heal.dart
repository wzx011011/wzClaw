// ============================================================
// zcode_model_heal — 「模型已不可用」发送自愈（共享尾段）
//
// 历史/桌面端改配的会话可能钉在一个已下线的模型上：session/send 被
// 拒（字符串 result 或错误帧 -32031 / ZCODE_RUNTIME_MODEL_UNAVAILABLE）。
// ZcodeChatStore.sendMessage 的自愈共用本模块时序。
//
// 时序出处：relay/zcode/probe-modelheal4.js 真链路验证
// （RESULT: healed-by-setmodel-rematerialize）：
//   setModel → close → resume → send
// - setModel model 为对象 {providerId, modelId, options?{reasoningLevel}}；
//   imported 模型必填 reasoningLevel（0.16.9 实测，缺失即 -32603）
// - close + resume 重新物化运行时是关键：只 setModel 后重发仍 -32031
// 可用模型的解析（缓存）由调用方完成。
// （zcodeSendWithHeal / zcodeHealWithAvailableModel 已删——换芯桥
// ConnectionManager.command:send 随 R3 退役后零调用方。）
// ============================================================

/// app-server 请求函数形状（ZcodeRelayClient.request 的签名子集）
typedef ZcodeRequestFn = Future<dynamic> Function(
  String method, [
  Map<String, dynamic>? params,
]);

/// session/send 字符串 result 业务拒绝的实测唯一形态（APP-SERVER.md
/// 「session/send 字符串 result 业务拒绝」：新进程 resume 老会话、其存储
/// 模型解析失败时出现）。全文等值匹配是进自愈链的唯一判据——宽松的
/// contains('模型') 会把其它含「模型」字样的字符串拒绝误进自愈链
/// （2026-09-24 协议嗅探清理；误分类方向安全：未知拒绝落原文透传）。
const String kModelUnavailableRejection =
    '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。';

/// setModel + 重新物化 + 重发一次。
///
/// [reasoningLevel]：imported 模型（Codex/DeepSeek 导入）setModel 必填
/// 推理档位（实测契约，缺失即 -32603）；无档位模型传 null、不带 options。
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
  String? reasoningLevel,
}) async {
  try {
    await request('session/setModel', {
      'sessionId': sessionId,
      'model': {
        'providerId': providerId,
        'modelId': modelId,
        if (reasoningLevel != null && reasoningLevel.isNotEmpty)
          'options': {'reasoningLevel': reasoningLevel},
      },
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
