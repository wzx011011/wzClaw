// GoalStore 回归：快照事件驱动 + 断连清空 + 主动刷新
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/connection_state.dart';
import 'package:wzxclaw_android/models/goal_snapshot.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/goal_store.dart';
import 'package:wzxclaw_android/services/ws_transport.dart';
import 'package:wzxclaw_android/services/zcode_protocol_translate.dart';

import '../harness/sync_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('goal 快照事件驱动状态更新并触发线程拉取', () async {
    final transport = FakeWsTransport();
    var threadsFetched = 0;
    final store = GoalStore(transport: transport)
      ..fetchThreadsHook = () async {
        threadsFetched++;
        return [
          const SubagentThread(agent: 'general-purpose', messages: []),
        ];
      };

    // 快照事件（进程内广播，snapshot 为已解析对象）
    transport.pumpFromDesktop(WsEvents.goalSnapshot, {
      'sessionId': 's1',
      'snapshot': parseGoalSnapshot({
        'todos': [
          {'content': 't1', 'status': 'in_progress'},
        ],
        'todoGroups': [
          {
            'id': 'g1',
            'source': 'session',
            'todos': [
              {'content': 't1', 'status': 'in_progress'},
            ],
          },
        ],
        'goalStats': {'toolCallCount': 3},
      }),
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(store.snapshot.todos.single.content, 't1');
    expect(store.snapshot.stats?.toolCallCount, 3);
    expect(threadsFetched, 1);
    expect(store.threads.single.agent, 'general-purpose');

    // 非目标事件不触发
    transport.pumpFromDesktop(WsEvents.pong, {});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(threadsFetched, 1);
  });

  test('断连清空快照与子线程', () async {
    final transport = FakeWsTransport();
    final store = GoalStore(transport: transport)
      ..fetchThreadsHook = () async => const [];

    transport.pumpFromDesktop(WsEvents.goalSnapshot, {
      'snapshot': parseGoalSnapshot({
        'todos': [
          {'content': 't1', 'status': 'pending'},
        ],
      }),
    });
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(store.snapshot.isEmpty, false);

    transport.setState(WsConnectionState.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(store.snapshot.isEmpty, true);
    expect(store.threads.isEmpty, true);
  });

  test('refresh() 用活跃会话拉快照与线程', () async {
    final transport = FakeWsTransport();
    final requested = <String>[];
    var threadsFetched = 0;
    final store = GoalStore(transport: transport);
    store.activeSessionHook = () => 'sess-42';
    store.refreshSnapshotHook = (sid) async {
      requested.add(sid);
    };
    store.fetchThreadsHook = () async {
      threadsFetched++;
      return const [];
    };

    await store.refresh();
    expect(requested, ['sess-42']);
    expect(threadsFetched, 1);

    // 无活跃会话：只拉线程
    store.activeSessionHook = () => null;
    await store.refresh();
    expect(requested, ['sess-42']);
    expect(threadsFetched, 2);
  });
}
