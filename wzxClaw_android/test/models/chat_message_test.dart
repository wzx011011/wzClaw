import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';

void main() {
  // ── ToolCallInfo ──────────────────────────────────────────────────────

  group('ToolCallInfo', () {
    test('toJson uses name for status, not index', () {
      const info = ToolCallInfo(
        toolCallId: 'tc-1',
        toolName: 'Read',
        inputSummary: '/path/to/file',
        outputSummary: '42 lines',
        status: ToolCallStatus.done,
        isError: false,
      );
      final json = info.toJson();

      expect(json['status'], equals('done'));
      // Verify it is NOT an integer index
      expect(json['status'], isNot(isA<int>()));
    });

    test('toJson serializes all fields correctly', () {
      const info = ToolCallInfo(
        toolCallId: 'tc-2',
        toolName: 'Bash',
        inputSummary: 'ls -la',
        outputSummary: 'file1.txt',
        status: ToolCallStatus.error,
        isError: true,
      );
      final json = info.toJson();

      expect(json['toolCallId'], equals('tc-2'));
      expect(json['toolName'], equals('Bash'));
      expect(json['inputSummary'], equals('ls -la'));
      expect(json['outputSummary'], equals('file1.txt'));
      expect(json['status'], equals('error'));
      expect(json['isError'], isTrue);
    });

    test('toJson omits null inputSummary and outputSummary', () {
      const info = ToolCallInfo(
        toolCallId: 'tc-3',
        toolName: 'Grep',
        status: ToolCallStatus.running,
      );
      final json = info.toJson();

      expect(json.containsKey('inputSummary'), isFalse);
      expect(json.containsKey('outputSummary'), isFalse);
    });

    test('fromJson parses name-based status', () {
      final json = {
        'toolCallId': 'tc-1',
        'toolName': 'Read',
        'status': 'done',
        'isError': false,
      };
      final info = ToolCallInfo.fromJson(json);

      expect(info.toolCallId, equals('tc-1'));
      expect(info.toolName, equals('Read'));
      expect(info.status, equals(ToolCallStatus.done));
      expect(info.isError, isFalse);
    });

    test('fromJson parses all status names correctly', () {
      for (final status in ToolCallStatus.values) {
        final json = {
          'toolCallId': 'tc-x',
          'toolName': 'Tool',
          'status': status.name,
          'isError': false,
        };
        final info = ToolCallInfo.fromJson(json);
        expect(info.status, equals(status),
            reason: 'Failed for status: ${status.name}');
      }
    });

    test('fromJson defaults to running when status is missing', () {
      final json = {
        'toolCallId': 'tc-default',
        'toolName': 'Tool',
        'isError': false,
      };
      final info = ToolCallInfo.fromJson(json);

      expect(info.status, equals(ToolCallStatus.running));
    });

    test('fromJson defaults to running when status is null', () {
      final json = {
        'toolCallId': 'tc-null',
        'toolName': 'Tool',
        'status': null,
        'isError': false,
      };
      final info = ToolCallInfo.fromJson(json);

      expect(info.status, equals(ToolCallStatus.running));
    });

    test('fromJson throws on invalid status name (byName behavior)', () {
      final json = {
        'toolCallId': 'tc-bad',
        'toolName': 'Tool',
        'status': 'nonexistent_status',
        'isError': false,
      };
      // byName throws ArgumentError for invalid names
      expect(() => ToolCallInfo.fromJson(json), throwsA(isA<ArgumentError>()));
    });

    test('fromJson handles null optional fields', () {
      final json = {
        'toolCallId': 'tc-opt',
        'toolName': 'Tool',
        'status': 'running',
        'isError': false,
      };
      final info = ToolCallInfo.fromJson(json);

      expect(info.inputSummary, isNull);
      expect(info.outputSummary, isNull);
    });

    test('fromJson handles missing fields with defaults', () {
      final json = <String, dynamic>{};
      final info = ToolCallInfo.fromJson(json);

      expect(info.toolCallId, equals(''));
      expect(info.toolName, equals(''));
      expect(info.status, equals(ToolCallStatus.running));
      expect(info.isError, isFalse);
    });

    test('copyWith updates specified fields only', () {
      const original = ToolCallInfo(
        toolCallId: 'tc-orig',
        toolName: 'Bash',
        inputSummary: 'original cmd',
        outputSummary: 'original output',
        status: ToolCallStatus.running,
        isError: false,
      );
      final updated = original.copyWith(
        status: ToolCallStatus.done,
        outputSummary: 'new output',
      );

      expect(updated.toolCallId, equals('tc-orig'));
      expect(updated.toolName, equals('Bash'));
      expect(updated.inputSummary, equals('original cmd'));
      expect(updated.outputSummary, equals('new output'));
      expect(updated.status, equals(ToolCallStatus.done));
      expect(updated.isError, isFalse);
    });

    test('round-trip: toJson -> fromJson preserves all fields', () {
      const original = ToolCallInfo(
        toolCallId: 'tc-round',
        toolName: 'Write',
        inputSummary: '/tmp/test.dart',
        outputSummary: 'written',
        status: ToolCallStatus.done,
        isError: false,
      );
      final json = original.toJson();
      final restored = ToolCallInfo.fromJson(json);

      expect(restored.toolCallId, equals(original.toolCallId));
      expect(restored.toolName, equals(original.toolName));
      expect(restored.inputSummary, equals(original.inputSummary));
      expect(restored.outputSummary, equals(original.outputSummary));
      expect(restored.status, equals(original.status));
      expect(restored.isError, equals(original.isError));
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

  // ── ChatMessage ───────────────────────────────────────────────────────

  group('ChatMessage', () {
    test('toDbMap serializes role as name string', () {
      final msg = ChatMessage(
        role: MessageRole.user,
        content: 'Hello',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
      );
      final map = msg.toDbMap();

      expect(map['role'], equals('user'));
      expect(map['role'], isNot(isA<int>()));
    });

    test('toDbMap serializes all role types as name strings', () {
      for (final role in MessageRole.values) {
        final msg = ChatMessage(
          role: role,
          content: 'test',
          createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
        );
        final map = msg.toDbMap();
        expect(map['role'], equals(role.name));
      }
    });

    test('toDbMap serializes toolStatus as name string', () {
      final msg = ChatMessage(
        role: MessageRole.tool,
        content: 'Bash',
        toolName: 'Bash',
        toolStatus: ToolCallStatus.running,
        toolCallId: 'tc-1',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
      );
      final map = msg.toDbMap();

      expect(map['tool_status'], equals('running'));
      expect(map['tool_status'], isNot(isA<int>()));
    });

    test('toDbMap sets tool_status to null when toolStatus is null', () {
      final msg = ChatMessage(
        role: MessageRole.user,
        content: 'Hello',
        createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
      );
      final map = msg.toDbMap();

      expect(map['tool_status'], isNull);
    });

    test('fromDbMap parses role from name string', () {
      final map = {
        'id': 1,
        'role': 'assistant',
        'content': 'Hi there',
        'tool_name': null,
        'tool_status': null,
        'created_at': 1000,
        'tool_call_id': null,
        'tool_input': null,
        'tool_output': null,
        'tool_result_summary': null,
        'tool_calls_json': null,
        'input_tokens': null,
        'output_tokens': null,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.role, equals(MessageRole.assistant));
      expect(msg.content, equals('Hi there'));
    });

    test('fromDbMap parses role from legacy integer (backward compat)', () {
      // Legacy format: role stored as enum index
      // MessageRole.user = 0, assistant = 1, tool = 2
      final map = {
        'id': 2,
        'role': 1, // MessageRole.assistant
        'content': 'Legacy message',
        'tool_name': null,
        'tool_status': null,
        'created_at': 2000,
        'tool_call_id': null,
        'tool_input': null,
        'tool_output': null,
        'tool_result_summary': null,
        'tool_calls_json': null,
        'input_tokens': null,
        'output_tokens': null,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.role, equals(MessageRole.assistant));
    });

    test('fromDbMap parses all roles from legacy integers', () {
      for (int i = 0; i < MessageRole.values.length; i++) {
        final map = {
          'id': i,
          'role': i,
          'content': 'msg-$i',
          'created_at': 1000 + i,
        };
        final msg = ChatMessage.fromDbMap(map);
        expect(msg.role, equals(MessageRole.values[i]),
            reason: 'Failed for role index: $i');
      }
    });

    test('fromDbMap parses toolStatus from name string', () {
      final map = {
        'id': 10,
        'role': 'tool',
        'content': 'Bash',
        'tool_name': 'Bash',
        'tool_status': 'error',
        'created_at': 3000,
        'tool_call_id': 'tc-err',
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.toolStatus, equals(ToolCallStatus.error));
    });

    test('fromDbMap parses toolStatus from legacy integer (backward compat)', () {
      // ToolCallStatus.running = 0, done = 1, error = 2
      final map = {
        'id': 11,
        'role': 'tool',
        'content': 'Grep',
        'tool_name': 'Grep',
        'tool_status': 2, // ToolCallStatus.error
        'created_at': 4000,
        'tool_call_id': 'tc-old',
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.toolStatus, equals(ToolCallStatus.error));
    });

    test('fromDbMap defaults to user role for unknown type', () {
      final map = {
        'id': 12,
        'role': 99.5, // double, neither int nor string
        'content': 'Unknown',
        'created_at': 5000,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.role, equals(MessageRole.user));
    });

    test('fromDbMap defaults toolStatus to running for unknown type', () {
      final map = {
        'id': 13,
        'role': 'tool',
        'content': 'Tool',
        'tool_name': 'Tool',
        'tool_status': 99.5, // double, neither int nor string
        'created_at': 6000,
        'tool_call_id': 'tc-wtf',
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.toolStatus, equals(ToolCallStatus.running));
    });

    test('toDbMap includes toolCallsJson when toolCalls present', () {
      final toolCalls = [
        const ToolCallInfo(
          toolCallId: 'tc-a',
          toolName: 'Read',
          inputSummary: '/foo/bar',
          status: ToolCallStatus.done,
        ),
        const ToolCallInfo(
          toolCallId: 'tc-b',
          toolName: 'Bash',
          inputSummary: 'ls',
          status: ToolCallStatus.running,
        ),
      ];
      final msg = ChatMessage(
        role: MessageRole.assistant,
        content: 'Let me check',
        toolCalls: toolCalls,
        createdAt: DateTime.fromMillisecondsSinceEpoch(7000),
      );
      final map = msg.toDbMap();

      expect(map['tool_calls_json'], isNotNull);
      final decoded =
          jsonDecode(map['tool_calls_json'] as String) as List<dynamic>;
      expect(decoded.length, equals(2));
      expect(decoded[0]['toolCallId'], equals('tc-a'));
      expect(decoded[0]['status'], equals('done'));
      expect(decoded[1]['toolName'], equals('Bash'));
      expect(decoded[1]['status'], equals('running'));
    });

    test('toDbMap sets toolCallsJson to null when no toolCalls', () {
      final msg = ChatMessage(
        role: MessageRole.user,
        content: 'Hello',
        createdAt: DateTime.fromMillisecondsSinceEpoch(8000),
      );
      final map = msg.toDbMap();

      expect(map['tool_calls_json'], isNull);
    });

    test('fromDbMap reconstructs toolCalls from toolCallsJson', () {
      final toolCallsJson = jsonEncode([
        {
          'toolCallId': 'tc-x',
          'toolName': 'Grep',
          'inputSummary': 'pattern',
          'status': 'done',
          'isError': false,
        },
      ]);
      final map = {
        'id': 20,
        'role': 'assistant',
        'content': 'Searching',
        'tool_name': null,
        'tool_status': null,
        'created_at': 9000,
        'tool_call_id': null,
        'tool_input': null,
        'tool_output': null,
        'tool_result_summary': null,
        'tool_calls_json': toolCallsJson,
        'input_tokens': null,
        'output_tokens': null,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.toolCalls, isNotNull);
      expect(msg.toolCalls!.length, equals(1));
      expect(msg.toolCalls!.first.toolCallId, equals('tc-x'));
      expect(msg.toolCalls!.first.toolName, equals('Grep'));
      expect(msg.toolCalls!.first.status, equals(ToolCallStatus.done));
    });

    test('fromDbMap reconstructs TokenUsage from input_tokens/output_tokens',
        () {
      final map = {
        'id': 21,
        'role': 'assistant',
        'content': 'Done',
        'created_at': 10000,
        'input_tokens': 500,
        'output_tokens': 200,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.usage, isNotNull);
      expect(msg.usage!.inputTokens, equals(500));
      expect(msg.usage!.outputTokens, equals(200));
    });

    test('fromDbMap sets usage to null when tokens are missing', () {
      final map = {
        'id': 22,
        'role': 'user',
        'content': 'Hi',
        'created_at': 11000,
      };
      final msg = ChatMessage.fromDbMap(map);

      expect(msg.usage, isNull);
    });

    test('round-trip: toDbMap -> fromDbMap preserves all fields', () {
      final original = ChatMessage(
        role: MessageRole.tool,
        content: 'Bash',
        toolName: 'Bash',
        toolStatus: ToolCallStatus.done,
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000),
        toolCallId: 'tc-roundtrip',
        toolInput: 'echo hello',
        toolOutput: 'hello\n',
        toolResultSummary: 'hello',
        toolCalls: [
          const ToolCallInfo(
            toolCallId: 'tc-inner',
            toolName: 'Bash',
            inputSummary: 'echo hello',
            outputSummary: 'hello',
            status: ToolCallStatus.done,
            isError: false,
          ),
        ],
        usage: const TokenUsage(inputTokens: 42, outputTokens: 10),
      );

      // Serialize to DB map (without id — auto-generated)
      final dbMap = original.toDbMap();

      // Simulate DB adding an id
      dbMap['id'] = 99;

      // Deserialize back
      final restored = ChatMessage.fromDbMap(dbMap);

      expect(restored.id, equals(99));
      expect(restored.role, equals(original.role));
      expect(restored.content, equals(original.content));
      expect(restored.toolName, equals(original.toolName));
      expect(restored.toolStatus, equals(original.toolStatus));
      expect(restored.createdAt.millisecondsSinceEpoch,
          equals(original.createdAt.millisecondsSinceEpoch));
      expect(restored.toolCallId, equals(original.toolCallId));
      expect(restored.toolInput, equals(original.toolInput));
      expect(restored.toolOutput, equals(original.toolOutput));
      expect(restored.toolResultSummary, equals(original.toolResultSummary));
      expect(restored.isStreaming, isFalse);

      // Tool calls
      expect(restored.toolCalls, isNotNull);
      expect(restored.toolCalls!.length, equals(1));
      expect(restored.toolCalls!.first.toolCallId, equals('tc-inner'));
      expect(restored.toolCalls!.first.status, equals(ToolCallStatus.done));

      // Token usage
      expect(restored.usage, isNotNull);
      expect(restored.usage!.inputTokens, equals(42));
      expect(restored.usage!.outputTokens, equals(10));
    });

    test('round-trip preserves streaming=false default', () {
      final msg = ChatMessage(
        role: MessageRole.user,
        content: 'test',
        createdAt: DateTime.now(),
      );
      final map = msg.toDbMap();
      map['id'] = 1;
      final restored = ChatMessage.fromDbMap(map);

      expect(restored.isStreaming, isFalse);
    });

    test('copyWith preserves unchanged fields', () {
      final original = ChatMessage(
        id: 5,
        role: MessageRole.assistant,
        content: 'original content',
        toolName: 'Read',
        toolStatus: ToolCallStatus.running,
        createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
        toolCallId: 'tc-5',
        toolInput: '/file.txt',
        toolOutput: null,
        toolResultSummary: null,
        isStreaming: true,
      );

      final updated = original.copyWith(
        content: 'updated content',
        toolStatus: ToolCallStatus.done,
        isStreaming: false,
        toolOutput: '10 lines',
        toolResultSummary: '10 lines',
      );

      // Changed fields
      expect(updated.content, equals('updated content'));
      expect(updated.toolStatus, equals(ToolCallStatus.done));
      expect(updated.isStreaming, isFalse);
      expect(updated.toolOutput, equals('10 lines'));
      expect(updated.toolResultSummary, equals('10 lines'));

      // Preserved fields
      expect(updated.id, equals(5));
      expect(updated.role, equals(MessageRole.assistant));
      expect(updated.toolName, equals('Read'));
      expect(updated.createdAt.millisecondsSinceEpoch, equals(1000));
      expect(updated.toolCallId, equals('tc-5'));
      expect(updated.toolInput, equals('/file.txt'));
    });

    test('copyWith preserves toolCalls and usage when not specified', () {
      final original = ChatMessage(
        role: MessageRole.assistant,
        content: 'msg',
        createdAt: DateTime.now(),
        toolCalls: [
          const ToolCallInfo(
              toolCallId: 'tc-1', toolName: 'Read', status: ToolCallStatus.done),
        ],
        usage: const TokenUsage(inputTokens: 10, outputTokens: 5),
      );

      final updated = original.copyWith(content: 'new msg');

      expect(updated.toolCalls, isNotNull);
      expect(updated.toolCalls!.length, equals(1));
      expect(updated.usage, isNotNull);
      expect(updated.usage!.inputTokens, equals(10));
    });
  });

  // ── Enum naming verification ──────────────────────────────────────────

  group('Enum name consistency', () {
    test('MessageRole names match expected strings', () {
      expect(MessageRole.user.name, equals('user'));
      expect(MessageRole.assistant.name, equals('assistant'));
      expect(MessageRole.tool.name, equals('tool'));
    });

    test('ToolCallStatus names match expected strings', () {
      expect(ToolCallStatus.running.name, equals('running'));
      expect(ToolCallStatus.done.name, equals('done'));
      expect(ToolCallStatus.error.name, equals('error'));
    });

    test('MessageRole.values.byName works for all names', () {
      for (final role in MessageRole.values) {
        expect(MessageRole.values.byName(role.name), equals(role));
      }
    });

    test('ToolCallStatus.values.byName works for all names', () {
      for (final status in ToolCallStatus.values) {
        expect(ToolCallStatus.values.byName(status.name), equals(status));
      }
    });
  });
}
