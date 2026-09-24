// ============================================================
// reconnect_recovery_test — 断线重连恢复链路（「输入未捕获」回归锚）
//
// 复现 2026-09-23 截图事故的完整链路：活流中途失联（turn.completed
// 落在缺口里）→ 重连（引擎回放为空：回合中 eventStore 不落工具事件）
// → 靠无条件回合确认（session/read=idle）触发权威刷新收尾 → 滞留的
// 无输入行被权威 part 治平。
//
// 契约锚点：
// 1. session/subscribe 请求必须带 afterSeq（引擎回放闸，缺省恒空回放）；
// 2. 重连后流式会话一律做回合确认，不以水位变化为前提；
// 3. 确认/刷新后不允许残留无输入工具行。
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
  final allEvents = (fixture['events'] as List).cast<Map<String, dynamic>>();
  final messages = (fixture['messages'] as List).cast<Map<String, dynamic>>();

  // 活流切片：截到第一个工具的 tool_call（输入刚流完）——模拟此刻失联
  var cutIndex = 0;
  for (var i = 0; i < allEvents.length; i++) {
    final ev = allEvents[i];
    if (ev['type'] == 'model.streaming' &&
        (ev['payload'] ?? {})['kind'] == 'tool_call') {
      cutIndex = i;
      break;
    }
  }
  final liveFrames = allEvents.take(cutIndex + 1).toList();

  Future<void> drain() async {
    for (var i = 0; i < 100; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
  }

  test('重连恢复链路：订阅带 afterSeq + 无条件回合确认 + 权威治愈', () async {
    final fake = FakeZcodeRelayClient();
    final subscribeCalls = <Map<String, dynamic>>[];
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    fake.handlers['session/subscribe'] = (params) {
      if (params != null) subscribeCalls.add(params);
      // 引擎实测：回合中 eventStore 不落工具事件 → 回放为空
      return {'eventSeq': 0, 'events': []};
    };
    fake.handlers['session/events'] = (_) => {'events': []};
    // 回合确认读到的 idle（引擎侧回合其实已结束）
    fake.handlers['session/read'] = (_) => {
          'projection': {'status': 'idle'},
          'runtime': {'eventSeq': allEvents.length},
        };
    fake.handlers['session/messages'] = (_) => {'messages': messages};
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(fake, desktopId: 'desktop-1', desktopName: '办公室电脑');

    await store.openSession(sessionId);
    expect(store.isStreaming, isFalse);

    // 活流：工具输入刚流完就失联（turn.completed 永远到不了）
    for (final ev in liveFrames) {
      store.ingestNotifyFrame(
        ZcodeFrame(method: 'session/event', params: ev),
      );
    }
    expect(store.isStreaming, isTrue, reason: '切片应落在回合中途');

    // 断线 → 重连（触发 _resubscribeAll）
    store.ingestRelayState(ZcodeRelayState.waiting, false);
    store.ingestRelayState(ZcodeRelayState.matched, true);
    await drain();

    // 契约 1：订阅请求带 afterSeq（引擎回放闸）
    expect(subscribeCalls, isNotEmpty);
    expect(
      subscribeCalls.last['afterSeq'],
      isNotNull,
      reason: '订阅缺 afterSeq 时引擎直接回空 events（回放闸在此参数）',
    );

    // 契约 2：回合确认触发过（session/read），收尾刷新触发过（session/messages）
    expect(
      fake.requests.map((e) => e.key),
      containsAll(<String>['session/read', 'session/messages']),
    );
    expect(store.isStreaming, isFalse, reason: '确认到 idle 后流式态应解除');

    // 契约 3：治愈完成——任何工具行都不允许输入为空
    final problems = <String>[];
    for (final msg in store.messages) {
      for (final part in msg.processParts) {
        final tool = part.toolCall;
        if (tool == null) continue;
        if (tool.inputSummary == null || tool.inputSummary!.isEmpty) {
          problems.add('${tool.toolName}(${tool.toolCallId})');
        }
      }
    }
    expect(
      problems,
      isEmpty,
      reason: '重连治愈后仍有无输入工具行（渲染层「输入未捕获」）：\n'
          '${problems.join('\n')}',
    );
  });
}
