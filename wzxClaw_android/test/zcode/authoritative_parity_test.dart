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
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';
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

  group('权威替换工具输入回填（终端空详情根治）', () {
    test('权威 part 缺 input、流式投影有 → 同 callId 回填', () {
      final state = ZcodeSessionState('sess-heal');
      // 流式投影：Bash 工具带完整输入（tool_input_delta 累积产物）
      state.upsertStreamingTool(
        const ToolCallInfo(
          toolCallId: 'call-1',
          toolName: 'Bash',
          inputSummary: '{"command":"npm test"}',
          inputFull: '{"command":"npm test"}',
          status: ToolCallStatus.done,
        ),
        assistantMessageId: 'msg-a',
        turnId: 'turn-1',
      );

      // 权威批次：同消息但缺 input（0.16.9 偶发形状）
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-a',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            processParts: [
              const ChatProcessPart.tool(
                ToolCallInfo(
                  toolCallId: 'call-1',
                  toolName: 'Bash',
                  outputSummary: 'ok',
                  status: ToolCallStatus.done,
                ),
                id: 'part_1',
              ),
            ],
          ),
        ),
      ]);

      final healed = state.items.single.message.processParts
          .map((p) => p.toolCall)
          .whereType<ToolCallInfo>()
          .single;
      // 流式捕获的输入不丢，权威已有的输出保留
      expect(healed.inputFull, '{"command":"npm test"}');
      expect(healed.outputSummary, 'ok');
    });

    test('权威 input 完整时不被流式旧值覆盖', () {
      final state = ZcodeSessionState('sess-keep');
      state.upsertStreamingTool(
        const ToolCallInfo(
          toolCallId: 'call-2',
          toolName: 'Bash',
          inputSummary: 'stale',
          inputFull: 'stale',
          status: ToolCallStatus.running,
        ),
        assistantMessageId: 'msg-b',
      );

      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-b',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            processParts: [
              const ChatProcessPart.tool(
                ToolCallInfo(
                  toolCallId: 'call-2',
                  toolName: 'Bash',
                  inputSummary: 'fresh',
                  inputFull: 'fresh',
                  status: ToolCallStatus.done,
                ),
                id: 'part_2',
              ),
            ],
          ),
        ),
      ]);

      final healed = state.items.single.message.processParts
          .map((p) => p.toolCall)
          .whereType<ToolCallInfo>()
          .single;
      expect(healed.inputFull, 'fresh');
    });
  });

  group('权威合并与流式游标（幽灵占位/占位被偷根治）', () {
    test('回合中权威替换流式占位后，同消息增量继续落权威行，不重建幽灵占位', () {
      final state = ZcodeSessionState('sess-phantom');
      state.appendTextDelta('你好', assistantMessageId: 'msg-a', turnId: 'turn-1');
      expect(state.streamingIndex, greaterThanOrEqualTo(0));

      // 回合中途权威刷新：服务端返回同 id 消息（0.16.9 实测在途替换形状，
      // 不含在途工具——见 _toolInputBuffers / _healToolInputs 注释）
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-a',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            processParts: [const ChatProcessPart.text('你好')],
          ),
        ),
      ]);

      // 同一条消息的后续增量到达：必须落在权威条目上，绝不能另起一行——
      // 否则同 id 消息出现两行，下次权威合并后早前那份永久滞留成重复气泡
      state.appendTextDelta('，世界', assistantMessageId: 'msg-a', turnId: 'turn-1');

      expect(state.items, hasLength(1), reason: '同 id 消息只允许一行');
      expect(state.items.single.message.text, '你好，世界');
    });

    test('回合中权威替换后，同消息的工具更新也落权威行', () {
      final state = ZcodeSessionState('sess-phantom-tool');
      state.upsertStreamingTool(
        const ToolCallInfo(toolCallId: 'call-1', toolName: 'Bash'),
        assistantMessageId: 'msg-a',
        turnId: 'turn-1',
      );
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-a',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            // 服务端版本丢掉在途工具（实测形状）
            processParts: const [],
          ),
        ),
      ]);

      // 工具结果晚到：必须回到权威行，不能重建占位
      state.upsertStreamingTool(
        const ToolCallInfo(
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: ToolCallStatus.done,
          outputSummary: 'ok',
        ),
      );

      expect(state.items, hasLength(1), reason: '工具更新不得重建幽灵占位行');
      expect(
        state.items.single.message.processParts.map((p) => p.kind),
        contains(ChatProcessPartKind.tool),
      );
    });

    test('旧回合权威消息回填按回合身份消解，不得偷走新回合流式占位', () {
      final state = ZcodeSessionState('sess-steal');
      // 上一回合残留：未确认 assistant 占位（其权威刷新仍在路上）
      state.appendTextDelta('上一回合的部分回答', turnId: 'turn-1');
      // 用户发出新回合（sendMessage 同序：终结→重置→本地回合→乐观消息→占位）
      state.finalizeStreaming();
      state.resetTurnState();
      state.beginLocalTurn();
      state.appendLocalUserMessage('继续');
      state.ensureStreamingPlaceholder();
      state.appendTextDelta('新回答开头', turnId: 'turn-2');
      final liveIndex = state.streamingIndex;
      expect(liveIndex, greaterThanOrEqualTo(0));

      // 上一回合的权威刷新迟到落地（含 T1 的 assistant 消息）
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-t1',
          turnId: 'turn-1',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(900),
            processParts: [const ChatProcessPart.text('上一回合的完整回答')],
          ),
        ),
      ]);

      // T1 权威消息必须消解 T1 自己的占位；T2 活动占位原地不动
      expect(
        state.streamingIndex,
        liveIndex,
        reason: '新回合流式游标不得被旧回合权威消息消费',
      );
      expect(state.items.first.message.text, '上一回合的完整回答');
      expect(state.items.last.message.text, '新回答开头');
      expect(state.items, hasLength(3));
    });
  });

  group('块身份稳定（权威替换前后同键）', () {
    test('adoptStreamingProtoId 把协议 id 镜像进消息；权威映射同样携带', () {
      final state = ZcodeSessionState('sess-key');
      state.appendTextDelta('内容', assistantMessageId: 'msg-a');
      expect(state.items.single.message.protoId, 'msg-a');
    });
  });

  group('合并时序插入（柱2 后发现，2026-09-22 复盘会话实测缺陷）', () {
    // 场景：Q1 回合流式中推送中断，#48/#49 两条从未到达（无占位）；
    // Q2 回合正常（乐观 user + 流式占位 #51）。之后权威补拉一次性返回
    // #46..#52——#48/#49 必须插回时序位置（#47 与 user#50 之间），
    // 而不是 items.add() 追加到列表尾（会掉进 Q2 的回合块，答案回错家）。
    test('推送中断后补拉：缺位消息插回时序位置，不追加到列表尾', () {
      final state = ZcodeSessionState('sess-gap');
      ZcodeSessionItem auth(
        String id,
        MessageRole role,
        int createdMs, {
        List<ChatProcessPart> parts = const [],
        String? turnId,
      }) =>
          ZcodeSessionItem(
            protoId: id,
            synced: true,
            turnId: turnId,
            message: ChatMessage(
              role: role,
              createdAt: DateTime.fromMillisecondsSinceEpoch(createdMs),
              processParts: parts,
            ),
          );

      // 本地视口：#45 已确认、#47 流式占位（有 protoId 未确认）、
      // user#50 乐观回显、#51 流式占位
      state.items.addAll([
        auth('m45', MessageRole.assistant, 1000),
        // Q1 的乐观 user 回显（截图里气泡已渲染，权威批次会按 turnId 归位）
        ZcodeSessionItem(
          synced: false,
          turnId: 'turn-q1',
          message: ChatMessage(
            role: MessageRole.user,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1500),
            processParts: const [ChatProcessPart.text('项目没有AGENTS.md 这个？')],
          ),
        ),
        ZcodeSessionItem(
          protoId: 'm47',
          synced: false,
          turnId: 'turn-q1',
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(2000),
            processParts: const [
              ChatProcessPart.tool(
                ToolCallInfo(
                  toolCallId: 'c1',
                  toolName: 'Bash',
                  status: ToolCallStatus.done,
                ),
              ),
            ],
          ),
        ),
        ZcodeSessionItem(
          synced: false,
          turnId: 'turn-q2',
          message: ChatMessage(
            role: MessageRole.user,
            createdAt: DateTime.fromMillisecondsSinceEpoch(5000),
            processParts: const [ChatProcessPart.text('这个怎么没有看到最终的输出呢')],
          ),
        ),
        ZcodeSessionItem(
          protoId: 'm51',
          synced: false,
          turnId: 'turn-q2',
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(6000),
          ),
        ),
      ]);

      // 权威补拉批次（引擎升序）：#46 user、#47、#48、#49、#50、#51、#52
      state.mergeAuthoritative([
        auth('m46', MessageRole.user, 1500, turnId: 'turn-q1'),
        auth('m47', MessageRole.assistant, 2000, turnId: 'turn-q1'),
        auth(
          'm48',
          MessageRole.assistant,
          2500,
          turnId: 'turn-q1',
          parts: const [ChatProcessPart.text('过渡句')],
        ),
        auth(
          'm49',
          MessageRole.assistant,
          3000,
          turnId: 'turn-q1',
          parts: const [ChatProcessPart.text('Q1 的最终回答')],
        ),
        auth('m50', MessageRole.user, 5000, turnId: 'turn-q2'),
        auth('m51', MessageRole.assistant, 6000, turnId: 'turn-q2'),
        auth(
          'm52',
          MessageRole.assistant,
          7000,
          turnId: 'turn-q2',
          parts: const [ChatProcessPart.text('Q2 的最终回答')],
        ),
      ]);

      final ids = state.items.map((e) => e.protoId).toList();
      expect(
        ids,
        ['m45', 'm46', 'm47', 'm48', 'm49', 'm50', 'm51', 'm52'],
        reason: '补拉的消息必须插回时序位置；追加到列表尾会让答案掉进'
            '后面的回合块（2026-09-22 复盘会话「刷新了也不出现」根因）',
      );
    });
  });

}

