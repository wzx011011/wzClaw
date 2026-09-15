import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/models/ws_message.dart';

/// Protocol compatibility tests — verifies that Dart client constants and
/// serialization formats match the relay server's expected wire protocol.
void main() {
  group('WsEvents constants match relay protocol', () {
    test('agent streaming events', () {
      expect(WsEvents.agentText, 'stream:agent:text');
      expect(WsEvents.agentThinking, 'stream:agent:thinking');
      expect(WsEvents.agentToolCall, 'stream:agent:tool_call');
      expect(WsEvents.agentToolResult, 'stream:agent:tool_result');
      expect(WsEvents.agentDone, 'stream:agent:done');
      expect(WsEvents.agentError, 'stream:agent:error');
      expect(WsEvents.agentCompacted, 'stream:agent:compacted');
      expect(WsEvents.agentPermissionRequest, 'stream:agent:permission_request');
      expect(WsEvents.agentTurnEnd, 'stream:agent:turn_end');
      expect(WsEvents.agentPlanModeEntered, 'stream:agent:plan_mode_entered');
      expect(WsEvents.agentPlanModeExited, 'stream:agent:plan_mode_exited');
      expect(WsEvents.streamRetrying, 'stream:retrying');
    });

    test('command events', () {
      expect(WsEvents.commandSend, 'command:send');
      expect(WsEvents.commandAck, 'command:ack');
      expect(WsEvents.commandStop, 'command:stop');
    });

    test('permission events', () {
      expect(WsEvents.permissionResponse, 'permission:response');
      expect(WsEvents.permissionSetModeRequest, 'permission:set_mode:request');
      expect(WsEvents.permissionGetModeRequest, 'permission:get_mode:request');
      expect(WsEvents.permissionModeResponse, 'permission:mode:response');
      expect(WsEvents.planDecision, 'plan:decision');
      expect(WsEvents.todoUpdated, 'todo:updated');
    });

    test('session events', () {
      expect(WsEvents.sessionListRequest, 'session:list:request');
      expect(WsEvents.sessionListResponse, 'session:list:response');
      expect(WsEvents.sessionLoadRequest, 'session:load:request');
      expect(WsEvents.sessionLoadResponse, 'session:load:response');
      expect(WsEvents.sessionCreateRequest, 'session:create:request');
      expect(WsEvents.sessionCreateResponse, 'session:create:response');
      expect(WsEvents.sessionDeleteRequest, 'session:delete:request');
      expect(WsEvents.sessionDeleteResponse, 'session:delete:response');
      expect(WsEvents.sessionRenameRequest, 'session:rename:request');
      expect(WsEvents.sessionRenameResponse, 'session:rename:response');
    });

    test('system events', () {
      expect(WsEvents.systemDesktopConnected, 'system:desktop_connected');
      expect(WsEvents.systemDesktopDisconnected, 'system:desktop_disconnected');
      expect(WsEvents.systemMobileConnected, 'system:mobile_connected');
      expect(WsEvents.systemMobileDisconnected, 'system:mobile_disconnected');
    });
  });

  group('ChatMessage serialization for protocol compat', () {
    test('tool message serializes with .name (not .index)', () {
      final msg = ChatMessage(
        role: MessageRole.tool,
        content: '',
        toolName: 'Bash',
        toolStatus: ToolCallStatus.running,
        createdAt: DateTime(2026, 1, 1),
        toolCallId: 'tc-1',
        toolInput: 'ls -la',
      );
      final map = msg.toDbMap();
      expect(map['role'], 'tool');
      expect(map['tool_status'], 'running');
    });

    test('ChatMessage deserializes both name and legacy integer', () {
      final fromName = ChatMessage.fromDbMap({
        'role': 'assistant',
        'content': 'hello',
        'created_at': DateTime(2026, 1, 1).millisecondsSinceEpoch,
        'tool_status': 'done',
      });
      expect(fromName.role, MessageRole.assistant);
      expect(fromName.toolStatus, ToolCallStatus.done);

      final fromIndex = ChatMessage.fromDbMap({
        'role': 'tool',
        'content': '',
        'created_at': DateTime(2026, 1, 1).millisecondsSinceEpoch,
        'tool_status': 2,
      });
      expect(fromIndex.toolStatus, ToolCallStatus.error);
    });

    test('ToolCallInfo JSON matches protocol wire format', () {
      final info = ToolCallInfo(
        toolCallId: 'tc-100',
        toolName: 'file_read',
        inputSummary: '/src/main.ts',
        outputSummary: 'file contents',
        status: ToolCallStatus.done,
      );
      final json = info.toJson();
      expect(json['toolCallId'], 'tc-100');
      expect(json['toolName'], 'file_read');
      expect(json['status'], 'done');
      expect(json['isError'], isFalse);

      final roundTrip = ToolCallInfo.fromJson(json);
      expect(roundTrip.toolCallId, 'tc-100');
      expect(roundTrip.status, ToolCallStatus.done);
    });
  });
}
