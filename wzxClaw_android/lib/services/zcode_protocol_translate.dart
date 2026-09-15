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

import 'package:flutter/foundation.dart';

import '../models/ws_message.dart';

/// 解析配对链接（宽容 scheme 版）：https/http/wss/ws 均可。
/// 旧 UI 的地址校验只放行 wss://，因此 wss 形式的配对链接也必须可用。
/// 返回 relay 的 ws 地址（wss/ws 原样保留 scheme，http(s) 按升级规则转换）。
({String relayWsUrl, String sid, String hash})? parsePairingUrlAny(String url) {
  try {
    final uri = Uri.parse(url.trim());
    final scheme = uri.scheme.toLowerCase();
    final isHttp = scheme == 'https' || scheme == 'http';
    final isWs = scheme == 'wss' || scheme == 'ws';
    if (!isHttp && !isWs) return null;
    final sid = uri.queryParameters['sid'] ?? '';
    final hash = uri.queryParameters['hash'] ?? '';
    if (sid.isEmpty || sid.length > 256 || hash.isEmpty) return null;
    final wsScheme = isHttp ? (scheme == 'https' ? 'wss' : 'ws') : scheme;
    return (
      relayWsUrl: '$wsScheme://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}/ws',
      sid: sid,
      hash: hash,
    );
  } catch (_) {
    return null;
  }
}

/// 扫码结果 → 设置页地址栏应填内容（配对链接专用）。
/// https/http 升级为 wss/ws 以通过地址校验；路径与查询参数（sid/hash/name）
/// 原样保留——链接本身就是完整凭据，任何剥参都会破坏配对。
/// 非配对链接（无 sid+hash）返回 null，调用方走旧 token 二维码后处理。
String? normalizeQrScanToServerUrl(String raw) {
  if (parsePairingUrlAny(raw) == null) return null;
  final uri = Uri.parse(raw.trim());
  final scheme = uri.scheme.toLowerCase();
  final wsScheme =
      scheme == 'https' ? 'wss' : scheme == 'http' ? 'ws' : scheme;
  return uri.replace(scheme: wsScheme).toString();
}

/// 反向请求（app-server → 手机）登记信息
class ReverseRequestInfo {
  final dynamic frameId;
  final String kind; // 'permission' | 'ask_user'
  /// 权限请求的 options 原文（含每个 option 的 response 应答模板——
  /// 应答的本质是回放所选 option 的 response，其它形状一律被服务端
  /// 静默按 deny 处理，见 APP-SERVER.md「畸形应答实验」）
  final List<Map>? permissionOptions;
  const ReverseRequestInfo(this.frameId, this.kind, {this.permissionOptions});
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
  // 与 relay/zcode/lib/protocol.js 的权威正则保持一致
  return m.contains('permission') || m.contains('confirm') ||
      m.contains('approval') || m.contains('approve') ||
      m.contains('askuser') || m.contains('ask_user') ||
      m.contains('ask-user') || m.contains('interaction');
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
  // 判定顺序：permission 最先（interaction/requestPermission 含 interaction
  // 前缀，先判 ask 会误路由）；裸 interaction 且带 question/options 才是 AskUser
  final isPermission = lower.contains('permission');
  if (!isPermission &&
      (lower.contains('askuser') || lower.contains('ask_user') ||
          lower.contains('ask-user'))) {
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
  final options = (p['options'] as List? ?? [])
      .whereType<Map>()
      .map((o) => Map<String, dynamic>.from(o))
      .toList();
  final requestKey = (p['requestId'] ?? toolCallId).toString();
  final event = WsMessage(event: 'stream:agent:permission_request', data: {
    'requestId': requestKey,
    'toolCallId': toolCallId,
    'toolName': p['toolName'] ?? p['tool'] ?? p['name'] ?? '',
    'input': p['input'] ?? p['params'] ?? p['arguments'] ?? {},
    'reason': p['reason']?.toString() ?? '',
    'riskLevel': p['riskLevel']?.toString() ?? '',
    'options': options,
    'sessionId': p['sessionId']?.toString() ?? '',
  });
  registerReverse(
    ReverseRequestInfo(frameId, 'permission', permissionOptions: options),
    event,
  );
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
  // 工具事件实测轨迹（APP-SERVER.md「工具事件序列」）：
  // scheduled → started → progress×N → result → batch
  if (kind == 'scheduled' || kind == 'started') {
    out.add(WsMessage(event: 'stream:agent:tool_call', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId'] ?? p['callId']),
      'toolName': content(p['toolName'] ?? p['tool']),
      'input': const {},
    }));
  } else if (kind == 'result' || kind == 'tool.result') {
    // result.payload: {toolCallId, result:{success, content,...}, duration}
    final inner = p['result'] is Map ? p['result'] as Map : const {};
    final output = inner['content']?.toString() ?? '';
    out.add(WsMessage(event: 'stream:agent:tool_result', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId'] ?? p['callId']),
      'output': output.length > 2000 ? output.substring(0, 2000) : output,
      'isError': inner['success'] == false,
    }));
  } else if (kind == 'permission.resolved') {
    // {requestId, toolCallId, decision, reason}：交由调用方清待答表
    out.add(WsMessage(event: 'stream:agent:permission_resolved', data: {
      'sessionId': sessionId,
      'requestId': content(p['requestId']),
      'toolCallId': content(p['toolCallId']),
      'decision': content(p['decision']),
    }));
  } else if (kind == 'progress' || kind == 'batch') {
    // 进度/批次心跳：旧协议无对应事件，忽略（有观测计数）
    debugPrint('[translate] tool $kind: ${content(p['toolName'])}');
  } else if (kind != null && kind.startsWith('tool.')) {
    // 兼容旧观察词表
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
      final limit = 200; // 与 ConnectionManager 请求一致
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
          // 尾窗语义：返回条数==limit 即可能还有更旧消息
          'hasMore': rows.length >= limit,
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
        'toolCallId': (raw['callID'] ?? raw['callId'] ?? state['callId'] ?? '').toString(),
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
