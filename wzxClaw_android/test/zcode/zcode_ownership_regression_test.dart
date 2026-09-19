// ============================================================
// zcode_ownership_regression_test — 归属缺陷回归
//
// 2026-09-19 架构评审 P1 修复的回归锚定：
// - P1-3 切换节点后不得沿用上一节点选择的工作区；
// - P1-4 权限请求按会话归属、导航不拒绝后台请求、并发排队轮转；
// - P1-5 旧回合迟到的权威刷新不得收尾新回合；
// - P1-6 重连后 seq 无新事件必须用 session/read 确认，不得推断空闲；
// - #12 模型选中是会话级状态，后台会话补丁不串视口。
// 2026-09-19 二轮评审修复的回归锚定（本轮新增）：
// - P1 重连确认的 session/read 在途期间开始的新回合，不被迟到的
//   「当时 idle」收尾（确认前捕获回合代次）；
// - P1 非当前会话的权限请求必须显示来源（reverseSourceLabel）；
// - P2 AskUser 队列轮转不得把上一题的已选/补充文本带入下一题；
// - P2 openSession 恢复在途以 sessionRestoring 显式置位，
//   页面排队自动冲队以此为门卫。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/ask_user_bar.dart';
import 'package:wzxclaw_android/widgets/permission_bar.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_reverse_models.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.setInstanceForTest(FakeZcodeNotifier());
  });

  tearDown(ZcodeNotifier.resetInstanceForTest);

  group('P1-3 工作区归属', () {
    test('切换节点后 newSession 不再携带上一节点选择的工作区', () async {
      final nodeA = FakeZcodeRelayClient();
      FakeSessionServer().bind(nodeA);
      final store = pairedStore(nodeA);
      store.selectWorkspace('ws-a', '/node-a/project');

      // 正确切换入口：connectToStored → disconnect → detach → attach
      store.detach();
      final nodeB = FakeZcodeRelayClient();
      FakeSessionServer().bind(nodeB);
      nodeB.handlers['session/create'] = (_) =>
          {'session': {'sessionId': 'created-on-b'}};
      store.attach(nodeB, desktopId: 'node-b', desktopName: '节点 B');

      await store.newSession();

      // B 无任何会话/工作区：应显式报「没有可用的工作区」，
      // 绝不能把 A 的工作区发给 B（错误建会话）
      expect(
        nodeB.requests.where((r) => r.key == 'session/create'),
        isEmpty,
      );
      expect(store.error, contains('没有可用的工作区'));
    });

    test('切换节点后按 B 自己的会话列表回退默认工作区', () async {
      final nodeA = FakeZcodeRelayClient();
      FakeSessionServer().bind(nodeA);
      final store = pairedStore(nodeA);
      store.selectWorkspace('ws-a', '/node-a/project');

      store.detach();
      final nodeB = FakeZcodeRelayClient();
      FakeSessionServer().bind(nodeB);
      nodeB.handlers['session/list'] = (_) => {
            'sessions': [
              {
                'sessionId': 'b-1',
                'title': 'B 会话',
                'workspace': {
                  'workspaceKey': 'ws-b',
                  'workspacePath': '/node-b/project',
                },
              },
            ],
          };
      nodeB.handlers['session/create'] = (params) {
        final ws = params?['workspace'] as Map;
        return {
          'session': {
            'sessionId': 'created-on-b',
            'workspace': ws,
          },
        };
      };
      store.attach(nodeB, desktopId: 'node-b', desktopName: '节点 B');

      await store.newSession();

      final create = nodeB.requests.firstWhere(
        (r) => r.key == 'session/create',
      );
      expect(
        (create.value!['workspace'] as Map)['workspacePath'],
        '/node-b/project',
      );
    });
  });

  group('P1-4 权限归属与队列', () {
    Future<dynamic> injectPermission(
      ZcodeChatStore store, {
      required String frameId,
      required String sessionId,
      required String toolCallId,
    }) {
      return store.debugHandleReverseRequest(
        ZcodeFrame(
          id: frameId,
          method: 'interaction/requestPermission',
          params: {
            'sessionId': sessionId,
            'input': {'command': 'echo hi'},
            'toolCallId': toolCallId,
            'toolName': 'Bash',
            'options': [
              {
                'optionId': 'allow_once',
                'response': {'decision': 'allow', 'reason': 'Approved once'},
              },
              {
                'optionId': 'deny',
                'response': {'decision': 'deny', 'reason': 'Denied'},
              },
            ],
          },
        ),
      );
    }

    test('打开其他会话不拒绝后台会话的权限请求', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('session-a');

      var settled = false;
      Object? rejection;
      final permission = injectPermission(
        store,
        frameId: 'server-1',
        sessionId: 'session-a',
        toolCallId: 'call-a',
      );
      unawaited(
        permission.then<void>(
          (_) => settled = true,
          onError: (Object e) {
            rejection = e;
            settled = true;
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolCallId, 'call-a');
      expect(store.activePermission?.sessionId, 'session-a');

      // 导航切到 B：只切视口，后台权限仍待答且展示保持
      await store.openSession('session-b');
      await Future<void>.delayed(Duration.zero);
      expect(settled, isFalse, reason: '导航不得拒绝后台权限请求');
      expect(rejection, isNull);
      expect(store.activePermission?.toolCallId, 'call-a');

      // 回来仍可正常应答
      store.respondToPermission('call-a', approved: true);
      expect(await permission, {'decision': 'allow', 'reason': 'Approved once'});
      expect(store.activePermission, isNull);
    });

    test('关闭会话视图不拒绝后台会话的权限请求', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('session-a');

      var settled = false;
      final permission = injectPermission(
        store,
        frameId: 'server-2',
        sessionId: 'session-a',
        toolCallId: 'call-view',
      );
      unawaited(permission.then<void>((_) => settled = true));
      await Future<void>.delayed(Duration.zero);

      store.closeSessionView();
      await Future<void>.delayed(Duration.zero);
      expect(settled, isFalse);
      expect(store.activePermission?.toolCallId, 'call-view');

      store.respondToPermission('call-view', approved: false);
      expect(await permission, {'decision': 'deny', 'reason': 'Denied'});
    });

    test('并发权限请求排队展示，先到先答，答完自动轮转', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);

      final futureA = injectPermission(
        store,
        frameId: 'server-3',
        sessionId: 'session-a',
        toolCallId: 'call-a',
      );
      final futureB = injectPermission(
        store,
        frameId: 'server-4',
        sessionId: 'session-b',
        toolCallId: 'call-b',
      );
      await Future<void>.delayed(Duration.zero);

      // 展示条指向最早请求；后来的不覆盖
      expect(store.activePermission?.toolCallId, 'call-a');
      store.respondToPermission('call-a', approved: true);
      expect(await futureA, {'decision': 'allow', 'reason': 'Approved once'});
      expect(store.activePermission?.toolCallId, 'call-b');
      store.respondToPermission('call-b', approved: false);
      expect(await futureB, {'decision': 'deny', 'reason': 'Denied'});
      expect(store.activePermission, isNull);
    });
  });

  group('P1-5 回合收尾归属', () {
    test('旧回合迟到的权威刷新不收尾新回合', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('session-race');

      await store.sendMessage('first');
      pushEvent(
        store,
        sessionId: 'session-race',
        type: 'turn.started',
        seq: 1,
        turnId: 'turn-t1',
        payload: {'messageId': 'user-t1', 'input': 'first'},
      );

      // 挂起 T1 的权威历史拉取，制造「T2 已开始旧刷新才返回」的交错
      final oldSnapshot = Completer<Map<String, dynamic>>();
      fake.handlers['session/messages'] = (_) => oldSnapshot.future;
      pushEvent(
        store,
        sessionId: 'session-race',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-t1',
        payload: {
          'response': 'done',
          'toolCallCount': 1,
          'resultType': 'success',
        },
      );

      await store.sendMessage('second');
      pushEvent(
        store,
        sessionId: 'session-race',
        type: 'turn.started',
        seq: 3,
        turnId: 'turn-t2',
        payload: {'messageId': 'user-t2', 'input': 'second'},
      );
      expect(store.isStreaming, isTrue);

      // 旧回合的历史此时才返回：不得清 T2 的流式状态
      oldSnapshot.complete({'messages': []});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(store.isStreaming, isTrue, reason: 'T2 仍在跑');
      expect(store.isWaitingForResponse, isTrue, reason: 'T2 尚未收到增量，等待标志不得被旧刷新清掉');
      expect(store.activeSessionId, 'session-race');
    });
  });

  group('P1-6 重连确认', () {
    test('重连后无新事件：服务端 running 则保留流式并读权威状态', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-running').status = 'running';
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = pairedStore(fake);
      await store.openSession('session-running');
      expect(store.isStreaming, isTrue);
      final readsBefore =
          fake.requests.where((r) => r.key == 'session/read').length;

      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(
        fake.requests.where((r) => r.key == 'session/read').length,
        greaterThan(readsBefore),
        reason: '必须读权威状态确认，不得凭 seq 不变推断结束',
      );
      expect(store.isStreaming, isTrue, reason: '服务端仍在 running');
    });

    test('重连后无新事件：服务端 idle 才收尾', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-idle').status = 'running';
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = pairedStore(fake);
      await store.openSession('session-idle');
      expect(store.isStreaming, isTrue);

      // 第一轮重连：running → 保留
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isTrue);

      // 服务端回合已结束：第二轮重连读 idle → 权威刷新收尾
      server.session('session-idle').status = 'idle';
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isFalse, reason: '服务端 idle 应收尾');
    });
  });

  group('P1-6b 重连确认竞态（2026-09-19 二轮评审 P1）', () {
    test('重连确认 read 在途期间开始的 T2 不被迟到的 idle 收尾', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('review-race').status = 'running';
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('review-race');
      expect(store.isStreaming, isTrue);

      // 挂起重连确认的 session/read，制造「确认在途 → T1 完成 → T2 开始
      // → 旧 idle 才返回」的交错
      final oldIdle = Completer<Map<String, dynamic>>();
      final confirming = Completer<void>();
      fake.handlers['session/read'] = (_) {
        if (!confirming.isCompleted) confirming.complete();
        return oldIdle.future;
      };
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      await confirming.future;

      // T1 的完成推送先到，等待其权威刷新完全收敛
      pushEvent(store,
        sessionId: 'review-race', type: 'turn.completed', seq: 1,
        turnId: 'review-t1',
        payload: {'response': 'done', 'toolCallCount': 1, 'resultType': 'success'},);
      for (var i = 0; i < 5; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isFalse);

      await store.sendMessage('T2 is still running');
      pushEvent(store,
        sessionId: 'review-race', type: 'turn.started', seq: 2,
        turnId: 'review-t2',
        payload: {'messageId': 'review-u2', 'input': 'T2 is still running'},);
      expect(store.isStreaming, isTrue);
      expect(store.isWaitingForResponse, isTrue);

      // read 返回它在 T1 结束时采样的 idle；确认发起时的代次已在
      // read 前捕获，返回时代次已前进（T2）——只做数据合并，绝不收尾
      oldIdle.complete({'projection': {'status': 'idle'}});
      for (var i = 0; i < 5; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isTrue,
        reason: 'T2 未结束，迟到的 T1 idle 响应不能使其变成空闲',);
      expect(store.isWaitingForResponse, isTrue);
    });
  });

  group('P2-2 恢复旗标（2026-09-19 二轮评审 P2）', () {
    test('openSession 恢复在途 sessionRestoring=true，结束后=false', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);

      // 挂起 resume：有缓存秒开内容时 sessionOpening 派生态为 false，
      // 恢复在途的信号只能来自显式旗标
      final resumeGate = Completer<void>();
      fake.handlers['session/resume'] = (_) async {
        await resumeGate.future;
        return {
          'projection': {'status': 'idle'},
          'messages': [],
          'session': {'sessionId': 'session-restore'},
        };
      };
      final opening = store.openSession('session-restore');
      await Future<void>.delayed(Duration.zero);
      expect(
        store.sessionRestoring,
        isTrue,
        reason: 'resume 在途：排队自动冲队必须等待',
      );

      resumeGate.complete();
      await opening;
      expect(
        store.sessionRestoring,
        isFalse,
        reason: '恢复结束：权威运行状态已就位，冲队恢复',
      );
    });
  });

  group('P2-3 AskUser 队列轮转与来源标注（2026-09-19 二轮评审）', () {
    Future<dynamic> injectAskUser(
      ZcodeChatStore store, {
      required String id,
      required String sessionId,
      required String option,
    }) {
      return store.ingestReverseRequest(
        ZcodeFrame(
          id: 'review-$id',
          method: 'interaction/askUser',
          params: {
            'questionId': id,
            'sessionId': sessionId,
            'question': '$id question',
            'multiSelect': true,
            'options': [
              {'label': option, 'description': ''},
            ],
          },
        ),
      );
    }

    testWidgets('轮转后不得把上一题的已选项提交给下一题', (tester) async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore.instance;
      store.attach(fake, desktopId: 'review-node', desktopName: 'Review node');
      addTearDown(store.detach);

      final answerA = injectAskUser(
        store, id: 'qa', sessionId: 'review-a', option: 'A-only',);
      final answerB = injectAskUser(
        store, id: 'qb', sessionId: 'review-b', option: 'B-only',);

      // 与 home_page 相同的无 key 用法：bar 自身的 didUpdateWidget 换题
      // 清态必须兜住（key 只是调用方的双保险）
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
          home: Scaffold(
            body: AnimatedBuilder(
              animation: store,
              builder: (context, _) => SingleChildScrollView(
                child: Column(
                  children: [
                    if (store.activeAskUser != null)
                      AskUserBar(question: store.activeAskUser!),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.text('qa question'), findsOneWidget);
      await tester.tap(find.text('A-only'));
      await tester.pump();
      await tester.tap(find.text('提交 (1)'));
      await tester.pump();
      expect((await answerA as Map)['selectedLabels'], ['A-only']);
      expect(find.text('qb question'), findsOneWidget);

      // B 未做任何选择：不得出现上一题遗留的「提交 (1)」
      expect(find.text('提交 (1)'), findsNothing,
        reason: 'B 初始未选择，A 的已选项不得遗留到 B',);
      store.respondToAskUser('qb', []);
      await tester.pump();
      final b = await answerB as Map;
      expect(b['selectedLabels'], isNot(contains('A-only')));
    });

    testWidgets('权限条标注非当前会话的来源，当前会话不标注', (tester) async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore.instance;
      store.attach(fake, desktopId: 'review-node', desktopName: 'Review node');
      addTearDown(store.detach);
      fake.handlers['session/list'] = (_) => {
            'sessions': [
              {
                'sessionId': 'session-a',
                'title': 'Alpha',
                'updatedAt': 1,
              },
              {
                'sessionId': 'session-b',
                'title': 'Beta',
                'updatedAt': 2,
              },
            ],
          };
      await store.refreshSessions();
      await store.openSession('session-a');

      Widget barFor(String sessionId) => MaterialApp(
            theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
            home: Scaffold(
              body: PermissionBar(
                request: PermissionRequest(
                  toolCallId: 'call-$sessionId',
                  toolName: 'Bash',
                  input: {'command': 'echo hi'},
                  sessionId: sessionId,
                ),
              ),
            ),
          );

      // B 会话的请求显示在 A 的视口：必须可见来源
      await tester.pumpWidget(barFor('session-b'));
      expect(find.textContaining('来自会话「Beta」'), findsOneWidget);

      // 当前会话自己的请求：无需标注
      await tester.pumpWidget(barFor('session-a'));
      expect(find.textContaining('来自'), findsNothing);
    });
  });

  group('#12 模型选中会话级归属', () {
    test('后台会话的 model.current 补丁不串活动会话视口', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-a').status = 'idle';
      server.session('session-b').status = 'idle';
      fake.handlers['session/resume'] = (params) {
        final s = server.session(params!['sessionId'] as String);
        final model = s.id == 'session-a'
            ? {'current': {'providerId': 'p', 'modelId': 'model-a'}}
            : {'current': {'providerId': 'p', 'modelId': 'model-b'}};
        return {
          'projection': {'status': s.status},
          'messages': [],
          'settings': {'model': model},
        };
      };
      final store = pairedStore(fake);

      await store.openSession('session-a');
      expect(store.currentModelRef, 'p/model-a');
      await store.openSession('session-b');
      expect(store.currentModelRef, 'p/model-b');

      // 回到 A：B 的选中不跟随
      await store.openSession('session-a');
      expect(store.currentModelRef, 'p/model-a');
    });

    test('后台会话的 state.updated 模型补丁只写自己的容器', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('session-a');
      await store.openSession('session-b');
      await store.openSession('session-a');
      expect(store.currentModelRef, isNull);

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'session-b',
            'patch': {
              'model': {
                'current': {'providerId': 'p', 'modelId': 'model-bg'},
              },
            },
          },
        ),
      );

      expect(store.currentModelRef, isNull, reason: 'B 在后台，A 视口不变');
      await store.openSession('session-b');
      expect(store.currentModelRef, 'p/model-bg');
    });
  });
}
