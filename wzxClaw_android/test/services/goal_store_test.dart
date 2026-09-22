// ============================================================
// goal_store_test — 目标面板「回合驱动自动刷新」契约
//
// 面板文案承诺「会话运行中会自动更新」：GoalStore 必须订阅聊天容器、
// 在回合边界（isStreaming 翻转）自动拉取 session/goal 快照，
// 而不是只在面板打开/手动下拉时才刷新。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/services/goal_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import '../zcode/zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  test('回合边界（isStreaming 翻转）自动拉取 goal 快照并更新面板数据', () async {
    final fake = FakeZcodeRelayClient();
    FakeSessionServer().bind(fake);
    final chat = pairedStore(fake);
    await chat.openSession('sess-goal');

    var goalCalls = 0;
    fake.handlers['session/goal'] = (params) {
      goalCalls++;
      return {
        'snapshot': {
          'todos': [
            {'content': '任务一', 'status': 'in_progress', 'priority': 'high'},
          ],
          'todoGroups': [],
        },
      };
    };
    // 柱5：刷新周期包含 session/subagents（all-or-nothing），缺处理器
    // 会让整个周期判失败、快照不落地
    fake.handlers['session/subagents'] = (_) => {
          'running': [],
          'ended': {'total': 0, 'items': []},
        };

    final goalStore = GoalStore(chatStore: chat);
    addTearDown(goalStore.dispose);
    await Future<void>.delayed(Duration.zero);
    final callsBeforeBoundary = goalCalls;

    // 回合开始（turn.started → isStreaming true）：翻转触发刷新
    pushEvent(
      chat,
      sessionId: 'sess-goal',
      type: 'turn.started',
      seq: 1,
      turnId: 'turn-1',
      payload: {'messageId': 'u1', 'input': 'hi'},
    );
    await Future<void>.delayed(Duration.zero);
    expect(
      goalCalls,
      greaterThan(callsBeforeBoundary),
      reason: '回合开始边界必须自动刷新，面板「运行中会自动更新」才成立',
    );
    expect(goalStore.snapshot.todos.first.content, '任务一');

    // 同一回合内的普通增量帧（isStreaming 已是 true）：不得重复刷
    final callsAfterStart = goalCalls;
    pushEvent(
      chat,
      sessionId: 'sess-goal',
      type: 'model.streaming',
      seq: 2,
      turnId: 'turn-1',
      payload: {'kind': 'text_delta', 'delta': 'hello'},
    );
    await Future<void>.delayed(Duration.zero);
    expect(goalCalls, callsAfterStart, reason: '非边界帧不触发刷新');

    // 回合结束（isStreaming true → false）：再次翻转刷新
    pushEvent(
      chat,
      sessionId: 'sess-goal',
      type: 'turn.completed',
      seq: 3,
      turnId: 'turn-1',
      payload: {'resultType': 'success'},
    );
    await Future<void>.delayed(Duration.zero);
    expect(goalCalls, greaterThan(callsAfterStart), reason: '回合结束边界必须自动刷新');
  });

  test('无活动会话时回合边界刷新安全（清空快照，不抛错）', () async {
    final fake = FakeZcodeRelayClient();
    FakeSessionServer().bind(fake);
    final chat = pairedStore(fake);
    // 不 openSession：activeSessionId 为 null
    final goalStore = GoalStore(chatStore: chat);
    addTearDown(goalStore.dispose);

    pushEvent(
      chat,
      sessionId: 'sess-elsewhere',
      type: 'turn.started',
      seq: 1,
      turnId: 'turn-1',
      payload: {},
    );
    await Future<void>.delayed(Duration.zero);
    expect(goalStore.snapshot.isEmpty, isTrue);
    expect(goalStore.loading, isFalse);
  });


  group('柱5 数据三态与触发扩容', () {
    test('刷新失败保留旧快照并显式 failed（不静默清空）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final chat = pairedStore(fake);
      await chat.openSession('sess-goal');
      var fail = false;
      fake.handlers['session/goal'] = (params) {
        if (fail) throw Exception('rpc dead');
        return {
          'snapshot': {
            'todos': [
              {'content': '旧目标', 'status': 'in_progress', 'priority': 'high'},
            ],
            'todoGroups': [],
          },
        };
      };
      fake.handlers['session/subagents'] = (_) => {
            'running': [],
            'ended': {
              'total': 1,
              'items': [
                {
                  'childSessionId': 'c1',
                  'subagentType': 'Explore',
                  'status': 'success',
                  'summary': '旧结论',
                },
              ],
            },
          };

      final goalStore = GoalStore(chatStore: chat);
      addTearDown(goalStore.dispose);
      await goalStore.refresh();
      expect(goalStore.phase, GoalLoadPhase.ready);
      expect(goalStore.snapshot.todos.single.content, '旧目标');
      expect(goalStore.threads.single.messages.single['content'], '旧结论');

      fail = true;
      await goalStore.refresh();

      expect(goalStore.phase, GoalLoadPhase.failed, reason: '失败必须显式可见');
      expect(goalStore.lastError, isNotNull);
      expect(
        goalStore.snapshot.todos.single.content,
        '旧目标',
        reason: '失败保留旧数据（stale-but-labeled），绝不静默清空',
      );
      expect(goalStore.threads, hasLength(1), reason: '子代理线程同样保留');
      expect(goalStore.lastSuccessAt, isNotNull);
    });

    test('重连恢复（connState matched 边沿）触发刷新', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final chat = pairedStore(fake);
      await chat.openSession('sess-goal');
      var goalCalls = 0;
      fake.handlers['session/goal'] = (params) {
        goalCalls++;
        return {
          'snapshot': {'todos': [], 'todoGroups': []},
        };
      };
      fake.handlers['session/subagents'] = (_) => {
            'running': [],
            'ended': {'total': 0, 'items': []},
          };

      final goalStore = GoalStore(chatStore: chat);
      addTearDown(goalStore.dispose);
      await Future<void>.delayed(Duration.zero);

      // 隧道断（connState 离开 matched）再恢复：恢复边沿必须刷新面板
      chat.ingestRelayState(ZcodeRelayState.closed, false);
      await Future<void>.delayed(Duration.zero);
      final callsWhileDown = goalCalls;
      chat.ingestRelayState(ZcodeRelayState.matched, true);
      await Future<void>.delayed(Duration.zero);

      expect(
        goalCalls,
        greaterThan(callsWhileDown),
        reason: '链路恢复即对账面板数据（frpc 僵死恢复场景）',
      );
    });
  });
}
