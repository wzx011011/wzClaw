// ============================================================
// toolinput_replay_test — 「输入未捕获」根因复现：真实引擎帧序列回放
//
// 夹具来自 probe-toolinput-stream.js 对本机 app-server 的全量抓帧
// （Bash/Read/Write/TodoWrite 多工具回合，web-remote-replayable 订阅）。
// 按原始顺序喂进 ZcodeChatStore，钉死契约：活流里每个工具的
// tool_input_*/tool_call 全量推送，任何逐帧回放后都不允许出现
// 输入为空（渲染层显示「输入未捕获」）的工具行。
// ============================================================

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final fixtureFile = File('test/zcode/toolinput_frames_fixture.json');
  final fixture = jsonDecode(fixtureFile.readAsStringSync()) as Map<String, dynamic>;
  final sessionId = fixture['sessionId'] as String;
  final frames = (fixture['frames'] as List).cast<Map<String, dynamic>>();

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(fake, desktopId: 'desktop-1', desktopName: '办公室电脑');
    return store;
  }

  test('活流全帧回放：每个工具行的 inputSummary 非空', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    // 回合中 tool.updated result/batch 会触发权威刷新；给最小空权威，
    // 让流式投影独立承接全部工具行
    fake.handlers['session/messages'] = (_) => {'messages': []};
    final store = fedStore(fake);

    await store.openSession(sessionId);

    for (final f in frames) {
      store.ingestNotifyFrame(
        ZcodeFrame(method: f['method'] as String, params: f['params']),
      );
    }

    final tools = <({String name, String? id, String? input, String status})>[];
    for (final msg in store.messages) {
      for (final part in msg.processParts) {
        final tool = part.toolCall;
        if (tool == null) continue;
        tools.add((
          name: tool.toolName,
          id: tool.toolCallId,
          input: tool.inputSummary,
          status: tool.status.toString(),
        ),);
      }
    }

    // 探针回合共 7 个工具：Bash×4、Read、Write、TodoWrite
    expect(tools, hasLength(7));
    for (final t in tools) {
      expect(
        t.input,
        isNotNull,
        reason: '工具 ${t.name}(${t.id}) 输入为空 → 渲染层「输入未捕获」',
      );
      expect(
        t.input,
        isNotEmpty,
        reason: '工具 ${t.name}(${t.id}) 输入为空 → 渲染层「输入未捕获」',
      );
    }
  });
}
