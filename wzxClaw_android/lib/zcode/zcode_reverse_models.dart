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

  const PermissionRequest({
    required this.toolCallId,
    required this.toolName,
    required this.input,
  });
}

/// AskUser 反向请求的 UI 模型。
class AskUserQuestion {
  final String questionId;
  final String question;
  final List<Map<String, String>> options; // [{label, description}]
  final bool multiSelect;

  const AskUserQuestion({
    required this.questionId,
    required this.question,
    required this.options,
    this.multiSelect = false,
  });
}
