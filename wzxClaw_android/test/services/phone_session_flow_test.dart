/// Option A「会话独立」核心流程测试：
/// - PhoneSessionIndex：本地索引 CRUD / 持久化 / 标题派生 / 每设备工作区
/// - refreshLocalSessions：本地列表 + 视图选择（保持/恢复/停在欢迎态）
/// - startNewConversation：首条消息 → 引擎建会话 → 索引 → 视图 → 发送
/// - importEngineSession：从引擎导入兜底
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/models/session_meta.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/phone_session_index.dart';

import '../harness/sync_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PhoneSessionIndex', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
      PhoneSessionIndex.resetForTest();
    });

    test('deriveTitle 压缩空白并截断到 30 字', () {
      expect(PhoneSessionIndex.deriveTitle('  hello   world  '), 'hello world');
      final long = 'a' * 50;
      final title = PhoneSessionIndex.deriveTitle(long);
      expect(title.length, PhoneSessionIndex.titleMaxLength + 1); // 30 字 + …
      expect(title.endsWith('…'), isTrue);
      expect(PhoneSessionIndex.deriveTitle('   '), '（无标题会话）');
    });

    test('upsert/sessionsForDevice 按设备过滤 + updatedAt 倒序', () async {
      final idx = PhoneSessionIndex.instance;
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'a', deviceSid: 'd1', title: 'A',
        createdAt: 1, updatedAt: 100,
      ));
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'b', deviceSid: 'd1', title: 'B',
        createdAt: 2, updatedAt: 200,
      ));
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'c', deviceSid: 'd2', title: 'C',
        createdAt: 3, updatedAt: 300,
      ));

      final d1 = await idx.sessionsForDevice('d1');
      expect(d1.map((e) => e.sessionId).toList(), ['b', 'a']);
      final all = await idx.sessionsForDevice('');
      expect(all.length, 3);
    });

    test('upsert 已存在条目保留 createdAt/firstMessage', () async {
      final idx = PhoneSessionIndex.instance;
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'a', deviceSid: 'd1', title: '旧标题',
        firstMessage: '旧首条', createdAt: 111, updatedAt: 111,
      ));
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'a', deviceSid: 'd1', title: '新标题',
        createdAt: 999, updatedAt: 999,
      ));
      final e = await idx.find('a');
      expect(e?.createdAt, 111, reason: 'createdAt 不应被二次 upsert 覆盖');
      expect(e?.firstMessage, '旧首条');
      expect(e?.title, '新标题');
      expect(e?.updatedAt, 999);
    });

    test('remove/rename/touch 生效并持久化（重读一致）', () async {
      final idx = PhoneSessionIndex.instance;
      await idx.upsert(const PhoneSessionEntry(
        sessionId: 'a', deviceSid: 'd1', title: 'A',
        createdAt: 1, updatedAt: 1,
      ));
      await idx.rename('a', '改名');
      await idx.touch('a', updatedAt: 500);
      expect((await idx.find('a'))?.title, '改名');
      expect((await idx.find('a'))?.updatedAt, 500);

      // 模拟进程重启：清内存缓存后从同一 mock prefs 重读
      PhoneSessionIndex.resetForTest();
      expect((await idx.find('a'))?.title, '改名');
      expect((await idx.find('a'))?.updatedAt, 500);

      await idx.remove('a');
      expect(await idx.find('a'), isNull);
    });

    test('setDeviceWorkspace 每设备记忆', () async {
      final idx = PhoneSessionIndex.instance;
      await idx.setDeviceWorkspace('d1', 'key-1', '/volume1/share/zcode');
      final ws = await idx.workspaceFor('d1');
      expect(ws?.workspaceKey, 'key-1');
      expect(ws?.displayName, 'zcode');
      expect(await idx.workspaceFor('d2'), isNull);
      // 空参数不写入
      await idx.setDeviceWorkspace('d3', '', '');
      expect(await idx.workspaceFor('d3'), isNull);
    });
  });

  group('Option A 会话流（SessionSyncService）', () {
    test('refreshLocalSessions：本地索引驱动列表，无引擎请求', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      await PhoneSessionIndex.instance.upsert(const PhoneSessionEntry(
        sessionId: 'p1', deviceSid: 'desktop-fake', title: '手机会话',
        createdAt: 1, updatedAt: 10,
      ));

      h.transport.clearSent();
      await h.sessionSync.refreshLocalSessions();
      await h.settle();

      expect(h.sessionSync.sessions.single.id, 'p1');
      expect(
        h.transport.sentMessages
            .where((m) => m.message.event == WsEvents.sessionListRequest),
        isEmpty,
        reason: '本地刷新不应触发引擎 session/list',
      );
      // 无恢复目标 → 停在欢迎态
      expect(h.chatStore.currentSessionId, isNull);
      expect(h.sessionSync.activeSessionId, isNull);
    });

    test('startNewConversation：建会话 → 索引 → 视图 → 发送', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      final okFuture = h.sessionSync.startNewConversation('帮我修一个 bug');
      await h.settle();

      // 引擎侧应答 create（ConnectionManager 翻译层的响应形状）
      final createReq = h.transport.sentMessages
          .lastWhere((m) => m.message.event == WsEvents.sessionCreateRequest);
      h.transport.pumpFromDesktop(WsEvents.sessionCreateResponse, {
        'requestId': createReq.message.data['requestId'],
        'session': {
          'id': 'new-1',
          'title': 'New Session',
          'createdAt': 5,
          'updatedAt': 5,
          'messageCount': 0,
        },
      });
      final ok = await okFuture;
      await h.settle();

      expect(ok, isTrue);
      // 首条消息作为标题写入本地索引
      final entry = await PhoneSessionIndex.instance.find('new-1');
      expect(entry?.title, '帮我修一个 bug');
      expect(entry?.deviceSid, 'desktop-fake');
      // 视图已切到新会话
      expect(h.chatStore.currentSessionId, 'new-1');
      expect(h.sessionSync.activeSessionId, 'new-1');
      // 首条消息带 sessionId 发出
      final send = h.transport.sentMessages
          .lastWhere((m) => m.message.event == WsEvents.commandSend);
      expect(send.message.data['sessionId'], 'new-1');
      expect(send.message.data['content'], '帮我修一个 bug');
      // 列表包含新会话
      expect(h.sessionSync.sessions.map((s) => s.id), contains('new-1'));
    });

    test('deleteSession：仅删本地索引与缓存，当前会话回到欢迎态', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      await PhoneSessionIndex.instance.upsert(const PhoneSessionEntry(
        sessionId: 'p1', deviceSid: 'desktop-fake', title: 'P1',
        createdAt: 1, updatedAt: 1,
      ));
      await h.sessionSync.refreshLocalSessions();
      h.sessionSync.setActiveSession('p1');
      await h.chatStore.switchToSession('p1', userInitiated: true);
      await h.settle();

      final ok = await h.sessionSync.deleteSession('p1');
      await h.settle();

      expect(ok, isTrue);
      expect(await PhoneSessionIndex.instance.find('p1'), isNull);
      expect(h.sessionSync.sessions, isEmpty);
      expect(h.chatStore.currentSessionId, isNull,
          reason: '删除当前会话应回到「新任务」欢迎态');
      // Option A：删除不再向引擎发 session:delete
      expect(
        h.transport.sentMessages
            .where((m) => m.message.event == WsEvents.sessionDeleteRequest),
        isEmpty,
      );
    });

    test('importEngineSession：引擎会话写入本地索引并出现在列表', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      final ok = await h.sessionSync.importEngineSession(
        const SessionMeta(
          id: 'engine-9',
          workspacePath: '/ws',
          workspaceName: 'ws',
          title: '桌面端建的会话',
          createdAt: 1,
          updatedAt: 99,
          messageCount: 3,
        ),
      );
      await h.settle();

      expect(ok, isTrue);
      final entry = await PhoneSessionIndex.instance.find('engine-9');
      expect(entry?.deviceSid, 'desktop-fake');
      expect(entry?.title, '桌面端建的会话');
      expect(h.sessionSync.sessions.single.id, 'engine-9');
    });

    test('fetchEngineSessions：显式拉引擎列表并返回解析结果', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      final future = h.sessionSync.fetchEngineSessions();
      await h.settle();
      h.transport.pumpFromDesktop(WsEvents.sessionListResponse, {
        'requestId': h.transport.sentMessages
            .lastWhere((m) => m.message.event == WsEvents.sessionListRequest)
            .message
            .data['requestId'],
        'workspacePath': '/ws',
        'workspaceName': 'ws',
        'sessions': [
          {
            'id': 'e1',
            'title': 'E1',
            'createdAt': 1,
            'updatedAt': 1,
            'messageCount': 0,
          },
        ],
      });
      final list = await future;

      expect(list.single.id, 'e1');
      // 引擎结果不进入抽屉列表（本地索引才是数据源）
      expect(h.sessionSync.sessions, isEmpty);
    });
  });
}
