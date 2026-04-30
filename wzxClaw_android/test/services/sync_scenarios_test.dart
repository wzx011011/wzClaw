/// 同步层场景测试（Phase 0d 基线）。
///
/// 目标：建立可重放的 8 个核心场景框架。本提交先实现 3 个最具代表性的：
/// - smoke：harness 装配 + 转发链路工作
/// - S1：桌面在当前会话流式发消息，手机不会触发多余 fetch
/// - S8：同一会话短时间内连续 fetch，第二次走 inflight dedup
///
/// S2-S7 在后续提交中按相同模式补齐（见 /memories/session/plan.md）。
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/connection_state.dart';
import 'package:wzxclaw_android/models/ws_message.dart';

import '../harness/sync_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SyncTestHarness smoke', () {
    test('装配可用：transport 注入到 chatStore / sessionSync', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // chatStore 和 sessionSync 都活着、订阅就绪
      expect(h.chatStore.currentSessionId, isNull);
      expect(h.sessionSync.activeSessionId, isNull);
      expect(h.transport.state, WsConnectionState.connected);
    });

    test('手机发送的消息会进 transport.sentMessages', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      h.sessionSync.fetchSessions();
      expect(
        h.transport.sentMessages.any(
          (m) => m.message.event == WsEvents.sessionListRequest,
        ),
        isTrue,
        reason: 'fetchSessions 应当通过 _transport.send 发出 list:request',
      );
    });
  });

  group('S1: 手机在当前会话，桌面在该会话流式发消息', () {
    test(
        '桌面端 sessionListResponse + 同 session agent text → '
        '不会触发额外的 list:request', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // 1. 手机请求会话列表
      h.sessionSync.fetchSessions();
      await h.settle();

      // 2. 桌面端返回 1 个会话 s1
      h.transport.pumpFromDesktop(WsEvents.sessionListResponse, {
        'requestId': h.transport.sentMessages.first.message.data['requestId'],
        'workspacePath': '/ws',
        'workspaceName': 'ws',
        'activeSessionId': 's1',
        'sessions': [
          {
            'id': 's1',
            'title': 'S1',
            'createdAt': 1,
            'updatedAt': 1,
            'messageCount': 0,
          },
        ],
      });
      await h.settle();

      expect(h.sessionSync.sessions.length, 1);
      expect(h.sessionSync.sessions.first.id, 's1');

      // 3. 清空发送记录，模拟桌面流式 agent 文本
      h.transport.clearSent();
      h.transport.pumpFromDesktop(WsEvents.agentText, {
        'sessionId': 's1',
        'text': 'hello',
      });
      await h.settle();

      // 期望：流式消息到达不应触发 fetchSessions（即没有额外 list:request 发出）
      final extraListRequests = h.transport.sentMessages.where(
        (m) => m.message.event == WsEvents.sessionListRequest,
      );
      expect(
        extraListRequests,
        isEmpty,
        reason: '收到 agentText 不应再次拉会话列表',
      );
    });
  });

  group('S2: 用户手动浏览 s1，桌面在 s2 跑 agent', () {
    // Phase 1 修复：桌面自发 agent 启动改用 desktop:agent:started 事件，
    // 该事件不会强制切换手机视图，用户手动浏览的会话得以保留。
    test('desktop:agent:started(s2) 不应把手机视图从 s1 切走', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // 用户主动停留在 s1（user-manual 标记）
      await h.chatStore.switchToSession('s1', userInitiated: true);
      await h.settle();
      expect(h.chatStore.currentSessionId, 's1');
      expect(h.chatStore.userManuallySwitched, isTrue);

      // 桌面端推 desktop:agent:started(s2)（新协议）
      h.transport.pumpFromDesktop(WsEvents.desktopAgentStarted, {
        'sessionId': 's2',
      });
      await h.settle();

      // 手机视图应仍在 s1
      expect(h.chatStore.currentSessionId, 's1',
          reason: '用户手动浏览的会话不应被桌面 desktop:agent:started 抢占',);
    });
  });

  group('S3: 系统自动加载 s1，桌面切到 s2', () {
    test('session:active(s2) 应让手机自动跟随到 s2', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // 系统自动切到 s1（非用户点击）
      await h.chatStore.switchToSession('s1');
      await h.settle();
      expect(h.chatStore.currentSessionId, 's1');
      expect(h.chatStore.userManuallySwitched, isFalse);

      // 桌面切到 s2
      h.transport.pumpFromDesktop(WsEvents.sessionActive, {
        'sessionId': 's2',
      });
      await h.settle();

      expect(h.chatStore.currentSessionId, 's2',
          reason: '系统自动状态下应跟随桌面切换',);
      expect(h.sessionSync.activeSessionId, 's2');
    });
  });

  group('S4: agent:done 之后到达的 list:response 不应覆盖刚渲染的消息', () {
    test('done 后的 list:response 不会清空 chatStore 消息', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // 进入 s1，跑一段流式
      await h.chatStore.switchToSession('s1');
      await h.settle();

      h.transport.pumpFromDesktop(WsEvents.agentText, {
        'sessionId': 's1',
        'text': 'hello world',
      });
      h.transport.pumpFromDesktop(WsEvents.agentDone, {
        'sessionId': 's1',
      });
      await h.settle();

      final msgsAfterDone = h.chatStore.messages.length;
      expect(msgsAfterDone, greaterThan(0),
          reason: '流式完成后应至少有一条 assistant 消息',);

      // 模拟一个迟到的 list:response：messageCount=0（即桌面尚未持久化新消息）
      h.transport.pumpFromDesktop(WsEvents.sessionListResponse, {
        'requestId': 'late_req',
        'workspacePath': '/ws',
        'workspaceName': 'ws',
        'activeSessionId': 's1',
        'sessions': [
          {
            'id': 's1',
            'title': 'S1',
            'createdAt': 1,
            'updatedAt': 1,
            'messageCount': 0,
          },
        ],
      });
      await h.settle();

      // 刚 done 的 chatStore 消息不应被冲掉
      expect(h.chatStore.messages.length, msgsAfterDone,
          reason: 'agent:done 后到达的过期 list:response 不应覆盖正在显示的消息',);
    });
  });

  group('S5: 重连后桌面 agent 仍在跑 → 手机重新拉取 s1 全量', () {
    test('agent:running 事件触发对该会话的 load:request', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      h.transport.clearSent();
      h.transport.pumpFromDesktop('stream:agent:running', {
        'sessionId': 's1',
      });
      await h.settle();

      final loadReqs = h.transport.sentMessages
          .where((m) => m.message.event == WsEvents.sessionLoadRequest)
          .where((m) => m.message.data['sessionId'] == 's1')
          .toList();
      expect(loadReqs, isNotEmpty,
          reason: '收到 agent:running 应主动重新拉取该会话历史',);
    });
  });

  group('S6: clearLocalCache 后旧 requestId 的 list:response 应被拒绝', () {
    // Phase 4 架构：_isLoading inflight dedup 防止同一时刻有两个并发请求。
    // 过期响应场景现在通过 clearLocalCache（强制重置 _isLoading + 发出新请求）产生：
    // r1 inflight → clearLocalCache → r2 inflight（r1 失效）→ r1 响应到达 → 拒绝。
    test('clearLocalCache 后旧 requestId 的响应不应切 chatStore', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      // 第一次 fetch：发出 r1
      h.sessionSync.fetchSessions();
      await h.settle();
      final firstReqId = h.transport.sentMessages
          .firstWhere(
              (m) => m.message.event == WsEvents.sessionListRequest,)
          .message
          .data['requestId'] as String;

      // clearLocalCache：强制重置 _isLoading，发出 r2，r1 变为过期
      unawaited(h.sessionSync.clearLocalCache());
      await h.settle();

      // 让旧 requestId r1 的响应迟到送达（r1 != _currentListRequestId=r2）
      h.transport.pumpFromDesktop(WsEvents.sessionListResponse, {
        'requestId': firstReqId,
        'workspacePath': '/ws',
        'workspaceName': 'ws',
        'activeSessionId': 's-old',
        'sessions': [
          {
            'id': 's-old',
            'title': 'OLD',
            'createdAt': 0,
            'updatedAt': 0,
            'messageCount': 0,
          },
        ],
      });
      await h.settle();

      // 旧 requestId 响应应被 _currentListRequestId 校验拒绝，不切 chatStore
      expect(h.chatStore.currentSessionId, isNull,
          reason: '旧 requestId 的响应不应擅自把 chatStore 切到 s-old',);
    }, timeout: const Timeout(Duration(seconds: 10)),);
  });

  group('S7: 桌面创建新会话推送 → 列表更新但 chatStore 视图不变', () {
    test('session:changed 事件触发 fetchSessions，但不切 chatStore', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      await h.chatStore.switchToSession('s1', userInitiated: true);
      await h.settle();
      expect(h.chatStore.currentSessionId, 's1');

      h.transport.clearSent();
      h.transport.pumpFromDesktop('session:changed', {});
      await h.settle();

      // 手机会请求新的会话列表
      final listReqs = h.transport.sentMessages
          .where((m) => m.message.event == WsEvents.sessionListRequest);
      expect(listReqs, isNotEmpty,
          reason: 'session:changed 应触发 fetchSessions',);

      // 但 chatStore 仍在 s1
      expect(h.chatStore.currentSessionId, 's1',
          reason: 'session:changed 不应擅自切走当前会话',);
    });
  });

  group('S8: 同一会话短时间双 fetch → 第二次走去抖', () {
    test('2 秒内的第二次 fetchSessions 不会再发 list:request', () async {
      final h = SyncTestHarness.fresh();
      addTearDown(h.dispose);
      await h.settle();

      h.sessionSync.fetchSessions();
      await h.settle();
      final firstCount = h.transport.sentMessages
          .where((m) => m.message.event == WsEvents.sessionListRequest)
          .length;

      // 立即再 fetch 一次（inflight dedup：第一次 _isLoading = true，第二次被跳过）
      h.sessionSync.fetchSessions();
      await h.settle();
      final secondCount = h.transport.sentMessages
          .where((m) => m.message.event == WsEvents.sessionListRequest)
          .length;

      expect(secondCount, firstCount,
          reason: '第二次 fetch 应被 inflight dedup 逻辑拦截',);
    });
  });
}
