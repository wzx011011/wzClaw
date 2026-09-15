// ============================================================
// zcode_protocol_translate — 新链路协议翻译层（纯函数）
//
// 换芯不换壳：旧 UI/ChatStore 说旧 WsEvents 协议，对面换成
// 新 relay + app-server。本文件负责双向翻译，无 IO、可单测。
//
// 入站（app-server 帧 → 旧事件）：
//   通知 session/event（events[].payload.kind）→ stream:agent:*
//   反向请求（method 含 permission/interaction）→ permission_request
//     / ask_user_question
//   会话响应由 ConnectionManager 编排后经 [responseToWsMessages] 映射
// ============================================================

import '../models/ws_message.dart';

/// 反向请求（app-server → 手机）登记信息
class ReverseRequestInfo {
  final dynamic frameId;
  final String kind; // 'permission' | 'ask_user'
  const ReverseRequestInfo(this.frameId, this.kind);
}

/// 入站翻译：app-server 通知帧 → 旧事件流
List<WsMessage> translateNotification(
  String method,
  dynamic params,
  void Function(ReverseRequestInfo info, WsMessage event) registerReverse,
) {
  if (method == 'session/event') {
    final p = params is Map ? params : const {};
    final sessionId = p['sessionId']?.toString() ?? '';
    final events = p['events'];
    if (events is! List) {
      return _translatePayload(sessionId, p);
    }
    final out = <WsMessage>[];
    for (final ev in events) {
      final payload = ev is Map ? (ev['payload'] ?? ev) : ev;
      out.addAll(_translatePayload(sessionId, payload));
    }
    return out;
  }
  // 反向请求：权限确认 / AskUser
  if (method.isNotEmpty && _looksReverse(method) && params is Map) {
    return _translateReverse(params, registerReverse);
  }
  return const [];
}

bool _looksReverse(String method) {
  final m = method.toLowerCase();
  return m.contains('permission') || m.contains('confirm') ||
      m.contains('approval') || m.contains('askuser') ||
      m.contains('ask_user') || m.contains('interaction');
}

List<WsMessage> _translateReverse(
  Map params,
  void Function(ReverseRequestInfo, WsMessage) registerReverse,
) {
  final method = params['method']?.toString() ?? '';
  final frameId = params['id'] ?? params['frameId'];
  final p = params['params'] is Map ? params['params'] as Map : params;
  final lower = method.toLowerCase();
  final toolCallId = (p['toolCallId'] ?? p['tool_call_id'] ?? p['callId'] ??
          p['requestId'] ?? p['id'] ?? frameId ?? '').toString();
  if (lower.contains('askuser') || lower.contains('ask_user') ||
      lower.contains('interaction')) {
    final questionId = (p['questionId'] ?? p['requestId'] ?? toolCallId).toString();
    final options = (p['options'] as List? ?? [])
        .whereType<Map>()
        .map((o) => Map<String, dynamic>.from(o))
        .map((o) => {
              'label': o['label']?.toString() ?? o['value']?.toString() ?? '',
              'description': o['description']?.toString(),
            })
        .toList();
    final event = WsMessage(event: 'stream:agent:ask_user_question', data: {
      'questionId': questionId,
      'question': p['question']?.toString() ?? p['prompt']?.toString() ?? '',
      'options': options,
      'allowCustom': p['allowCustom'] == true || p['allow_multiple'] == true,
      'sessionId': p['sessionId']?.toString() ?? '',
    });
    registerReverse(ReverseRequestInfo(frameId, 'ask_user'), event);
    return [event];
  }
  final event = WsMessage(event: 'stream:agent:permission_request', data: {
    'toolCallId': toolCallId,
    'toolName': p['toolName'] ?? p['tool'] ?? p['name'] ?? '',
    'input': p['input'] ?? p['params'] ?? p['arguments'] ?? {},
    'sessionId': p['sessionId']?.toString() ?? '',
  });
  registerReverse(ReverseRequestInfo(frameId, 'permission'), event);
  return [event];
}

