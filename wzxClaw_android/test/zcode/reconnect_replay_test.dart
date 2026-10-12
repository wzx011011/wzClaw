// ============================================================
// reconnect_replay_test — 断线重连全量回放：工具输入不得丢失
//
// 夹具来自 probe 对本机 app-server 的实抓（回合结束后 session/events
// afterSeq=0 全量 113 条 + session/messages 尾窗 7 条）——即手机断线
// 重连后引擎能补给它的全部数据。按序喂进 ZcodeChatStore（回放 →
// 权威刷新），钉死契约：任何重连路径回放后，不允许出现输入为空的
// 工具行（渲染层「输入未捕获」）。
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

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(fake, desktopId: 'desktop-1', desktopName: '办公室电脑');
    return store;
  }

  test('重连全量回放（事件日志 + 权威刷新）：工具行输入全部非空', () async {
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

    // 全量事件回放（includeSnapshot/afterSeq 拉取形态）
    for (final ev in events) {
      store.ingestNotifyFrame(
        ZcodeFrame(method: 'session/event', params: ev),
      );
    }
    // 权威刷新（回合收尾/看门狗都会拉）
    // —— 由 handlers['session/messages'] 承载，这里手动触发一轮：
    //    发一条空事件后等待 store 的刷新调度不现实，直接用
    //    store 的权威拉取入口（refreshActiveSessionSnapshot）。
    await store.refreshActiveSessionSnapshot();

    final problems = <String>[];
    var toolCount = 0;
    for (final msg in store.messages) {
      for (final part in msg.processParts) {
        final tool = part.toolCall;
        if (tool == null) continue;
        toolCount++;
        if (tool.inputSummary == null || tool.inputSummary!.isEmpty) {
          problems.add('${tool.toolName}(${tool.toolCallId}) '
              'lifecycle=${tool.lifecycle} status=${tool.status}');
        }
      }
    }
    expect(
      toolCount,
      greaterThanOrEqualTo(5),
      reason: '夹具含 5 个权威工具 part，回放后行数不应缩水',
    );
    expect(
      problems,
      isEmpty,
      reason: '以下工具行输入为空（渲染层显示「输入未捕获」）：\n'
          '${problems.join('\n')}',
    );
  });
}
