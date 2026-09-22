// ============================================================
// zcode_session_cache_test — 会话缓存持久化契约（真 sqlite 往返）
//
// 契约锚点（柱2 评审 P2 2026-09-22）：finish 是折叠依据
// （ChatMessage.finish → defaultTurnFold），不进缓存则重启后
// 历史回合全部展开、碎片墙复活。
// ============================================================

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_session_cache.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart'
    show ZcodeSessionItem;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  test('finish 字段缓存往返：重启后折叠依据仍在（柱2）', () async {
    final dir = await Directory.systemTemp.createTemp('zcode-cache-test');
    // Windows 下 sqlite 句柄释放有延迟：清理尽力而为，失败不遮蔽用例结果
    addTearDown(() async {
      try {
        await dir.delete(recursive: true);
      } catch (_) {}
    });
    await databaseFactory.setDatabasesPath(dir.path);

    final cache = ZcodeSessionCache();
    await cache.upsertMessages('sess-finish', [
      ZcodeSessionItem(
        protoId: 'msg-finish-stop',
        synced: true,
        message: ChatMessage(
          role: MessageRole.assistant,
          createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
          processParts: const [ChatProcessPart.text('干净完成的回答')],
          finish: 'stop',
        ),
      ),
      ZcodeSessionItem(
        protoId: 'msg-finish-null',
        synced: true,
        message: ChatMessage(
          role: MessageRole.assistant,
          createdAt: DateTime.fromMillisecondsSinceEpoch(2000),
          processParts: const [ChatProcessPart.text('中断的回答')],
          // finish null = 工具调用中断，折叠策略据此保持展开
        ),
      ),
    ]);

    final loaded = await cache.loadTail('sess-finish');
    expect(loaded, hasLength(2));
    expect(loaded[0].message.finish, 'stop', reason: 'finish 必须随行持久化');
    expect(loaded[0].message.text, '干净完成的回答');
    expect(loaded[1].message.finish, isNull, reason: 'null finish 同样保真');
  });
}
