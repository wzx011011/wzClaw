// 下载任务数据契约（io/web 共享；web 支持拆分，2026-09-22）
// 下载状态只存内存：消息行会被权威合并原位替换，把状态挂到消息本体
// 必被覆盖；下载是用户显式动作，重复点击重新走确认流程即可。

enum FileDownloadPhase {
  awaitingChoice,
  pulling,
  previewing,
  saved,
  failed,
  cancelled,
}


/// 一个文件的下载任务（页面持有列表，字段可变随进度更新）。
/// 下载状态只存内存：消息行会被权威合并原位替换，把状态挂到消息本体
/// 必被覆盖；下载是用户显式动作，重复点击重新走确认流程即可。
class FileDownloadTask {
  FileDownloadTask({
    required this.nodePath,
    required this.name,
    required this.size,
    this.downloadId,
  });

  /// 节点侧文件绝对路径
  final String nodePath;

  /// 本地文件名（begin 成功后为服务端白名单化名；失败任务为路径末段粗估）
  final String name;

  /// 文件字节数（begin 成功后为服务端真实值；失败任务恒 0）
  final int size;

  /// 协议下载会话 id（begin 成功才有；null = 未登记，不可拉取）
  final String? downloadId;

  FileDownloadPhase phase = FileDownloadPhase.awaitingChoice;
  int received = 0;

  /// 真实错误（failed 态的展示文案）
  String? error;

  /// 信息性提示（如「无可预览应用」），非错误；previewing 态展示
  String? notice;

  /// 临时文件路径（io 平台下载落盘用；web 恒 null）
  String? tempPath;

  double get progress => size == 0 ? 0 : (received / size).clamp(0.0, 1.0);
  bool get isFinished =>
      phase == FileDownloadPhase.saved ||
      phase == FileDownloadPhase.failed ||
      phase == FileDownloadPhase.cancelled;
}

