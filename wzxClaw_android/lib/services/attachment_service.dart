import 'dart:convert';
import 'dart:typed_data';

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

  /// 选图（相册/拍照）并上传；用户取消返回 null
  static Future<AttachmentUpload?> pickAndUpload({
    required ImageSource source,
    void Function(AttachmentUpload)? onChanged,
  }) async {
    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(source: source, imageQuality: 90);
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
    return upload(
      AttachmentUpload(name: picked.name, size: bytes.length),
      bytes,
      onChanged: onChanged,
    );
  }

  /// 分块上传字节流到节点工作区（begin → chunk* → commit）
  static Future<AttachmentUpload> upload(
    AttachmentUpload up,
    Uint8List bytes, {
    void Function(AttachmentUpload)? onChanged,
  }) async {
    void ping() => onChanged?.call(up);
    try {
      final b = await ConnectionManager.instance
          .zcodeRequest('x/file/begin', {'name': up.name, 'size': bytes.length});
      final uploadId =
          b is Map && b['uploadId'] is String ? b['uploadId'] as String : null;
      if (uploadId == null || uploadId.isEmpty) {
        throw 'x/file/begin 未返回 uploadId';
      }
      for (var off = 0; off < bytes.length; off += _chunkBytes) {
        final end =
            off + _chunkBytes > bytes.length ? bytes.length : off + _chunkBytes;
        final r = await ConnectionManager.instance.zcodeRequest('x/file/chunk',
            {'uploadId': uploadId, 'data': base64Encode(bytes.sublist(off, end))});
        if (r is Map && r['received'] is num) {
          up.received = (r['received'] as num).toInt();
        }
        ping();
      }
      final c = await ConnectionManager.instance
          .zcodeRequest('x/file/commit', {'uploadId': uploadId});
      if (c is Map && c['filePath'] is String) {
        up.nodePath = c['filePath'] as String;
      } else {
        up.error = 'commit 未返回节点路径';
      }
    } catch (e) {
      up.error = '上传失败: $e';
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
