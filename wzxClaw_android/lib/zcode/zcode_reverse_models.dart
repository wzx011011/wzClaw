// ============================================================
// zcode_reverse_models — 反向请求的 UI 模型
//
// 形状以官方开源源码为准（third_party/zcode：
// packages/shared/src/zcode-protocol-legacy-types.ts 的
// zcodePermissionRequestParamsSchema / zcodeUserInputRequestParamsSchema），
// 不再使用探测期的猜测形状。
// 两个模型被 zcode_chat_store（解析/应答）与权限卡/问题卡 widgets 共用。
// ============================================================

/// 官方权限选项（params.options[] 元素）。
/// 应答时**原样回放**所选 option 的 response（服务端自产 schema，
/// 拒绝方在服务端兜底解释，客户端不得自行构造）。
class PermissionOption {
  final String optionId;
  final String kind; // allow_once / allow_project / deny / …

  /// 选项显示名（官方 UI 直接展示）
  final String name;

  /// 选项说明（官方 UI 的次行文案）
  final String? description;

  /// 服务端给出的应答原文——批准/拒绝时原样回放
  final Map<String, dynamic> response;

  const PermissionOption({
    required this.optionId,
    required this.kind,
    required this.name,
    required this.response,
    this.description,
  });
}

/// 权限确认反向请求（interaction/requestPermission）的 UI 模型。
class PermissionRequest {
  /// 官方业务身份：同交互的重宣告共用同一 requestId（去重/应答键）。
  final String requestId;
  final String toolCallId;
  final String toolName;

  /// 请求说明（官方 reason，如 "High risk tools require explicit approval"）
  final String? reason;

  /// 风险级（low/medium/high/critical）
  final String? riskLevel;

  final Map<String, dynamic> input;
  final List<PermissionOption> options;

  /// 请求所属会话（协议 params.sessionId）。归属用：待处理请求不再随视口
  /// 切换被拒绝，条上标注来源会话供用户判断。
  final String? sessionId;

  const PermissionRequest({
    required this.requestId,
    required this.toolCallId,
    required this.toolName,
    required this.input,
    required this.options,
    this.reason,
    this.riskLevel,
    this.sessionId,
  });
}

/// 官方 AskUser 选项（questions[].options[] 元素）。
/// value 是提交进 answers 的答案；label 是显示名；二者不可混用。
class AskUserOption {
  final String value;
  final String label;
  final String? description;

  const AskUserOption({
    required this.value,
    required this.label,
    this.description,
  });
}

/// 官方 AskUser 单题（questions[] 元素）。
class AskUserQuestionItem {
  /// 题目原文——官方 content.answers 以题目原文为 key
  final String question;

  /// 题目短标（官方 header，列表/弹层标题用）
  final String header;

  final List<AskUserOption> options;

  /// 多选时答案 = 各选中 value 以 ", " 连接（官方归一化语义）
  final bool multiSelect;

  const AskUserQuestionItem({
    required this.question,
    required this.header,
    required this.options,
    this.multiSelect = false,
  });
}

/// AskUser 反向请求（interaction/requestUserInput）的 UI 模型。
class AskUserQuestion {
  /// 官方业务身份：同交互的重宣告共用同一 requestId（去重/应答键）。
  final String requestId;

  /// 无 questions 时的自由文本提示（官方 prompt 模式）
  final String? prompt;

  /// 题目列表（官方支持一次多题，按序展示、一次提交）
  final List<AskUserQuestionItem> questions;

  /// 请求所属会话（同 PermissionRequest.sessionId，归属用）
  final String? sessionId;

  const AskUserQuestion({
    required this.requestId,
    required this.questions,
    this.prompt,
    this.sessionId,
  });
}
