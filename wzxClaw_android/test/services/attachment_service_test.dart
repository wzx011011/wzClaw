import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/attachment_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    AttachmentService.debugRequester = null;
    AttachmentService.debugPicker = null;
  });

  test('分块上传使用数值进度并提交节点路径', () async {
    final calls = <String>[];
    var received = 0;
    AttachmentService.debugRequester = (method, [params]) async {
      calls.add(method);
      switch (method) {
        case 'x/file/begin':
          expect(params?['size'], 300000);
          return {'uploadId': 'up-1'};
        case 'x/file/chunk':
          received +=
              (params?['data'] as String).length > 300000 ? 262144 : 37856;
          return {'received': received};
        case 'x/file/commit':
          return {'filePath': r'E:\work\.wzxclaw\a.png'};
        default:
          fail('unexpected method $method');
      }
    };
    final upload = AttachmentUpload(name: 'a.png', size: 300000);

    await AttachmentService.upload(upload, Uint8List(300000));

    expect(calls, [
      'x/file/begin',
      'x/file/chunk',
      'x/file/chunk',
      'x/file/commit',
    ]);
    expect(upload.done, isTrue);
    expect(upload.received, 300000);
    expect(upload.progress, 1);
  });

  test('chunk 失败后调用 abort 并保留显式错误', () async {
    final calls = <String>[];
    AttachmentService.debugRequester = (method, [params]) async {
      calls.add(method);
      if (method == 'x/file/begin') return {'uploadId': 'up-2'};
      if (method == 'x/file/chunk') throw StateError('network down');
      if (method == 'x/file/abort') return {};
      fail('unexpected method $method');
    };
    final upload = AttachmentUpload(name: 'b.png', size: 3);

    await AttachmentService.upload(upload, Uint8List.fromList([1, 2, 3]));

    expect(calls, ['x/file/begin', 'x/file/chunk', 'x/file/abort']);
    expect(upload.done, isFalse);
    expect(upload.error, contains('network down'));
  });

  test('拒绝倒退或越界 received 并清理上传', () async {
    AttachmentService.debugRequester = (method, [params]) async {
      if (method == 'x/file/begin') return {'uploadId': 'up-3'};
      if (method == 'x/file/chunk') return {'received': 99};
      if (method == 'x/file/abort') return {};
      fail('unexpected method $method');
    };
    final upload = AttachmentUpload(name: 'c.png', size: 3);

    await AttachmentService.upload(upload, Uint8List.fromList([1, 2, 3]));

    expect(upload.error, contains('非法 received'));
    expect(upload.nodePath, isNull);
  });

// ============================================================
// splitAttachmentMarkers — 附件标记行解析（用户气泡渲染契约）
// ============================================================
group('splitAttachmentMarkers', () {
  test('标记行提取为节点路径，其余行为文本', () {
    const text = '[附件已上传到节点: '
        r'E:\w\.wzxclaw-attachments\a.png]'
        '\n'
        '[附件已上传到节点: '
        r'E:\w\.wzxclaw-attachments\b.jpg]'
        '\n'
        '这两张图对比一下';
    final parsed = splitAttachmentMarkers(text);

    expect(parsed.attachmentPaths, [
      r'E:\w\.wzxclaw-attachments\a.png',
      r'E:\w\.wzxclaw-attachments\b.jpg',
    ]);
    expect(parsed.displayText, '这两张图对比一下');
  });

  test('无标记：原样返回（trim 后），路径列表为空', () {
    final parsed = splitAttachmentMarkers('  普通消息  ');

    expect(parsed.displayText, '普通消息');
    expect(parsed.attachmentPaths, isEmpty);
  });

  test('行内其他方括号文本不误判（必须整行匹配标记）', () {
    const text = '[思考] 这不是附件标记\n正常行';
    final parsed = splitAttachmentMarkers(text);

    expect(parsed.attachmentPaths, isEmpty);
    expect(parsed.displayText, contains('[思考]'));
  });

  test('CRLF 换行也能拆分', () {
    const text =
        '[附件已上传到节点: /nas/x.png]\r\n带 win 换行的文本';
    final parsed = splitAttachmentMarkers(text);

    expect(parsed.attachmentPaths, ['/nas/x.png']);
    expect(parsed.displayText, '带 win 换行的文本');
  });
});
}