List<WsMessage> _translatePayload(String sessionId, dynamic payload) {
  final p = payload is Map ? payload : const {};
  final kind = p['kind']?.toString();
  final type = p['type']?.toString();
  final out = <WsMessage>[];
  String content(dynamic v) => v?.toString() ?? '';

  // kind 缺省视为 text_delta（与协议实测一致）
  if (type == 'text_delta' || kind == 'text_delta' || kind == null) {
    final c = content(p['delta'] ?? p['text']);
    if (c.isNotEmpty) {
      out.add(WsMessage(event: 'stream:agent:text', data: {'sessionId': sessionId, 'content': c}));
    }
  }
  if (type == 'reasoning_delta' || kind == 'reasoning_delta') {
    final c = content(p['delta'] ?? p['text']);
    if (c.isNotEmpty) {
      out.add(WsMessage(event: 'stream:agent:thinking', data: {'sessionId': sessionId, 'content': c}));
    }
  }
  if (kind != null && kind.startsWith('tool.')) {
    final callId = content(p['callId'] ?? p['toolCallId'] ?? p['id']);
    final toolName = content(p['tool'] ?? p['name']);
    if (kind == 'tool.call' || kind == 'tool.use' || kind == 'tool_start') {
      out.add(WsMessage(event: 'stream:agent:tool_call', data: {
        'sessionId': sessionId,
        'toolCallId': callId,
        'toolName': toolName,
        'input': p['input'] ?? p['params'] ?? '',
      }));
    } else {
      final output = p['output'] is String ? p['output'] : (p['output']?.toString() ?? '');
      out.add(WsMessage(event: 'stream:agent:tool_result', data: {
        'sessionId': sessionId,
        'toolCallId': callId,
        'output': output.length > 2000 ? output.substring(0, 2000) : output,
        'isError': kind.contains('error'),
      }));
    }
  }
  if (kind == 'turn.started' || type == 'turn.started') {
    out.add(WsMessage(event: 'stream:agent:running', data: {'sessionId': sessionId}));
  }
  if (kind == 'turn.terminal' || type == 'turn.terminal' || kind == 'turn.completed') {
    final status = content(p['status']);
    out.add(WsMessage(event: 'stream:agent:turn_end', data: {
      'sessionId': sessionId,
      'status': status,
    }));
    out.add(WsMessage(event: 'stream:agent:done', data: {
      'sessionId': sessionId,
      'status': status,
      'usage': p['usage'],
    }));
  }
  if (kind == 'model.error' || p['isError'] == true) {
    out.add(WsMessage(event: 'stream:agent:error', data: {
      'sessionId': sessionId,
      'error': content(p['error'] ?? p['message']),
    }));
  }
  return out;
}

