// ============================================================
// workflow_display_replay_test — 工作流工具卡两条解析路径契约
//
// 夹具 = probe-workflow.js 真引擎抓帧（2026-10-11）：
// ① live 路径：tool.updated scheduled/started/result 三帧
//    （display 挂 result.display）；
// ② 权威路径：session/messages 的 tool part（display 挂
//    state.metadata.display）。
// 钉死：两条路径都必须产出 workflowName + workflowDisplay，
// 阶段/参与者与引擎原文一致（回归锚：协议漂移必须有声）。
// ============================================================

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final fixtureFile = File('test/zcode/workflow_frames_fixture.json');
  final fixture = jsonDecode(fixtureFile.readAsStringSync()) as Map<String, dynamic>;
  final sessionId = fixture['sessionId'] as String;
  final frames = (fixture['frames'] as List).cast<Map<String, dynamic>>();
  // 断言从夹具派生：夹具=探针真帧原文，引擎起的名字每次 run 可能不同，
  // 钉形状不钉文案
  final expectedName =
      ((fixture['authoritativePart'] as Map<String, dynamic>)['state']
              as Map<String, dynamic>)['input'] is Map
          ? (((fixture['authoritativePart'] as Map<String, dynamic>)['state']
                  as Map<String, dynamic>)['input'] as Map<String, dynamic>)['name']
              as String
          : null;

  ToolCallInfo? findTool(ZcodeChatStore store, String name) {
    for (final msg in store.messages) {
      for (final part in msg.processParts) {
        final tool = part.toolCall;
        if (tool != null && tool.toolName == name) return tool;
      }
    }
    return null;
  }

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(fake, desktopId: 'desktop-1', desktopName: '办公室电脑');
    return store;
  }

  test('live 路径：tool.updated result.display → workflowDisplay + workflowName', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    fake.handlers['session/messages'] = (_) => {'messages': []};
    final store = fedStore(fake);
    await store.openSession(sessionId);

    for (final f in frames) {
      store.ingestNotifyFrame(
        ZcodeFrame(method: f['method'] as String, params: f['params']),
      );
    }

    final tool = findTool(store, 'CreateWorkflow');
    expect(tool, isNotNull);
    expect(tool!.workflowName, expectedName);
    final display = tool.workflowDisplay;
    expect(display, isNotNull);
    expect(display!.ok, isTrue);
    expect(display.causalityGraph!.phases.single.name, 'smoke');
    expect(display.causalityGraph!.lanes.single.name, 'smoke-worker');
  });

  test('权威路径：session/messages part 的 state.metadata.display → 同样产出', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    // 权威刷新拉到带 display 的 tool part（probe 原文回放）
    fake.handlers['session/messages'] = (_) => {
          'messages': [
            {
              'info': {
                'id': 'msg_authoritative_wf',
                'role': 'assistant',
              },
              'parts': [fixture['authoritativePart']],
            },
          ],
        };
    final store = fedStore(fake);
    await store.openSession(sessionId);

    final tool = findTool(store, 'CreateWorkflow');
    expect(tool, isNotNull);
    expect(tool!.workflowName, expectedName);
    final display = tool.workflowDisplay;
    expect(display, isNotNull);
    expect(display!.errorCount, 0);
    expect(display.causalityGraph!.participants.single.steps, ['ask#1']);
  });

  test('非编排工具不吃 display 解析（Bash 无 metadata.display 恒 null）', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    fake.handlers['session/messages'] = (_) => {
          'messages': [
            {
              'info': {'id': 'msg_bash', 'role': 'assistant'},
              'parts': [
                {
                  'type': 'tool',
                  'callID': 'call_bash1',
                  'tool': 'Bash',
                  'state': {
                    'status': 'completed',
                    'input': {'command': 'ls'},
                    'output': 'a.txt',
                    'title': 'Bash',
                    'metadata': <String, dynamic>{},
                  },
                },
              ],
            },
          ],
        };
    final store = fedStore(fake);
    await store.openSession(sessionId);

    final tool = findTool(store, 'Bash');
    expect(tool, isNotNull);
    expect(tool!.workflowDisplay, isNull);
    expect(tool.workflowName, isNull);
    expect(tool.status, ToolCallStatus.done);
  });

  test('输入流累积路径：tool_input_* 分片送进即提取工作流名（不等权威回填）', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    fake.handlers['session/messages'] = (_) => {'messages': []};
    final store = fedStore(fake);
    await store.openSession(sessionId);

    const callId = 'call_stream_wf';
    const inputJson = '{"name":"流式命名工作流","script":"phase(\\"s\\");"}';
    // fake 引擎同款帧序：start（无输入，带工具名）→ 分片 delta → end（无输入）
    void streamFrame(String kind, {String? delta}) =>
        store.ingestNotifyFrame(ZcodeFrame(
          method: 'session/event',
          params: {
            'sessionId': sessionId,
            'type': 'model.streaming',
            'payload': {
              'assistantMessageId': 'msg_s1',
              'toolCallId': callId,
              'kind': kind,
              if (kind == 'tool_input_start') 'name': 'CreateWorkflow',
              if (delta != null) 'delta': delta,
            },
          },
        ),);
    streamFrame('tool_input_start');
    for (var i = 0; i < inputJson.length; i += 12) {
      final chunk = inputJson.substring(
        i,
        i + 12 > inputJson.length ? inputJson.length : i + 12,
      );
      streamFrame('tool_input_delta', delta: chunk);
    }
    streamFrame('tool_input_end');

    final tool = findTool(store, 'CreateWorkflow');
    expect(tool, isNotNull);
    // 输入流收尾帧即解析出名字（E2E 断言窗口竞态的回归锚：
    // 动作词先行 ~1s，名字必须在其后、result 前就位）
    expect(tool!.workflowName, '流式命名工作流');
    expect(tool.workflowDisplay, isNull, reason: 'result 未到，display 还没有');
  });
}
