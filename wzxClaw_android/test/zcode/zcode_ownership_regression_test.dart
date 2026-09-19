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
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';
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

  group('P1-1 引擎代次与物化失效（2026-09-19 三轮审查）', () {
    test('引擎换代通知：作废物化/订阅并清理流式状态，重开重新 resume', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-live').status = 'running';
      final store = pairedStore(fake);
      await store.openSession('session-live');
      expect(store.isStreaming, isTrue);
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;

      // companion：spawn 推 gen=1（首见，仅记录），respawn 推 gen=2（换代）
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'x/engine/generation',
          params: {'generation': 1},
        ),
      );
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'x/engine/generation',
          params: {'generation': 2},
        ),
      );
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(store.isStreaming, isFalse, reason: '换代必须清理旧引擎流式状态');
      await store.openSession('session-live');
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        greaterThan(resumesBefore),
        reason: '换代后重开必须重新 resume（不得沿用旧物化标记）',
      );
    });

    test('换代通知首见不误作废：重开不重复 resume', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-a').status = 'idle';
      final store = pairedStore(fake);
      await store.openSession('session-a');
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'x/engine/generation',
          params: {'generation': 1},
        ),
      );
      await store.openSession('session-a');
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        resumesBefore,
        reason: '首见代次只记录；物化仍有效时重开走 read 探测，不重复 resume',
      );
    });

    test('物化标记遗留兜底：read 探测失败自动补 resume（通知丢失场景）', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-a').status = 'idle';
      final store = pairedStore(fake);
      await store.openSession('session-a');
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;

      // 模拟引擎已换而通知丢失：read 探测失败 → 必须补 resume 而不是
      // 带着死物化标记继续拉事件
      fake.handlers['session/read'] = (_) =>
          throw const ZcodeRequestException(-32002, 'session not active');
      await store.openSession('session-a');
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        greaterThan(resumesBefore),
        reason: 'read 探测失败必须降级重走 resume',
      );
    });

    test('close 成功后作废物化：重开会话重新 resume', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-a').status = 'idle';
      final store = pairedStore(fake);
      await store.openSession('session-a');
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;

      await store.closeSession('session-a');
      await store.openSession('session-a');
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        greaterThan(resumesBefore),
        reason: 'close 已释放会话，重开必须重新 resume（不得跳过激活）',
      );
    });

    test('降级轮询被占用（-32004）：停止轮询且不重新物化，置占用标记', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-live').status = 'running';
      fake.handlers['session/subscribe'] = (_) =>
          throw const ZcodeRequestException(-32602, 'subscribe unavailable');
      final store = pairedStore(fake);
      await store.openSession('session-live');
      // 订阅失败 → 降级轮询已启动
      expect(
        fake.requests.any((r) => r.key == 'session/events'),
        isTrue,
        reason: '订阅失败必须降级轮询',
      );

      // 轮询遇 -32004：停止且不得 resume 抢占用
      fake.handlers['session/events'] = (_) =>
          throw const ZcodeRequestException(-32004, 'active elsewhere');
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;
      await Future<void>.delayed(const Duration(milliseconds: 2600));
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        resumesBefore,
        reason: '-32004 是运行时单归属，不得重新物化抢占用',
      );
      expect(store.remoteActiveElsewhere, isTrue);
    });

    test('降级轮询连续失败：达阈值自动重新物化（resume→订阅→权威刷新）', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-live').status = 'running';
      fake.handlers['session/subscribe'] = (_) =>
          throw const ZcodeRequestException(-32602, 'subscribe unavailable');
      final store = pairedStore(fake);
      await store.openSession('session-live');
      final resumesBefore =
          fake.requests.where((r) => r.key == 'session/resume').length;

      // 普通故障连续 3 次（间隔 1.2s）→ 触发重新物化
      fake.handlers['session/events'] = (_) =>
          throw const ZcodeRequestException(-32000, 'engine gone');
      await Future<void>.delayed(const Duration(milliseconds: 4200));
      expect(
        fake.requests.where((r) => r.key == 'session/resume').length,
        greaterThan(resumesBefore),
        reason: '轮询连续失败不得无限静默重试，必须自动重新物化',
      );
    });
  });

  group('P1-3 发送三态与回合身份（2026-09-19 三轮审查）', () {
    test('发送超时（结果未知）+ 服务端 running：保持流式并提示，不宣布失败', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-unk').status = 'running';
      fake.handlers['session/send'] = (_, [__]) =>
          throw TimeoutException('请求超时', const Duration(seconds: 30));
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('session-unk');
      await store.sendMessage('继续的任务');
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(
        fake.requests.any((r) => r.key == 'session/read'),
        isTrue,
        reason: '超时不是拒绝：必须先读权威状态',
      );
      expect(store.isStreaming, isTrue, reason: '服务端 running = 回合已被接受');
      expect(store.error, isNull, reason: '不得向用户表达失败');
    });

    test('发送超时（结果未知）+ 服务端 idle：权威刷新收敛收尾', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('session-unk').status = 'idle';
      fake.handlers['session/send'] = (_, [__]) =>
          throw TimeoutException('请求超时', const Duration(seconds: 30));
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('session-unk');
      await store.sendMessage('已结束的任务');
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(store.isStreaming, isFalse, reason: '服务端 idle = 以权威真相收尾');
      expect(store.error, isNull, reason: '结果未知不等于失败');
    });

    test('发送被明确拒绝（错误帧）：才走失败路径', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      fake.handlers['session/send'] = (_, [__]) =>
          throw const ZcodeRequestException(-32000, '服务端明确拒绝');
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('session-reject');
      await store.sendMessage('会被拒绝');
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(store.isStreaming, isFalse, reason: '明确拒绝必须收尾');
      expect(store.error, isNotNull);
    });

    test('T1 迟到的 turn.completed 在 T2 在途时只补数据，不终结 T2', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('session-late');
      await store.sendMessage('T1');
      pushEvent(store,
        sessionId: 'session-late', type: 'turn.started', seq: 1,
        turnId: 'turn-t1',
        payload: {'messageId': 'user-t1', 'input': 'T1'},);
      await store.sendMessage('T2');
      pushEvent(store,
        sessionId: 'session-late', type: 'turn.started', seq: 2,
        turnId: 'turn-t2',
        payload: {'messageId': 'user-t2', 'input': 'T2'},);
      expect(store.isStreaming, isTrue);

      // T1 的完成迟到（T2 在途）：只允许补权威数据
      pushEvent(store,
        sessionId: 'session-late', type: 'turn.completed', seq: 3,
        turnId: 'turn-t1',
        payload: {'response': 'T1 done', 'toolCallCount': 0, 'resultType': 'success'},);
      for (var i = 0; i < 8; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isTrue, reason: '迟到的 T1 终态不得终结 T2');

      // T2 自己的完成：正常收尾（正向路径不受护栏影响）
      pushEvent(store,
        sessionId: 'session-late', type: 'turn.completed', seq: 4,
        turnId: 'turn-t2',
        payload: {'response': 'T2 done', 'toolCallCount': 0, 'resultType': 'success'},);
      for (var i = 0; i < 8; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(store.isStreaming, isFalse);
      expect(notifier.shown, hasLength(1), reason: 'T1 迟到终态不得重复通知');
    });
  });

  group('P1-4 时间线收口与流式稳定身份（2026-09-19 三轮审查）', () {
    test('流式中加载历史：model.response 重对不污染旧消息', () async {
      final cache = FakeZcodeSessionCache();
      cache.messages['sess-shift'] = [
        for (var i = 0; i < 100; i++)
          ZcodeSessionItem(
            protoId: 'h$i',
            message: ChatMessage(
              role: MessageRole.user,
              processParts: [ChatProcessPart.text('历史 $i')],
              createdAt: DateTime.fromMillisecondsSinceEpoch(i),
            ),
          ),
      ];
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore(cache: cache)
        ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
      addTearDown(store.dispose);
      await store.openSession('sess-shift');
      expect(store.messages, hasLength(80)); // 缓存尾窗

      await store.sendMessage('正在回答');
      expect(store.isStreaming, isTrue);

      // 流式中上滑加载 20 条历史：占位下标必须平移
      final added = await store.loadOlderMessages(limit: 40);
      expect(added, 20);
      // 80 尾窗 + 20 历史 + 发送乐观追加的 user/占位 2 条
      expect(store.messages, hasLength(102));

      // 权威全文重对：必须落在流式占位上，而不是平移前的旧下标行
      pushEvent(store,
        sessionId: 'sess-shift', type: 'model.response', seq: 1,
        payload: {'content': '全文回答'},);
      await Future<void>.delayed(Duration.zero);

      final polluted = store.messages
          .where((m) => (m.text).contains('全文回答'))
          .length;
      expect(polluted, 1, reason: '全文只允许出现在流式占位行');
      expect(store.messages.first.text, '历史 0', reason: '头部历史不得被改写');
      expect(store.messages.last.text, contains('全文回答'));
    });
  });

  group('P2-10 截断缓存联网补齐（2026-09-19 三轮审查）', () {
    test('openSession 检测截断项：按锚点回拉权威内容原位替换', () async {
      final cache = FakeZcodeSessionCache();
      cache.messages['sess-trunc'] = [
        ZcodeSessionItem(
          protoId: 'm-1',
          synced: true,
          dirty: false,
          truncated: true, // 本地副本被截断（身份仍确认）
          message: ChatMessage(
            role: MessageRole.assistant,
            processParts: const [ChatProcessPart.text('截断的短文…（缓存已截断）')],
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
          ),
        ),
        ZcodeSessionItem(
          protoId: 'm-2',
          synced: true,
          dirty: false,
          message: ChatMessage(
            role: MessageRole.user,
            processParts: const [ChatProcessPart.text('后继消息')],
            createdAt: DateTime.fromMillisecondsSinceEpoch(2000),
          ),
        ),
      ];
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      // 尾窗/补齐共用 session/messages：以 limit 签名区分（补齐 = count+8）
      final backfillAnchors = <Object?>[];
      fake.handlers['session/messages'] = (params) {
        if (params?['limit'] == 9) {
          backfillAnchors.add(params?['afterMessageId']);
          return {
            'messages': [
              fakeMsg(
                'assistant',
                [
                  {'type': 'text', 'text': '完整正文（联网补齐后的权威内容）'},
                ],
                id: 'm-1',
                created: 1000,
              ),
            ],
          };
        }
        return {'messages': []};
      };
      final store = ZcodeChatStore(cache: cache)
        ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
      addTearDown(store.dispose);
      await store.openSession('sess-trunc');
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(backfillAnchors, hasLength(1), reason: '恰好一次补齐回拉');
      expect(
        backfillAnchors.single,
        isNull,
        reason: '第一条截断项位于时间线头部：无前项锚点，必须从头回拉',
      );
      expect(
        store.messages.first.text,
        contains('完整正文'),
        reason: '截断副本必须被权威内容原位替换',
      );
    });
  });

  group('阶段2 上下文容量快照解析（0.16.9 contextUsage，OQ1 定论）', () {
    test('state.updated contextUsage：解析为容量快照字段', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('ctx-a');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'ctx-a',
            'patch': {
              'status': 'idle',
              'contextUsage': {
                'used': 71000,
                'size': 1000000,
                'cache': {'hitRate': 0.943},
                'breakdown': [
                  {'source': 'system_tool_schemas', 'chars': 614},
                  {'source': 'messages', 'chars': 301},
                  {'source': 'skills', 'chars': 22},
                ],
              },
            },
          },
        ),
      );

      final cu = store.activeContextUsage;
      expect(cu, isNotNull, reason: '快照带 contextUsage 时必须解析');
      expect(cu!.used, 71000);
      expect(cu.size, 1000000);
      expect(cu.cacheHitRate, closeTo(0.943, 1e-9));
      expect(cu.breakdown, hasLength(3));
      expect(cu.breakdown.first.source, 'system_tool_schemas');
      expect(cu.breakdown.first.chars, 614);
    });

    test('空闲快照（无 contextUsage）：字段保留不误清', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('ctx-b');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'ctx-b',
            'patch': {
              'status': 'idle',
              'contextUsage': {
                'used': 100,
                'size': 1000,
                'breakdown': [],
              },
            },
          },
        ),
      );
      expect(store.activeContextUsage, isNotNull);

      // 后续空闲快照不带该字段（optional）：不得误清已有快照
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'ctx-b',
            'patch': {'status': 'running'},
          },
        ),
      );
      expect(store.activeContextUsage, isNotNull, reason: '缺字段不覆盖');
    });
  });

  group('阶段2 后台任务徽章（0.16.9 backgroundJobs 投影）', () {
    test('state.updated backgroundJobs：整体替换投影并按状态过滤运行中', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('bg-a');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'bg-a',
            'patch': {
              'backgroundJobs': [
                {
                  'taskId': 'task-1',
                  'kind': 'bash',
                  'status': 'running',
                  'command': 'npm run build',
                  'cancellable': true,
                },
                {
                  'taskId': 'task-2',
                  'kind': 'subagent',
                  'status': 'completed',
                },
              ],
            },
          },
        ),
      );

      expect(store.activeBackgroundJobs, hasLength(2));
      expect(store.activeBackgroundJobs.first['taskId'], 'task-1');
      final running = store.activeBackgroundJobs
          .where((j) => j['status'] == 'running')
          .toList();
      expect(running, hasLength(1), reason: '徽章计数只取运行中任务');
      expect(running.single['kind'], 'bash');
    });

    test('后续快照 backgroundJobs 缺失：整体替换语义保留旧值直至新投影', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('bg-b');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'bg-b',
            'patch': {
              'backgroundJobs': [
                {'taskId': 't', 'kind': 'workflow', 'status': 'running'},
              ],
            },
          },
        ),
      );
      expect(store.activeBackgroundJobs, hasLength(1));

      // 无 backgroundJobs 键的补丁：不覆盖（整体替换只在字段出现时发生）
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'bg-b',
            'patch': {'status': 'running'},
          },
        ),
      );
      expect(store.activeBackgroundJobs, hasLength(1));
    });
  });

  group('阶段3b 调用轨迹（session/debug 进程内快照）', () {
    test('debugRounds：解析 rounds 元素（0.16.9 实测形状）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('trace-a');
      fake.handlers['session/debug'] = (params) {
        expect(params?['sessionId'], 'trace-a');
        return {
          'sessionId': 'trace-a',
          'rounds': [
            {
              'eventKey': 'ek-1',
              'requestId': 'req-1',
              'requestIndex': 1,
              'recordedAt': 1789816245297,
              'usage': {
                'inputTokens': 17504,
                'outputTokens': 15,
                'totalTokens': 17519,
                'reasoningTokens': 8,
                'cachedInputTokens': 0,
              },
              'hitRate': 0,
              'generationDurationMs': 110,
              'tokensPerSecond': 136.36,
            },
          ],
          'networkEntries': [],
          'cache': null,
        };
      };
      final rounds = await store.debugRounds('trace-a');
      expect(rounds, hasLength(1));
      expect(rounds.single['requestIndex'], 1);
      expect(
        ((rounds.single['usage'] as Map)['inputTokens'] as num).toInt(),
        17504,
      );
    });

    test('debugRounds：无轨迹会话返回空列表（不抛错）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('trace-b');
      fake.handlers['session/debug'] = (params) =>
          {'sessionId': 'trace-b', 'rounds': [], 'networkEntries': [], 'cache': null};
      expect(await store.debugRounds('trace-b'), isEmpty);
    });
  });
}
