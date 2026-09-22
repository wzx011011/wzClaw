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
}
