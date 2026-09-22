// web 桩：无文件系统/MediaStore，显式「暂不支持」（设计原则 2）
import 'file_download_task.dart';

class FileDownloadService {
  FileDownloadService._();

  /// 测试注入口（web 桩保持同名同签名）
  static Future<dynamic> Function(
    String method, [
    Map<String, dynamic>? params,
  ])? debugRequester;
  static Future<Map<String, dynamic>?> Function(
    String method,
    Map<String, dynamic> args,
  )? debugBridge;
  static Future<dynamic> Function()? debugTempDir;

  static Future<FileDownloadTask> begin(
    String nodePath, {
    String? workspacePath,
  }) async {
    return FileDownloadTask(
      nodePath: nodePath,
      name: _fallbackName(nodePath),
      size: 0,
    )
      ..phase = FileDownloadPhase.failed
      ..error = 'web 端暂不支持下载到设备';
  }

  static Future<void> pull(
    FileDownloadTask task, {
    required bool forPreview,
    void Function(FileDownloadTask)? onChanged,
  }) async {
    task.phase = FileDownloadPhase.failed;
    task.error = 'web 端暂不支持下载到设备';
    onChanged?.call(task);
  }

  static Future<void> saveAfterPreview(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    task.phase = FileDownloadPhase.failed;
    task.error = 'web 端暂不支持保存到下载目录';
    onChanged?.call(task);
  }

  static Future<void> discard(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    task.phase = FileDownloadPhase.cancelled;
    onChanged?.call(task);
  }

  static Future<void> cancel(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    task.phase = FileDownloadPhase.cancelled;
    onChanged?.call(task);
  }

  static Future<String> saveGeneratedFile({
    required String name,
    required String mime,
    required List<int> bytes,
  }) async {
    throw UnsupportedError('web 端暂不支持保存到设备');
  }

  static String _fallbackName(String nodePath) =>
      nodePath.replaceAll(r'', '/').split('/').where((e) => e.isNotEmpty).last;
}
