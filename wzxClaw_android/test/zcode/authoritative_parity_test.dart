// ============================================================
// authoritative_parity_test — 实时/历史呈现一致性（批次3 契约）
//
// 钉死的等价性断言：
// 1. 权威回填：reasoning part 自带 time{start,end}（probe-reasoning-part
//    实测形状）→ 映射后思考段携带起止时间戳 → buildTurnVM 显示
//    「持续了 N 秒」——历史加载与实时观看同款呈现；
// 2. 生命周期：同 callId 先 error 后 success（实时 OR 累积）→
//    everError 存活 → 「已重试恢复」数据成立。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/widgets/turn_block.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  group('权威思考耗时（reasoning part time）', () {
    test('resume 的 reasoning part time{start,end} → 分段时间戳 → VM 时长',
        () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'session': {
              'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
            },
            'projection': {'status': 'idle'},
            'messages': [
              {
                'info': {
                  'id': 'm1',
                  'role': 'assistant',
                  'time': {'created': 1000},
                },
                'parts': [
                  {'type': 'step-start'},
                  {
                    // probe-reasoning-part 实测形状：text + time{start,end} + id
                    'type': 'reasoning',
                    'text': '**Calculating**',
                    'time': {'start': 1789877666292, 'end': 1789877671292},
                    'id': 'part_reasoning_1',
                  },
                  {
                    'type': 'text',
                    'text': '答案是 29318',
                    'time': {'start': 1789877671292, 'end': 1789877672292},
                    'id': 'part_text_1',
                  },
                ],
              },
            ],
          };
      final store = pairedStore(fake);

      await store.openSession('sess-1');
      final assistant = store.messages
          .where((m) => m.role == MessageRole.assistant)
          .single;
      final reasoning = assistant.processParts
          .firstWhere((p) => p.kind == ChatProcessPartKind.reasoning);

      // 权威时间戳落入分段字段（实时本地墙钟的等价物）
      expect(reasoning.startedAtMs, 1789877666292);
      expect(reasoning.closedAtMs, 1789877671292);

      // VM：完成态思考段显示 5 秒时长（历史加载 = 实时观感）
      final vm = buildTurnVM([assistant], busy: false);
      final think = vm.parts.first.think!;
      expect(think.running, isFalse);
      expect(think.duration, const Duration(seconds: 5));
    });
  });

  group('everError 生命周期累积（已重试恢复）', () {
    test('同 callId 先 error 后 success → everError 存活', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer();
      server.bind(fake); // 提供 resume/subscribe/messages 桩
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      await store.openSession('sess-p');

      await store.sendMessage('hi');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-p',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('turn.started', {'messageId': 'srv-u', 'input': 'hi'});
      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'kind': 'tool_call',
        'toolCallId': 'call-x',
        'tool': 'Bash',
        'input': {'command': 'npm test'},
      });
      // 第一次执行失败
      push('tool.updated', {
        'kind': 'result',
        'toolCallId': 'call-x',
        'status': 'error',
        'error': 'network down',
      });
      // 重试成功（同 callId）：result 分支实测以 result.success 判定
      push('tool.updated', {
        'kind': 'result',
        'toolCallId': 'call-x',
        'result': {'success': true},
        'output': 'all green',
      });

      final toolPart = store.messages.last.processParts
          .map((p) => p.toolCall)
          .whereType<ToolCallInfo>()
          .firstWhere((t) => t.toolCallId == 'call-x');
      expect(toolPart.status, ToolCallStatus.done);
      expect(toolPart.everError, isTrue, reason: '先败后成必须留下恢复痕迹');

      // 渲染层数据：recovered 徽标成立
      final vm = buildTurnVM([store.messages.last], busy: false);
      expect(vm.parts.last.tool!.recovered, isTrue);
    });
  });
}
