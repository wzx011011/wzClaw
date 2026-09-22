import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'file_download_task.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import '../models/file_types.dart';
import '../zcode/zcode_relay_client.dart';
import 'connection_manager.dart';
import 'transfer_rate_limiter.dart';

/// 下载任务生命周期：
/// awaitingChoice（begin 完成，等用户选预览/直接下载）
/// → pulling（分块拉取中，可取消）
/// → previewing（已调系统查看器预览，等「保存/放弃」）
/// → saved / failed / cancelled（终态）。
/// 文件下载服务：节点工作区文件 → companion x/file/download/* 分块拉取
/// → 应用缓存临时文件 → 系统查看器预览 / MediaStore 存入下载文件夹。
/// 协议契约见 relay/zcode/APP-SERVER.md「文件下载（x/file/download*）」。
class FileDownloadService {
  /// 下载分块客户端限速（审查 P2-5）：relay 硬限 10s/16MiB 超额断连，
  /// 主动限到 10MiB/10s 给交互控制流留余量
  static final TransferRateLimiter _rateLimiter = TransferRateLimiter();

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
  /// [workspacePath] 为消息所属会话的工作区（评审 #19）：下载边界跟随
  /// 会话工作区而非 companion 启动目录；null/空 = 兼容缺省（节点回退 cwd）。
  /// 成功返回完整任务；失败返回 phase=failed 任务（无 downloadId，UI 只
  /// 用 error 文案提示，不进确认面板）。不抛异常。
  static Future<FileDownloadTask> begin(
    String nodePath, {
    String? workspacePath,
  }) async {
    // 顺手清理历史残留（>24h 的临时文件；预览后未归位的兜底）
    unawaited(_sweepStaleTemp());
    try {
      final b = await _request('x/file/download/begin', {
        'path': nodePath,
        if (workspacePath != null && workspacePath.isNotEmpty)
          'workspacePath': workspacePath,
      });
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
    // 只允许从待确认态进入拉取：已在拉取/预览中的重复触发一律忽略
    // （确认面板可重复弹出，双击不得叠加拉取）
    if (task.phase != FileDownloadPhase.awaitingChoice) return;
    task.phase = FileDownloadPhase.pulling;
    ping();
    // 整条拉取流绑定开始时的连接（审查 P1-2）：中途切节点绝不把后续分块
    // 发往新节点——代次漂移即抛错终止，走统一清理。
    final bound = debugRequester != null
        ? null
        : ConnectionManager.instance.boundRequester();
    Future<dynamic> req(String method, [Map<String, dynamic>? params]) =>
        bound != null ? bound(method, params) : _request(method, params);
    try {
      final root = await _tempRoot();
      final tempPath =
          '${root.path}${Platform.pathSeparator}${DateTime.now().millisecondsSinceEpoch}-${task.name}';
      final sink = File(tempPath);
      // 先登记再拉：拉取中取消时 cancel() 才能清到这个临时文件
      task.tempPath = tempPath;
      var offset = 0;
      var guard = 0;
      var emptyStreak = 0; // 连续零进展块计数（提前 EOF 检测）
      while (true) {
        guard += 1;
        if (guard > 100000) throw StateError('分块循环未按预期终止');
        final r = await req('x/file/download/chunk', {
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
          await _abort(task, bound: bound);
          return;
        }
        final bytes = base64Decode(data);
        if (offset + bytes.length != received.toInt()) {
          throw StateError('chunk received 与数据长度不符');
        }
        if (bytes.isEmpty) {
          // 提前 EOF 缺口（审查 P2-5）：源文件被截短后服务端反复返回空块
          // 且 eof 永不置位——零进展立即终止，不得循环到上限或触发限流
          emptyStreak++;
          if (emptyStreak >= 2) {
            throw StateError('源文件提前结束（已收 $offset/${task.size} 字节）');
          }
        } else {
          emptyStreak = 0;
        }
        await _rateLimiter.acquire(bytes.length);
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
        // 预览调起期间用户可能已取消：复核后才转 previewing，
        // 绝不把 cancelled 覆盖成 previewing
        if (task.phase == FileDownloadPhase.pulling) {
          task.phase = FileDownloadPhase.previewing;
        }
      } else if (task.phase == FileDownloadPhase.pulling) {
        // 收满与保存之间同样有取消窗口：仍处 pulling 才保存
        await _save(task);
      }
    } catch (e) {
      await _cleanupTemp(task);
      await _abort(task, bound: bound);
      // 用户已取消（终态 cancelled）：归 cancel 所有，不覆盖成 failed
      if (task.phase == FileDownloadPhase.pulling) {
        task.phase = FileDownloadPhase.failed;
        task.error = _friendly(e);
      }
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

  /// 拉取中取消：先同步置终态（评审 #13）——在途 chunk 返回时的写入前
  /// 检查立即生效，最后一个 chunk 不会再落盘/触发保存；随后异步清理
  /// 临时文件并通知节点焚会话。此前先 await 清理再置状态，清理窗口内
  /// 返回的末块会把已取消的任务继续拉完甚至保存。
  static Future<void> cancel(
    FileDownloadTask task, {
    void Function(FileDownloadTask)? onChanged,
  }) async {
    if (task.phase != FileDownloadPhase.pulling) return;
    task.phase = FileDownloadPhase.cancelled;
    onChanged?.call(task);
    await _cleanupTemp(task);
    await _abort(task);
  }

  /// 本地生成的文件落 MediaStore（表格 CSV 等导出场景；复用下载通道的
  /// save 桥）。返回保存位置 uri；失败抛错（不做假成功）。
  static Future<String> saveGeneratedFile({
    required String name,
    required String mime,
    required List<int> bytes,
  }) async {
    final root = await _tempRoot();
    final path =
        '${root.path}${Platform.pathSeparator}${DateTime.now().millisecondsSinceEpoch}-$name';
    await File(path).writeAsBytes(bytes, flush: true);
    try {
      final res = await _bridge('save', {'name': name, 'mime': mime, 'srcPath': path});
      if (res == null || res['ok'] == false) {
        throw StateError('保存失败（${res?['reason'] ?? 'unavailable'}）');
      }
      final uri = res['uri'];
      if (uri is! String || uri.isEmpty) {
        throw StateError('保存失败（原生层未返回保存位置）');
      }
      return uri;
    } finally {
      // MediaStore 已复制内容：临时文件即焚
      try { await File(path).delete(); } catch (_) {}
    }
  }

  static Future<void> _openViewer(FileDownloadTask task) async {
    final res = await _bridge('preview', {
      'path': task.tempPath,
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
      'srcPath': task.tempPath,
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

  static Future<void> _abort(
    FileDownloadTask task, {
    Future<dynamic> Function(String, [Map<String, dynamic>?])? bound,
  }) async {
    final id = task.downloadId;
    if (id == null) return;
    try {
      final req = bound ?? _request;
      await req('x/file/download/abort', {'downloadId': id});
    } catch (e) {
      debugPrint('[file-download] abort 失败（30 分钟过期兜底）: $e');
    }
  }

  static Future<void> _cleanupTemp(FileDownloadTask task) async {
    final p = task.tempPath;
    if (p == null) return;
    try {
      await File(p).delete();
    } catch (_) {
      // 24h 扫尾兜底，不掩盖主流程错误
    }
    task.tempPath = null;
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
