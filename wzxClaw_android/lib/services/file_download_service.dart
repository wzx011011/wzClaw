import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import '../models/file_types.dart';
import '../zcode/zcode_relay_client.dart';
import 'connection_manager.dart';

/// 下载任务生命周期：
/// awaitingChoice（begin 完成，等用户选预览/直接下载）
/// → pulling（分块拉取中，可取消）
/// → previewing（已调系统查看器预览，等「保存/放弃」）
/// → saved / failed / cancelled（终态）。
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

  String? _tempPath;

  double get progress => size == 0 ? 0 : (received / size).clamp(0.0, 1.0);
  bool get isFinished =>
      phase == FileDownloadPhase.saved ||
      phase == FileDownloadPhase.failed ||
      phase == FileDownloadPhase.cancelled;
}

/// 文件下载服务：节点工作区文件 → companion x/file/download/* 分块拉取
/// → 应用缓存临时文件 → 系统查看器预览 / MediaStore 存入下载文件夹。
/// 协议契约见 relay/zcode/APP-SERVER.md「文件下载（x/file/download*）」。
class FileDownloadService {
  @visibleForTesting
  static Future<dynamic> Function(
    String method, [
    Map<String, dynamic>? params,
  ])? debugRequester;

  /// 原生桥（preview/save），测试注入；null = 真机 MethodChannel
  @visibleForTesting
  static Future<Map<String, dynamic>?> Function(
    String method,
    Map<String, dynamic> args,
  )? debugBridge;

  /// 缓存根目录，测试注入；null = path_provider 真实临时目录
  @visibleForTesting
  static Future<Directory> Function()? debugTempDir;

  static Future<dynamic> _request(
    String method, [
    Map<String, dynamic>? params,
  ]) {
    final requester = debugRequester;
    return requester != null
        ? requester(method, params)
        : ConnectionManager.instance.zcodeRequest(method, params);
  }

  static Future<Map<String, dynamic>?> _bridge(
    String method,
    Map<String, dynamic> args,
  ) async {
    final bridge = debugBridge;
    if (bridge != null) return bridge(method, args);
    const channel = MethodChannel('wzxclaw_android/downloads');
    try {
      return await channel.invokeMapMethod<String, dynamic>(method, args);
    } on PlatformException catch (e) {
      return {'ok': false, 'reason': e.code, 'message': e.message ?? ''};
    } on MissingPluginException {
      return {'ok': false, 'reason': 'unavailable'};
    }
  }

  static Future<Directory> _tempRoot() async {
    final inject = debugTempDir;
    final base =
        inject != null ? await inject() : await getTemporaryDirectory();
    final dir = Directory('${base.path}${Platform.pathSeparator}wzxclaw-dl');
    await dir.create(recursive: true);
    return dir;
  }

  /// begin：校验并登记下载（工作区外/不存在在此步报错）。
  /// 成功返回完整任务；失败返回 phase=failed 任务（无 downloadId，UI 只
  /// 用 error 文案提示，不进确认面板）。不抛异常。
  static Future<FileDownloadTask> begin(String nodePath) async {
    // 顺手清理历史残留（>24h 的临时文件；预览后未归位的兜底）
    unawaited(_sweepStaleTemp());
    try {
      final b = await _request('x/file/download/begin', {'path': nodePath});
      if (b is! Map) throw StateError('begin 应答形状非法');
      final id = b['downloadId'];
      if (id is! String || id.isEmpty) {
        throw StateError('x/file/download/begin 未返回 downloadId');
      }
      if (b['size'] is! num) throw StateError('x/file/download/begin 未返回 size');
      final serverName = b['name'];
      return FileDownloadTask(
        nodePath: nodePath,
        name: serverName is String && serverName.isNotEmpty
            ? serverName
            : _fallbackName(nodePath),
        size: (b['size'] as num).toInt(),
        downloadId: id,
      );
    } catch (e) {
      return FileDownloadTask(
        nodePath: nodePath,
        name: _fallbackName(nodePath),
        size: 0,
      )
        ..phase = FileDownloadPhase.failed
        ..error = _friendly(e);
    }
  }

  static String _fallbackName(String nodePath) => nodePath
      .replaceAll('\\', '/')
      .split('/')
      .where((s) => s.isNotEmpty)
      .lastOrNull ?? 'file';

