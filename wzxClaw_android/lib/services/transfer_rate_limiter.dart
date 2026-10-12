// 传输限速器：文件分块上传/下载共用的客户端背压（架构审查 P2-5）。
//
// 背景（2026-09-19 本地复现）：relay 对每个发送连接限 10s/16MiB，超额
// 直接断连（DATA_RATE_LIMITED）；256KiB 块 base64 后 ~349KiB，纯串行
// await 不保证低于限额——12MiB 下载在第 48 块触发断连并打断该节点的
// 聊天/权限链路。传输必须给交互控制流留余量。
//
// 契约：客户端主动限到 budgetBytes/window（默认 10MiB/10s，留 37.5%
// 余量）；超额时等待到窗口重置——等待是可恢复的背压，不惩罚连接。
// 真实速率受块往返时间约束，该器只兜底「往返过快」的场景。

/// 字节配额限速器（滑动定长窗口）
class TransferRateLimiter {
  TransferRateLimiter({
    this.budgetBytes = 10 * 1024 * 1024,
    this.window = const Duration(seconds: 10),
  });

  /// 窗口内允许的最大字节数
  final int budgetBytes;

  /// 配额窗口
  final Duration window;

  DateTime _windowStart = DateTime.now();
  int _windowBytes = 0;

  /// 记账 bytes 字节；超出窗口配额时等待到窗口重置。必须每个块调用
  ///（含上传与下载），调用方串行 await 即可。
  Future<void> acquire(int bytes) async {
    final now = DateTime.now();
    final elapsed = now.difference(_windowStart);
    if (elapsed >= window) {
      _windowStart = now;
      _windowBytes = 0;
    }
    _windowBytes += bytes;
    if (_windowBytes <= budgetBytes) return;
    final remainMs = window.inMilliseconds - elapsed.inMilliseconds;
    if (remainMs > 0) {
      await Future<void>.delayed(Duration(milliseconds: remainMs));
    }
    _windowStart = DateTime.now();
    _windowBytes = bytes;
  }
}
