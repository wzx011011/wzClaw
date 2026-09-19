import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';

import 'connection_manager.dart';

/// 待发送附件的上传状态（页面持有列表，字段可变随进度更新）
class AttachmentUpload {
  AttachmentUpload({required this.name, required this.size});

  final String name;
  final int size;

  /// 节点侧落盘绝对路径（commit 成功后非空——消息引用它）
  String? nodePath;
  int received = 0;
  String? error;

  bool get uploading => nodePath == null && error == null;
  bool get done => nodePath != null && error == null;
  double get progress => size == 0 ? 1 : (received / size).clamp(0.0, 1.0);
}

/// 附件上传服务：手机选图 → companion x/file/* 分块上传 → 节点落盘。
/// 消息文本引用节点路径，agent 用 Read 工具读取（图片走视觉管线），
/// 见 APP-SERVER.md「附件入口实测」。
class AttachmentService {
  static const _chunkBytes = 256 * 1024; // base64 后 ~349KB，低于 relay 1MB 帧限

  @visibleForTesting
  static Future<XFile?> Function(ImageSource source)? debugPicker;

  @visibleForTesting
  static Future<dynamic> Function(
    String method, [
    Map<String, dynamic>? params,
  ])? debugRequester;

  static Future<dynamic> _request(
    String method, [
    Map<String, dynamic>? params,
  ]) {
    final requester = debugRequester;
    return requester != null
        ? requester(method, params)
        : ConnectionManager.instance.zcodeRequest(method, params);
  }

  /// 选图（相册/拍照）并上传；用户取消返回 null。
  /// [workspacePath] = 消息所属会话的工作区（评审 #19）：附件落盘跟随
  /// 会话工作区而非 companion 启动目录。
  static Future<AttachmentUpload?> pickAndUpload({
    required ImageSource source,
    void Function(AttachmentUpload)? onCreated,
    void Function(AttachmentUpload)? onChanged,
    String? workspacePath,
  }) async {
    final XFile? picked;
    try {
      final picker = debugPicker;
      picked = picker != null
          ? await picker(source)
          : await ImagePicker().pickImage(source: source, imageQuality: 90);
    } catch (e) {
      return _failed('选择${_sourceName(source)}失败: $e');
    }
    if (picked == null) return null;
    Uint8List bytes;
    try {
      bytes = await picked.readAsBytes();
    } catch (e) {
      return _failed('读取图片失败: $e');
    }
    final uploadRecord =
        AttachmentUpload(name: picked.name, size: bytes.length);
    onCreated?.call(uploadRecord);
    return upload(
      uploadRecord,
      bytes,
      onChanged: onChanged,
      workspacePath: workspacePath,
    );
  }

  /// 分块上传字节流到节点工作区（begin → chunk* → commit）
  static Future<AttachmentUpload> upload(
    AttachmentUpload up,
    Uint8List bytes, {
    void Function(AttachmentUpload)? onChanged,
    String? workspacePath,
  }) async {
    void ping() => onChanged?.call(up);
    String? uploadId;
    try {
      final b = await _request('x/file/begin', {
        'name': up.name,
        'size': bytes.length,
        if (workspacePath != null && workspacePath.isNotEmpty)
          'workspacePath': workspacePath,
      });
      uploadId =
          b is Map && b['uploadId'] is String ? b['uploadId'] as String : null;
      if (uploadId == null || uploadId.isEmpty) {
        throw StateError('x/file/begin 未返回 uploadId');
      }
      for (var off = 0; off < bytes.length; off += _chunkBytes) {
        final end =
            off + _chunkBytes > bytes.length ? bytes.length : off + _chunkBytes;
        final r = await _request('x/file/chunk', {
          'uploadId': uploadId,
          'data': base64Encode(bytes.sublist(off, end)),
        });
        if (r is! Map || r['received'] is! num) {
          throw StateError('x/file/chunk 未返回 received');
        }
        final received = (r['received'] as num).toInt();
        if (received < up.received || received > bytes.length) {
          throw StateError('x/file/chunk 返回非法 received: $received');
        }
        up.received = received;
        ping();
      }
      final c = await _request('x/file/commit', {'uploadId': uploadId});
      final path = c is Map ? c['filePath']?.toString() : null;
      if (path == null || path.trim().isEmpty) {
        throw StateError('x/file/commit 未返回节点路径');
      }
      up.received = bytes.length;
      up.nodePath = path;
    } catch (e) {
      up.error = '上传失败: $e';
      if (uploadId != null) {
        try {
          await _request('x/file/abort', {'uploadId': uploadId});
        } catch (abortError) {
          debugPrint('[attachment] 清理失败的上传 $uploadId: $abortError');
        }
      }
    }
    ping();
    return up;
  }

  static String _sourceName(ImageSource source) =>
      source == ImageSource.camera ? '拍照' : '选图';

  static AttachmentUpload _failed(String msg) {
    final up = AttachmentUpload(name: 'attachment', size: 0);
    up.error = msg;
    return up;
  }
}