  /// 分块拉取到缓存临时文件。forPreview=true：拉完调系统查看器并转
  /// previewing；false：拉完直接写 MediaStore 转 saved。
  static Future<void> pull(
    FileDownloadTask task, {
    required bool forPreview,
    void Function(FileDownloadTask)? onChanged,
  }) async {
    void ping() => onChanged?.call(task);
    if (task.downloadId == null) {
      task.phase = FileDownloadPhase.failed;
      task.error = '下载未登记（无 downloadId）';
      ping();
      return;
    }
    task.phase = FileDownloadPhase.pulling;
    ping();
    try {
      final root = await _tempRoot();
      final tempPath =
          '${root.path}${Platform.pathSeparator}${DateTime.now().millisecondsSinceEpoch}-${task.name}';
      final sink = File(tempPath);
      // 先登记再拉：拉取中取消时 cancel() 才能清到这个临时文件
      task._tempPath = tempPath;
      var offset = 0;
      var guard = 0;
      while (true) {
        guard += 1;
        if (guard > 100000) throw StateError('分块循环未按预期终止');
        final r = await _request('x/file/download/chunk', {
          'downloadId': task.downloadId,
          'offset': offset,
        });
        if (r is! Map) throw StateError('chunk 应答形状非法');
        final data = r['data'];
        final received = r['received'];
        if (data is! String || received is! num) {
          throw StateError('x/file/download/chunk 应答缺 data/received');
        }
        // 用户在在途 chunk 期间取消：不落盘、立即停住（终态由 cancel() 定）。
        // 检查必须在写入前——append 模式会把已删的临时文件再建出来。
        if (task.phase != FileDownloadPhase.pulling) {
          await _cleanupTemp(task);
          await _abort(task);
          return;
        }
        final bytes = base64Decode(data);
        if (offset + bytes.length != received.toInt()) {
          throw StateError('chunk received 与数据长度不符');
        }
        await sink.writeAsBytes(bytes, mode: FileMode.append);
        offset = received.toInt();
        task.received = offset;
        ping();
        if (r['eof'] == true) break;
        if (task.size > 0 && offset >= task.size) {
          throw StateError('已收满但未收到 eof');
        }
      }
      if (offset != task.size) {
        throw StateError('下载不完整（$offset/${task.size} 字节）');
      }
      if (forPreview) {
        await _openViewer(task);
        task.phase = FileDownloadPhase.previewing;
      } else {
        await _save(task);
      }
    } catch (e) {
      await _cleanupTemp(task);
      await _abort(task);
      task.phase = FileDownloadPhase.failed;
      task.error = _friendly(e);
    }
    ping();
  }

  /// 预览后的「保存到下载」
  static Future<void> saveAfterPreview(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    if (task.phase != FileDownloadPhase.previewing) return;
    try {
      await _save(task);
    } catch (e) {
      await _cleanupTemp(task);
      task.phase = FileDownloadPhase.failed;
      task.error = _friendly(e);
    }
    onChanged?.call(task);
  }

  /// 预览后的「放弃」：删临时文件（会话在 eof 时已焚，abort 幂等兜底）
  static Future<void> discard(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    if (task.phase != FileDownloadPhase.previewing) return;
    await _cleanupTemp(task);
    task.phase = FileDownloadPhase.cancelled;
    onChanged?.call(task);
  }

  /// 拉取中取消
  static Future<void> cancel(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    if (task.phase != FileDownloadPhase.pulling) return;
    await _cleanupTemp(task);
    await _abort(task);
    task.phase = FileDownloadPhase.cancelled;
    onChanged?.call(task);
  }

  static Future<void> _openViewer(FileDownloadTask task) async {
    final res = await _bridge('preview', {
      'path': task._tempPath,
      'mime': mimeForName(task.name),
    });
    // 无可处理应用也照常转 previewing：notice（信息性，非错误）提示后
    // 仍可保存/放弃——预览不可用不代表文件不可用
    if (res == null || res['ok'] != true) {
      task.notice = '手机上没有可预览此类型的应用，可直接保存或放弃';
    }
  }

  static Future<void> _save(FileDownloadTask task) async {
    final res = await _bridge('save', {
      'name': task.name,
      'mime': mimeForName(task.name),
      'srcPath': task._tempPath,
    });
    if (res == null || res['ok'] == false) {
      throw StateError('保存失败（${res?['reason'] ?? 'unavailable'}）');
    }
    final uri = res['uri'];
    if (uri is! String || uri.isEmpty) {
      throw StateError('保存失败（原生层未返回保存位置）');
    }
    task.phase = FileDownloadPhase.saved;
    await _cleanupTemp(task);
  }

  static Future<void> _abort(FileDownloadTask task) async {
    final id = task.downloadId;
    if (id == null) return;
    try {
      await _request('x/file/download/abort', {'downloadId': id});
    } catch (e) {
      debugPrint('[file-download] abort 失败（30 分钟过期兜底）: $e');
    }
  }

  static Future<void> _cleanupTemp(FileDownloadTask task) async {
    final p = task._tempPath;
    if (p == null) return;
    try {
      await File(p).delete();
    } catch (_) {
      // 24h 扫尾兜底，不掩盖主流程错误
    }
    task._tempPath = null;
  }

  static Future<void> _sweepStaleTemp() async {
    try {
      final root = await _tempRoot();
      final cutoff = DateTime.now().subtract(const Duration(hours: 24));
      await for (final entity in root.list()) {
        if (entity is! File) continue;
        final stat = await entity.stat();
        if (stat.modified.isBefore(cutoff)) {
          try {
            await entity.delete();
          } catch (_) {/* 下次再扫 */}
        }
      }
    } catch (e) {
      debugPrint('[file-download] 临时目录清扫失败: $e');
    }
  }

  /// companion 错误码 → 用户可读提示。分类读 error.data.reason
  /// （companion protocol.js 约定），不做 message 文本嗅探；
  /// -32103 缺 reason 时按码兜底归「文件不存在」类。
  static String _friendly(Object e) {
    if (e is ZcodeRequestException) {
      if (e.reason == 'X_OUT_OF_WORKSPACE') return '暂不支持下载工作区外的文件';
      if (e.code == -32103) {
        return '节点上没有这个文件（或下载会话已过期），请重试';
      }
      if (e.code == -32100) return '节点拒绝该下载请求（参数非法）';
      return '下载失败: ${e.message}';
    }
    return '下载失败: $e';
  }
}
