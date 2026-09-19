import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';

void main() {
  // ── ToolCallInfo ──────────────────────────────────────────────────────

  group('ToolCallInfo', () {
    test('toJson 用状态名序列化', () {
      const info = ToolCallInfo(
        toolCallId: 'tc-1',
        toolName: 'Read',
        inputSummary: '/path/to/file',
        outputSummary: '42 lines',
        status: ToolCallStatus.done,
      );
      final json = info.toJson();

      expect(json['status'], equals('done'));
      expect(json['status'], isNot(isA<int>()));
    });

    test('toJson 保留实时生命周期与子智能体元数据', () {
      final info = ToolCallInfo(
        toolCallId: 'call_1',
        toolName: 'Agent',
        status: ToolCallStatus.running,
        lifecycle: 'started',
        elapsedMs: 1200,
        startedAt: DateTime.fromMillisecondsSinceEpoch(1000),
        parallelGroupIndex: 2,
        canRunParallel: true,
        subagentType: 'Explore',
        childSessionId: 'child-1',
        parentToolCallId: 'call_parent',
        source: 'subagent',
        agentId: 'agent-9',
        background: true,
        description: '大范围搜索',
        outputTruncated: true,
      );
      final json = info.toJson();

      expect(json['lifecycle'], 'started');
      expect(json['startedAt'], 1000);
      expect(json['parallelGroupIndex'], 2);
      expect(json['canRunParallel'], true);
      expect(json['subagentType'], 'Explore');
      expect(json['childSessionId'], 'child-1');
      expect(json['parentToolCallId'], 'call_parent');
      expect(json['source'], 'subagent');
      expect(json['agentId'], 'agent-9');
      expect(json['background'], true);
      expect(json['description'], '大范围搜索');
      expect(json['outputTruncated'], true);
    });

    test('round-trip：toJson → fromJson 保留全部字段', () {
      const original = ToolCallInfo(
        toolCallId: 'tc-round',
        toolName: 'Bash',
        inputSummary: '{"command":"ls"}',
        outputSummary: 'file1.txt',
        status: ToolCallStatus.error,
        isError: true,
        inputFull: '{"command":"ls","description":"list"}',
        outputFull: 'file1.txt\nfile2.txt',
        lifecycle: 'result',
        elapsedMs: 800,
      );
      final restored = ToolCallInfo.fromJson(original.toJson());

      expect(restored.toolCallId, original.toolCallId);
      expect(restored.toolName, original.toolName);
      expect(restored.inputSummary, original.inputSummary);
      expect(restored.outputSummary, original.outputSummary);
      expect(restored.inputFull, original.inputFull);
      expect(restored.outputFull, original.outputFull);
      expect(restored.status, original.status);
      expect(restored.isError, original.isError);
      expect(restored.lifecycle, original.lifecycle);
      expect(restored.elapsedMs, original.elapsedMs);
    });

    test('fromJson 缺字段时安全默认', () {
      final info = ToolCallInfo.fromJson(const {});

      expect(info.toolCallId, '');
      expect(info.toolName, '');
      expect(info.status, ToolCallStatus.running);
      expect(info.isError, isFalse);
      expect(info.canRunParallel, isFalse);
      expect(info.background, isFalse);
      expect(info.outputTruncated, isFalse);
    });

    test('copyWith 只更新指定字段', () {
      const original = ToolCallInfo(
        toolCallId: 'tc-orig',
        toolName: 'Bash',
        inputFull: 'old',
        status: ToolCallStatus.running,
      );
      final updated = original.copyWith(
        status: ToolCallStatus.done,
        outputSummary: 'ok',
        lifecycle: 'result',
      );

      expect(updated.toolCallId, 'tc-orig');
      expect(updated.toolName, 'Bash');
      expect(updated.inputFull, 'old');
      expect(updated.status, ToolCallStatus.done);
      expect(updated.outputSummary, 'ok');
      expect(updated.lifecycle, 'result');
    });
  });

  // ── ChatProcessPart ───────────────────────────────────────────────────

  group('ChatProcessPart', () {
    test('四种构造与 JSON round-trip', () {
      const tool = ToolCallInfo(
        toolCallId: 'c1',
        toolName: 'Read',
        status: ToolCallStatus.done,
      );
      final parts = [
        const ChatProcessPart.text('正文', id: 'p1'),
        const ChatProcessPart.reasoning('思考', id: 'p2'),
        const ChatProcessPart.tool(tool, id: 'p3'),
        const ChatProcessPart.marker('step-start', id: 'p4'),
      ];

      for (final part in parts) {
        final restored = ChatProcessPart.fromJson(part.toJson());
        expect(restored.kind, part.kind);
        expect(restored.id, part.id);
        expect(restored.text, part.text);
        expect(restored.toolCall?.toolCallId, part.toolCall?.toolCallId);
        expect(restored.rawType, part.rawType);
      }

      expect(parts[3].rawType, 'step-start');
      expect(parts[3].text, isNull);
    });

    test('fromJson 未知 kind 回退 text（不抛错）', () {
      final part = ChatProcessPart.fromJson({'kind': 'future-kind'});

      expect(part.kind, ChatProcessPartKind.text);
    });
  });

  // ── ChatMessage ───────────────────────────────────────────────────────

  group('ChatMessage', () {
    ChatMessage msg(
      List<ChatProcessPart> parts, {
      MessageRole role = MessageRole.assistant,
      String? agent,
      bool isStreaming = false,
      String? model,
    }) =>
        ChatMessage(
          role: role,
          processParts: parts,
          createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
          agent: agent,
          isStreaming: isStreaming,
          model: model,
        );

    test('text = text part 顺序拼接；reasoning/tool 不混入', () {
      final m = msg([
        const ChatProcessPart.reasoning('想一想'),
        const ChatProcessPart.text('你好，'),
        const ChatProcessPart.tool(
          ToolCallInfo(toolCallId: 'c', toolName: 'Bash'),
        ),
        const ChatProcessPart.text('结果如下'),
      ]);

      expect(m.text, '你好，结果如下');
    });

    test('user 消息单个 text part', () {
      final m = msg(
        [const ChatProcessPart.text('问题')],
        role: MessageRole.user,
      );

      expect(m.text, '问题');
      expect(m.isSubagentMessage, isFalse);
    });

    test('isSubagentMessage：info.agent 非 zcode-agent 才算子智能体', () {
      expect(msg(const [], agent: 'Explore').isSubagentMessage, isTrue);
      expect(msg(const [], agent: 'mcp__x__y').isSubagentMessage, isTrue);
      expect(msg(const [], agent: 'zcode-agent').isSubagentMessage, isFalse);
      expect(msg(const []).isSubagentMessage, isFalse);
    });

    test('isSystemInjected 识别系统注入提醒', () {
      expect(
        msg(
          [const ChatProcessPart.text('<system-reminder>提醒</system-reminder>')],
          role: MessageRole.user,
        ).isSystemInjected,
        isTrue,
      );
      expect(
        msg(
          [
            const ChatProcessPart.text(
              "The TodoWrite tool hasn't been used recently. ... "
              'This is a gentle reminder - ignore if not applicable.',
            ),
          ],
          role: MessageRole.user,
        ).isSystemInjected,
        isTrue,
      );
      expect(
        msg(
          [const ChatProcessPart.text('正常用户消息')],
          role: MessageRole.user,
        ).isSystemInjected,
        isFalse,
      );
    });

    test('isEmptyAssistant：marker-only 为空；流式占位不算空', () {
      expect(
        msg([const ChatProcessPart.marker('step-start')]).isEmptyAssistant,
        isTrue,
      );
      expect(msg(const []).isEmptyAssistant, isTrue);
      expect(
        msg(
          [
            const ChatProcessPart.tool(
              ToolCallInfo(toolCallId: 'c', toolName: 'Bash'),
            ),
          ],
        ).isEmptyAssistant,
        isFalse,
      );
      expect(msg(const [], isStreaming: true).isEmptyAssistant, isFalse);
    });

    test('copyWith 保留未指定字段', () {
      final original = msg(
        [const ChatProcessPart.text('a')],
        model: 'glm-5.3',
      );
      final updated = original.copyWith(isStreaming: false);

      expect(updated.model, 'glm-5.3');
      expect(updated.text, 'a');
      expect(updated.createdAt, original.createdAt);
    });
  });

  // ── TokenUsage ────────────────────────────────────────────────────────

  group('TokenUsage', () {
    test('stores input and output tokens', () {
      const usage = TokenUsage(inputTokens: 100, outputTokens: 50);
      expect(usage.inputTokens, equals(100));
      expect(usage.outputTokens, equals(50));
    });
  });

  // ── 枚举命名（缓存 JSON 依赖名字序列化）────────────────────────────

  group('Enum name consistency', () {
    test('枚举名稳定', () {
      expect(MessageRole.values.map((r) => r.name), ['user', 'assistant']);
      expect(
        ToolCallStatus.values.map((s) => s.name),
        ['running', 'done', 'error'],
      );
      expect(
        ChatProcessPartKind.values.map((k) => k.name),
        ['text', 'reasoning', 'tool', 'marker'],
      );
    });

    test('byName 全枚举可逆', () {
      for (final role in MessageRole.values) {
        expect(MessageRole.values.byName(role.name), role);
      }
      for (final status in ToolCallStatus.values) {
        expect(ToolCallStatus.values.byName(status.name), status);
      }
      for (final kind in ChatProcessPartKind.values) {
        expect(ChatProcessPartKind.values.byName(kind.name), kind);
      }
    });
  });
}
