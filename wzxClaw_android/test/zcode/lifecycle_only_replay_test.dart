// ============================================================
// lifecycle_only_replay_test — 最坏重连：只回放生命周期事件（零输入）
//
// 引擎实测（probe-replay-toolinput / 源码 server-operations.ts）：
// 回合进行中 eventStore 不含工具事件；subscribe 不带 afterSeq 回放恒空；
// 回合结束后日志按 slice(-limit) 取最新 N 条——早于窗口的工具只剩
// scheduled（inputOmitted，无输入）。本测试模拟这种「只有生命周期
// 事件可用」的重连，钉死权威合并必须把无输入行救回来。
// ============================================================

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final fixtureFile = File('test/zcode/reconnect_replay_fixture.json');
  final fixture = jsonDecode(fixtureFile.readAsStringSync()) as Map<String, dynamic>;
  final sessionId = fixture['sessionId'] as String;
  final events = (fixture['events'] as List).cast<Map<String, dynamic>>();
  final messages = (fixture['messages'] as List).cast<Map<String, dynamic>>();

  // 最坏切片：丢掉全部 model.streaming（tool_input/tool_call 全缺失），
  // 只留生命周期与回合边界——scheduled 无输入、无 delta。
  final lifecycleOnly = events
      .where((ev) => (ev['type'] as String?) != 'model.streaming')
      .toList();
  var scheduledCount = 0;
  for (final ev in lifecycleOnly) {
    if (ev['type'] == 'tool.updated' && (ev['payload'] ?? {})['kind'] == 'scheduled') {
      scheduledCount++;
    }
  }

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(fake, desktopId: 'desktop-1', desktopName: '办公室电脑');
    return store;
  }

  test('生命周期回放 + 权威刷新：不允许残留无输入工具行', () async {
    expect(
      scheduledCount,
      greaterThanOrEqualTo(4),
      reason: '夹具应含 scheduled 生命周期事件，否则切片无效',
    );

    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    fake.handlers['session/messages'] = (_) => {'messages': messages};
    final store = fedStore(fake);

    await store.openSession(sessionId);

    for (final ev in lifecycleOnly) {
      store.ingestNotifyFrame(
        ZcodeFrame(method: 'session/event', params: ev),
      );
    }
    await store.refreshActiveSessionSnapshot();

    final problems = <String>[];
    for (final msg in store.messages) {
      for (final part in msg.processParts) {
        final tool = part.toolCall;
        if (tool == null) continue;
        if (tool.inputSummary == null || tool.inputSummary!.isEmpty) {
          problems.add('${tool.toolName}(${tool.toolCallId}) '
              'lifecycle=${tool.lifecycle} status=${tool.status}');
        }
      }
    }
    expect(
      problems,
      isEmpty,
      reason: '以下工具行经权威刷新后输入仍为空（渲染层「输入未捕获」）：\n'
          '${problems.join('\n')}',
    );
  });
}
