import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/file_download_service.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tempBase;

  setUp(() async {
    tempBase = await Directory.systemTemp.createTemp('dl-service-test');
    FileDownloadService.debugTempDir = () async => tempBase;
  });

  tearDown(() async {
    FileDownloadService.debugRequester = null;
    FileDownloadService.debugBridge = null;
    FileDownloadService.debugTempDir = null;
    try {
      if (await tempBase.exists()) {
        await tempBase.delete(recursive: true);
      }
    } on FileSystemException {
      // begin 触发的后台临时目录清扫可能仍持有句柄（Windows 常见），
      // 目录清理失败不影响任何被测行为，留给系统 Temp 清理兜底
    }
  });

  test('begin 成功：登记任务并采用服务端白名单名', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      expect(method, 'x/file/download/begin');
      expect(params?['path'], r'E:\work\report.pdf');
      return {'downloadId': 'dl-1', 'name': 'report.pdf', 'size': 1024};
    };

    final task = await FileDownloadService.begin(r'E:\work\report.pdf');

    expect(task.phase, FileDownloadPhase.awaitingChoice);
    expect(task.name, 'report.pdf');
    expect(task.size, 1024);
  });

  test('begin 工作区外拒绝：映射为「仅限工作区内」提示', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      throw const ZcodeRequestException(
        -32103,
        'X_OUT_OF_WORKSPACE',
        {'reason': 'X_OUT_OF_WORKSPACE'},
      );
    };

    final task = await FileDownloadService.begin(r'D:\secrets\key.pem');

    expect(task.phase, FileDownloadPhase.failed);
    expect(task.error, '暂不支持下载工作区外的文件');
  });

  test('begin 文件不存在：与工作区外给出不同提示', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      throw const ZcodeRequestException(
        -32103,
        'X_NOT_FOUND',
        {'reason': 'X_NOT_FOUND'},
      );
    };

    final task = await FileDownloadService.begin(r'E:\work\gone.txt');

    expect(task.phase, FileDownloadPhase.failed);
    expect(task.error, contains('没有这个文件'));
  });

  test('begin 缺 data.reason 的 -32103：按文件不存在兜底（不靠 message 嗅探）', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      throw const ZcodeRequestException(-32103, 'unknown');
    };

    final task = await FileDownloadService.begin(r'E:\work\gone.txt');

    expect(task.phase, FileDownloadPhase.failed);
    expect(task.error, contains('没有这个文件'));
  });

  test('预览路径：分块还原字节一致 → 调系统查看器 → previewing', () async {
    final payload = Uint8List.fromList(List.generate(700, (i) => i & 0xff));
    final bridgeCalls = <String, Map<String, dynamic>>{};
    FileDownloadService.debugRequester = (method, [params]) async {
      switch (method) {
        case 'x/file/download/begin':
          return {'downloadId': 'dl-2', 'name': 'shot.png', 'size': payload.length};
        case 'x/file/download/chunk':
          final offset = params?['offset'] as int;
          final end = (offset + 256).clamp(0, payload.length);
          return {
            'data': base64Encode(payload.sublist(offset, end)),
            'received': end,
            'eof': end >= payload.length,
          };
        default:
          fail('unexpected method $method');
      }
    };
    FileDownloadService.debugBridge = (method, args) async {
      bridgeCalls[method] = args;
      return method == 'preview' ? {'ok': true} : {'ok': true, 'uri': 'content://x'};
    };

    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: true);

    expect(task.phase, FileDownloadPhase.previewing);
    expect(task.received, payload.length);
    expect(task.error, isNull);
    expect(bridgeCalls['preview']?['mime'], 'image/png');
    // 预览不落 MediaStore，临时文件保留（等保存/放弃决定）
    expect(bridgeCalls.containsKey('save'), isFalse);
    final tempFile = _soleTempFile(tempBase);
    expect(tempFile, isNotNull);
    expect(await tempFile!.length(), payload.length);
    expect(_soleTempFile(tempBase)!.readAsBytesSync(), payload);
  });

  test('直接下载：拉取即写 MediaStore → saved 且临时文件已清理', () async {
    final payload = Uint8List.fromList('hello download'.codeUnits);
    FileDownloadService.debugRequester = (method, [params]) async {
      switch (method) {
        case 'x/file/download/begin':
          return {'downloadId': 'dl-3', 'name': 'note.txt', 'size': payload.length};
        case 'x/file/download/chunk':
          final offset = params?['offset'] as int;
          return {
            'data': base64Encode(payload.sublist(offset)),
            'received': payload.length,
            'eof': true,
          };
        default:
          fail('unexpected method $method');
      }
    };
    Map<String, dynamic>? savedArgs;
    FileDownloadService.debugBridge = (method, args) async {
      expect(method, 'save');
      savedArgs = args;
      return {'ok': true, 'uri': 'content://downloads/xyz'};
    };

    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: false);

    expect(task.phase, FileDownloadPhase.saved);
    expect(savedArgs?['mime'], 'text/plain');
    expect(savedArgs?['srcPath'], isNotNull);
    expect(
      File(savedArgs!['srcPath'] as String).existsSync(),
      isFalse,
      reason: '保存成功后临时文件应清理',
    );
  });

  test('保存失败：任务转 failed 且错误可见', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-4', 'name': 'a.bin', 'size': 4};
      }
      return {'data': base64Encode(Uint8List(4)), 'received': 4, 'eof': true};
    };
    FileDownloadService.debugBridge = (method, args) async {
      return {'ok': false, 'reason': 'unavailable'};
    };

    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: false);

    expect(task.phase, FileDownloadPhase.failed);
    expect(task.error, contains('保存失败'));
  });

  test('无预览应用：仍转 previewing 并给出提示（可保存/放弃）', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-5', 'name': 'a.xyz', 'size': 2};
      }
      return {'data': base64Encode(Uint8List.fromList([9, 9])), 'received': 2, 'eof': true};
    };
    FileDownloadService.debugBridge = (method, args) async {
      return {'ok': false, 'reason': 'no-handler'};
    };

    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: true);

    expect(task.phase, FileDownloadPhase.previewing);
    expect(task.notice, contains('没有可预览'));
    expect(
      task.error,
      isNull,
      reason: '预览不可用是提示不是错误',
    );
  });

  test('预览后放弃：清理临时文件转 cancelled', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-6', 'name': 'a.txt', 'size': 2};
      }
      return {'data': base64Encode(Uint8List.fromList([1, 2])), 'received': 2, 'eof': true};
    };
    FileDownloadService.debugBridge = (method, args) async => {'ok': true};
    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: true);
    final tempFile = _soleTempFile(tempBase)!;

    await FileDownloadService.discard(task);

    expect(task.phase, FileDownloadPhase.cancelled);
    expect(tempFile.existsSync(), isFalse);
  });

  test('拉取中取消：停止循环、清临时文件、调 abort', () async {
    final calls = <String>[];
    final firstChunkGate = Completer<void>();
    FileDownloadService.debugRequester = (method, [params]) async {
      calls.add(method);
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-7', 'name': 'big.bin', 'size': 600};
      }
      if (method == 'x/file/download/chunk') {
        final offset = params?['offset'] as int;
        if (offset == 256) {
          await firstChunkGate.future; // 第二块挂起，制造取消窗口（第一块正常放行）
        }
        return {'data': base64Encode(Uint8List(256)), 'received': offset + 256, 'eof': false};
      }
      return {'ok': true};
    };

    final task = await FileDownloadService.begin('ignored');
    final pulling = FileDownloadService.pull(task, forPreview: true);
    // 等进入 pulling（第一块已写入）再取消
    while (task.received == 0) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await FileDownloadService.cancel(task);
    firstChunkGate.complete();
    await pulling;

    expect(task.phase, FileDownloadPhase.cancelled);
    expect(calls.contains('x/file/download/abort'), isTrue, reason: '取消应通知节点焚会话');
    expect(_soleTempFile(tempBase), isNull, reason: '取消后不留临时文件');
  });

  test('eof 完整性断言：收满尺寸不符转 failed', () async {
    FileDownloadService.debugRequester = (method, [params]) async {
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-8', 'name': 'cut.bin', 'size': 100};
      }
      // 只给 40 字节就 eof：模拟节点侧文件被改小
      return {'data': base64Encode(Uint8List(40)), 'received': 40, 'eof': true};
    };

    final task = await FileDownloadService.begin('ignored');
    await FileDownloadService.pull(task, forPreview: false);

    expect(task.phase, FileDownloadPhase.failed);
    expect(task.error, contains('不完整'));
  });

  test('begin 携带会话工作区身份（下载边界跟随会话工作区）', () async {
    Map<String, dynamic>? captured;
    FileDownloadService.debugRequester = (method, [params]) async {
      captured = params;
      return {'downloadId': 'dl-ws', 'name': 'a.txt', 'size': 1};
    };

    final task = await FileDownloadService.begin(
      r'E:\other\report.txt',
      workspacePath: r'E:\sessions\proj',
    );

    expect(task.phase, FileDownloadPhase.awaitingChoice);
    expect(captured?['path'], r'E:\other\report.txt');
    expect(captured?['workspacePath'], r'E:\sessions\proj');
  });

  test('取消与最后一个 chunk 交错：不落盘、不触发保存、终态 cancelled', () async {
    // 评审 #13 回归：此前 cancel 先 await 清理再置状态，清理窗口内返回的
    // 末块会继续写盘并进入保存流程（终态 failed、临时文件残留）。
    final chunkStarted = Completer<void>();
    final chunkRelease = Completer<Map<String, dynamic>>();
    final abortStarted = Completer<void>();
    final abortRelease = Completer<void>();
    final saveCalls = <Map<String, dynamic>>[];
    FileDownloadService.debugRequester = (method, [params]) async {
      switch (method) {
        case 'x/file/download/chunk':
          chunkStarted.complete();
          return chunkRelease.future;
        case 'x/file/download/abort':
          if (!abortStarted.isCompleted) abortStarted.complete();
          await abortRelease.future;
          return {'ok': true};
        default:
          fail('unexpected method $method');
      }
    };
    FileDownloadService.debugBridge = (method, args) async {
      saveCalls.add(Map<String, dynamic>.from(args));
      return {'ok': false, 'reason': 'no-file'};
    };

    final task = FileDownloadTask(
      nodePath: '/workspace/race.txt',
      name: 'race.txt',
      size: 3,
      downloadId: 'dl-race',
    );
    final pulling = FileDownloadService.pull(
      task,
      forPreview: false,
      onChanged: (_) {},
    );
    await chunkStarted.future;
    final cancellation = FileDownloadService.cancel(task, onChanged: (_) {});
    // cancel 先置终态再 await 清理：abort 开启时 cancelled 已生效
    await abortStarted.future;
    expect(
      task.phase,
      FileDownloadPhase.cancelled,
      reason: '取消必须立即生效，不等远端 abort 返回',
    );
    // 末块此刻才返回：不得落盘或触发保存
    chunkRelease.complete({
      'data': base64Encode([1, 2, 3]),
      'received': 3,
      'eof': true,
    });
    abortRelease.complete();
    await Future.wait([pulling, cancellation]);
    await Future<void>.delayed(Duration.zero);

    expect(saveCalls, isEmpty, reason: '已取消的任务不得进入保存');
    expect(task.phase, FileDownloadPhase.cancelled);
    expect(_soleTempFile(tempBase), isNull, reason: '取消后不留临时文件');
  });

  test('拉取中重复触发 pull 被忽略（确认面板可重复弹出，不叠加拉取）', () async {
    var chunkCalls = 0;
    FileDownloadService.debugRequester = (method, [params]) async {
      if (method == 'x/file/download/begin') {
        return {'downloadId': 'dl-dup', 'name': 'a.bin', 'size': 2};
      }
      if (method == 'x/file/download/chunk') {
        chunkCalls += 1;
        return {'data': base64Encode(Uint8List(2)), 'received': 2, 'eof': true};
      }
      fail('unexpected method $method');
    };
    FileDownloadService.debugBridge = (method, args) async =>
        method == 'preview' ? {'ok': true} : {'ok': true, 'uri': 'content://x'};

    final task = await FileDownloadService.begin('ignored');
    final first = FileDownloadService.pull(task, forPreview: true);
    final second = FileDownloadService.pull(task, forPreview: false);
    await Future.wait([first, second]);

    expect(chunkCalls, 1, reason: '第二次 pull 应被 awaitingChoice 门卫忽略');
    expect(task.phase, FileDownloadPhase.previewing);
  });
}

File? _soleTempFile(Directory root) {
  final dlDir = Directory('${root.path}${Platform.pathSeparator}wzxclaw-dl');
  if (!dlDir.existsSync()) return null;
  final files = dlDir.listSync().whereType<File>().toList();
  return files.isEmpty ? null : files.single;
}
