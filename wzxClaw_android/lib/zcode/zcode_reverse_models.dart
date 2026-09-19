// ============================================================
// zcode_reverse_models — 反向请求的 UI 模型
//
// PermissionRequest / AskUserQuestion 原定义在 services/chat_store.dart，
// 旧 UI 换芯到 zcode 后 chat_store 将退役，模型随 zcode 层安家。
// 两个类被 zcode_chat_store（解析/应答）与权限卡/问题卡 widgets 共用。
// ============================================================

/// 权限确认反向请求（interaction/requestPermission）的 UI 模型。
class PermissionRequest {
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> input;

  /// 请求所属会话（协议 params.sessionId，实测存在）。归属用：
  /// 待处理请求不再随视口切换被拒绝，条上标注来源会话供用户判断。
  final String? sessionId;

  const PermissionRequest({
    required this.toolCallId,
    required this.toolName,
    required this.input,
    this.sessionId,
  });
}

/// AskUser 反向请求的 UI 模型。
class AskUserQuestion {
  final String questionId;
  final String question;
  final List<Map<String, String>> options; // [{label, description}]
  final bool multiSelect;

  /// 请求所属会话（同 PermissionRequest.sessionId，归属用）
  final String? sessionId;

  const AskUserQuestion({
    required this.questionId,
    required this.question,
    required this.options,
    this.multiSelect = false,
    this.sessionId,
  });
}