/// 响应映射：app-server 响应 → 旧响应事件（ConnectionManager 编排时调用）
List<WsMessage> responseToWsMessages(String method, dynamic result, Map<String, dynamic> error) {
  if (error.isNotEmpty) {
    final code = error['code'];
    return [
      WsMessage(event: 'session:error', data: {
        'error': code == -32004
            ? '该会话正在桌面端运行，手机端暂无法查看'
            : (error['message'] ?? '请求失败'),
        'code': code,
      }),
    ];
  }
  switch (method) {
    case 'session/list':
      final sessions = (result is Map ? result['sessions'] : null) as List? ?? [];
      final mapped = sessions.whereType<Map>().map((s) {
        final ws = s['workspace'] is Map ? s['workspace'] as Map : const {};
        return {
          'id': s['sessionId']?.toString() ?? '',
          'title': (s['title']?.toString().isNotEmpty ?? false)
              ? s['title'].toString()
              : s['sessionId'].toString(),
          'createdAt': _num(s['createdAt']),
          'updatedAt': _num(s['updatedAt']),
          'messageCount': 0,
          'preview': s['preview']?.toString() ?? '',
          'isRunning': s['status'] == 'running',
          'workspacePath': ws['workspacePath']?.toString(),
        };
      }).toList();
      return [
        WsMessage(event: 'session:list:response', data: {
          'sessions': mapped,
          'runningSessionIds': [
            for (final s in mapped)
              if (s['isRunning'] == true) s['id'],
          ],
          'taskStatuses': <String, dynamic>{},
          'activeSessionId': null,
        }),
      ];

    case 'session/messages':
      final rows = (result is Map ? result['messages'] : null) as List? ?? [];
      final mapped = <Map<String, dynamic>>[];
      String? sessionId;
      for (final row in rows.whereType<Map>()) {
        final info = row['info'] is Map ? row['info'] as Map : const {};
        sessionId = sessionId ?? info['sessionId']?.toString();
        final m = _mapEngineMessage(row);
        if (m != null) mapped.add(m);
      }
      return [
        WsMessage(event: 'session:load:response', data: {
          'sessionId': sessionId ?? '',
          'messages': mapped,
          'total': mapped.length,
          'offset': 0,
          'hasMore': false,
        }),
      ];

    case 'session/create':
      final session = result is Map ? result['session'] : null;
      final sessionId = session is Map ? session['sessionId']?.toString() : null;
      return [
        WsMessage(event: 'session:create:response', data: {
          'session': {
            'id': sessionId ?? '',
            'title': 'New Session',
            'createdAt': DateTime.now().millisecondsSinceEpoch,
            'updatedAt': DateTime.now().millisecondsSinceEpoch,
            'messageCount': 0,
          },
        }),
      ];
  }
  return const [];
}

/// app-server 消息行（info+parts）→ 旧 ChatMessage JSON（snake_case）
Map<String, dynamic>? _mapEngineMessage(Map row) {
  final info = row['info'] is Map ? row['info'] as Map : const {};
  final role = info['role'] == 'user' ? 'user' : 'assistant';
  final parts = row['parts'] as List? ?? [];
  var content = '';
  final toolCalls = <Map<String, dynamic>>[];
  Map<String, dynamic>? usage;
  var createdAt = DateTime.now().millisecondsSinceEpoch;
  final time = info['time'];
  if (time is Map && time['created'] is int) createdAt = time['created'] as int;
  for (final raw in parts.whereType<Map>()) {
    if (raw['type'] == 'text' && raw['text'] is String) {
      content += raw['text'] as String;
    } else if (raw['type'] == 'tool') {
      final state = raw['state'] is Map ? raw['state'] as Map : const {};
      toolCalls.add({
        'toolCallId': (raw['callId'] ?? state['callId'] ?? '').toString(),
        'toolName': (raw['tool'] ?? state['tool'] ?? '').toString(),
        'inputSummary': _truncate(state['input']),
        'outputSummary': _truncate(state['output']),
        'status': state['status'] == 'completed'
            ? 'done'
            : state['status'] == 'error' ? 'error' : 'running',
        'isError': state['status'] == 'error',
      });
    } else if (raw['type'] == 'step-finish') {
      final tokens = raw['tokens'] is Map ? raw['tokens'] as Map : null;
      if (tokens != null) {
        usage = {'input_tokens': tokens['total'] ?? 0, 'output_tokens': tokens['output'] ?? 0};
      }
    }
  }
  if (content.isEmpty && toolCalls.isEmpty) return null;
  return {
    'role': role,
    'content': content,
    'created_at': createdAt,
    if (toolCalls.isNotEmpty) 'tool_calls': toolCalls,
    if (usage != null) 'usage': usage,
  };
}

int _num(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

String? _truncate(dynamic v) {
  if (v is! String || v.isEmpty) return null;
  return v.length > 200 ? v.substring(0, 200) : v;
}
