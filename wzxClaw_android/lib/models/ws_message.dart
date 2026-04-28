import 'dart:convert';

/// WebSocket message model matching the wzxClaw desktop protocol.
///
/// All messages exchanged between the mobile client and the desktop IDE
/// follow this JSON structure: `{ "event": "...", "data": ... }`.
class WsMessage {
  /// Event name (e.g., "command:send", "stream:agent:text").
  final String event;

  /// Payload -- can be a string, map, list, or null.
  final dynamic data;

  const WsMessage({required this.event, this.data});

  /// Parse from JSON received over the wire.
  factory WsMessage.fromJson(Map<String, dynamic> json) {
    return WsMessage(
      event: json['event'] as String? ?? '',
      data: json['data'],
    );
  }

  /// Serialize to JSON map.
  Map<String, dynamic> toJson() {
    return {
      'event': event,
      if (data != null) 'data': data,
    };
  }

  /// Serialize to JSON string for sending over WebSocket.
  String toJsonString() => jsonEncode(toJson());

  @override
  String toString() => 'WsMessage(event: $event, data: $data)';
}

/// Event name constants matching the wzxClaw desktop WebSocket protocol.
class WsEvents {
  WsEvents._();

  // -- Outgoing (client -> server) --
  static const String commandSend = 'command:send';
  static const String commandStop = 'command:stop';
  static const String ping = 'ping';
  static const String pong = 'pong';

  // -- Identity events --
  static const String identityAnnounce = 'identity:announce';
  static const String identityMobileAnnounce = 'identity:mobile_announce';

  // -- System events from relay --
  static const String systemDesktopConnected = 'system:desktop_connected';
  static const String systemDesktopDisconnected = 'system:desktop_disconnected';
  static const String systemMobileConnected = 'system:mobile_connected';
  static const String systemMobileDisconnected = 'system:mobile_disconnected';

  // -- Incoming: new stream:agent:* format (desktop broadcasts these) --
  static const String agentText = 'stream:agent:text';
  static const String agentThinking = 'stream:agent:thinking';
  static const String agentToolCall = 'stream:agent:tool_call';
  static const String agentToolResult = 'stream:agent:tool_result';
  static const String agentDone = 'stream:agent:done';
  static const String agentError = 'stream:agent:error';
  static const String agentCompacted = 'stream:agent:compacted';
  static const String agentPermissionRequest = 'stream:agent:permission_request';
  static const String agentTurnEnd = 'stream:agent:turn_end';

  // -- Incoming: command acknowledgment --
  static const String commandAck = 'command:ack';

  // -- Permission response (outgoing) --
  static const String permissionResponse = 'permission:response';

  // -- Permission mode (bidirectional) --
  static const String permissionSetModeRequest = 'permission:set_mode:request';
  static const String permissionGetModeRequest = 'permission:get_mode:request';
  static const String permissionModeResponse = 'permission:mode:response';

  // -- Todo events (incoming: desktop -> mobile) --
  static const String todoUpdated = 'todo:updated';

  // -- Session sync events (outgoing: mobile -> desktop) --
  static const String sessionListRequest = 'session:list:request';
  static const String sessionLoadRequest = 'session:load:request';

  // -- Session sync events (incoming: desktop -> mobile) --
  static const String sessionListResponse = 'session:list:response';
  static const String sessionLoadResponse = 'session:load:response';
  static const String sessionWorkspaceInfo = 'session:workspace:info';
  static const String sessionActive = 'session:active';
  static const String sessionError = 'session:error';

  // -- Session CRUD events (outgoing: mobile -> desktop) --
  static const String sessionCreateRequest = 'session:create:request';
  static const String sessionDeleteRequest = 'session:delete:request';
  static const String sessionRenameRequest = 'session:rename:request';

  // -- Session CRUD events (incoming: desktop -> mobile) --
  static const String sessionCreateResponse = 'session:create:response';
  static const String sessionDeleteResponse = 'session:delete:response';
  static const String sessionRenameResponse = 'session:rename:response';

  // -- Workspace events (outgoing: mobile -> desktop) --
  static const String workspaceListRequest = 'workspace:list:request';
  static const String workspaceSwitchRequest = 'workspace:switch:request';

  // -- Workspace events (incoming: desktop -> mobile) --
  static const String workspaceListResponse = 'workspace:list:response';
  static const String workspaceSwitchResponse = 'workspace:switch:response';

  // -- File browsing events (outgoing: mobile -> desktop) --
  static const String fileTreeRequest = 'file:tree:request';
  static const String fileReadRequest = 'file:read:request';

  // -- File browsing events (incoming: desktop -> mobile) --
  static const String fileTreeResponse = 'file:tree:response';
  static const String fileReadResponse = 'file:read:response';

  // -- Plan Mode events (incoming: desktop -> mobile) --
  static const String agentPlanModeEntered = 'stream:agent:plan_mode_entered';
  static const String agentPlanModeExited = 'stream:agent:plan_mode_exited';

  // -- Plan Mode response (outgoing: mobile -> desktop) --
  static const String planDecision = 'plan:decision';

  // -- Retry event (incoming: desktop -> mobile) --
  static const String streamRetrying = 'stream:retrying';

  // -- AskUserQuestion events (incoming: desktop -> mobile) --
  static const String agentAskUserQuestion = 'stream:agent:ask_user_question';

  // -- AskUserQuestion response (outgoing: mobile -> desktop) --
  static const String askUserAnswer = 'ask-user:answer';

  // -- Push notifications (desktop -> mobile, data-changed) --
  static const String sessionChanged = 'session:changed';

  // -- Multi-desktop system events from relay --
  static const String systemDesktopList = 'system:desktop_list';
  static const String systemMobileList = 'system:mobile_list';
  static const String systemTargetConfirmed = 'system:target:confirmed';

  // -- Target selection commands (mobile -> relay) --
  static const String targetSelect = 'target:select';
  static const String targetClear = 'target:clear';
}
