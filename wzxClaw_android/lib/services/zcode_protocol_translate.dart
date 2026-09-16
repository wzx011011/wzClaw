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

import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/goal_snapshot.dart';
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
      // 实测推送形状（probe-stream-shape）：单事件，语义载荷在 params.payload，
      // 事件类型在 params.type（如 model.streaming / turn.completed）。
      return _translatePayload(sessionId, p['payload'], p['type']?.toString());
    }
    final out = <WsMessage>[];
    for (final ev in events) {
      final payload = ev is Map ? (ev['payload'] ?? ev) : ev;
      out.addAll(_translatePayload(
          sessionId, payload, ev is Map ? ev['type']?.toString() : null,),);
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
            },)
        .toList();
    final event = WsMessage(event: 'stream:agent:ask_user_question', data: {
      'questionId': questionId,
      'question': p['question']?.toString() ?? p['prompt']?.toString() ?? '',
      'options': options,
      'allowCustom': p['allowCustom'] == true || p['allow_multiple'] == true,
      'sessionId': p['sessionId']?.toString() ?? '',
    },);
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
  },);
  registerReverse(
    ReverseRequestInfo(frameId, 'permission', permissionOptions: options),
    event,
  );
  return [event];
}

List<WsMessage> _translatePayload(
    String sessionId, dynamic payload, String? outerType,) {
  final p = payload is Map ? payload : const {};
  final kind = p['kind']?.toString();
  // 词表来源：probe-stream-shape 实测。kind 在 payload 内（model.streaming /
  // tool.updated 的事件），kind 缺失时回退到外层事件 type（turn.completed、
  // permission.resolved 等无 kind 的事件）。
  final effectiveKind =
      kind ?? (outerType != null && outerType.isNotEmpty ? outerType : null);
  final out = <WsMessage>[];
  // streamRecovery.updated 的 payload.kind 是 tool_result/tool_error 簿记
  // （断线恢复锚点），不是工具完成事件，绝不能译成 tool_result。
  if (outerType == 'streamRecovery.updated') return out;
  String content(dynamic v) => v?.toString() ?? '';

  // 文本/思考增量（model.streaming kind=text_delta|reasoning_delta）
  if (effectiveKind == 'text_delta' ||
      (effectiveKind == null && (p['delta'] != null || p['text'] != null))) {
    final c = content(p['delta'] ?? p['text']);
    if (c.isNotEmpty) {
      out.add(WsMessage(event: 'stream:agent:text', data: {'sessionId': sessionId, 'content': c}));
    }
  }
  if (effectiveKind == 'reasoning_delta') {
    final c = content(p['delta'] ?? p['text']);
    if (c.isNotEmpty) {
      out.add(WsMessage(event: 'stream:agent:thinking', data: {'sessionId': sessionId, 'content': c}));
    }
  }
  // 工具输入流（kind=tool_call 携带完整已解析 input，probe 实测）。
  // tool_input_start 先建占位卡片（仅名字），tool_input_delta/end 忽略
  // （原始 JSON 分片，无展示价值）；ChatStore 按 toolCallId upsert 补全 input。
  if (effectiveKind == 'tool_input_start') {
    out.add(WsMessage(event: 'stream:agent:tool_call', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId']),
      'toolName': content(p['toolName']),
      'input': const {},
    },),);
  } else if (effectiveKind == 'tool_call') {
    out.add(WsMessage(event: 'stream:agent:tool_call', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId']),
      'toolName': content(p['toolName']),
      'input': p['input'] is Map ? Map<String, dynamic>.from(p['input'] as Map) : const {},
    },),);
  } else if (effectiveKind == 'scheduled' || effectiveKind == 'started') {
    // 兼容旧观察词表：无 input（inputOmitted），仅提前建卡
    out.add(WsMessage(event: 'stream:agent:tool_call', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId'] ?? p['callId']),
      'toolName': content(p['toolName'] ?? p['tool']),
      'input': const {},
    },),);
  } else if (effectiveKind == 'result' || effectiveKind == 'tool.result') {
    // result.payload: {toolCallId, result:{success, content,...}, duration}
    final inner = p['result'] is Map ? p['result'] as Map : const {};
    final output = inner['content']?.toString() ?? '';
    out.add(WsMessage(event: 'stream:agent:tool_result', data: {
      'sessionId': sessionId,
      'toolCallId': content(p['toolCallId'] ?? p['callId']),
      'output': output.length > 2000 ? output.substring(0, 2000) : output,
      'isError': inner['success'] == false,
    },),);
  } else if (effectiveKind == 'permission.resolved') {
    // {requestId, toolCallId, decision, reason}：交由调用方清待答表
    out.add(WsMessage(event: 'stream:agent:permission_resolved', data: {
      'sessionId': sessionId,
      'requestId': content(p['requestId']),
      'toolCallId': content(p['toolCallId']),
      'decision': content(p['decision']),
    },),);
  } else if (kind != null &&
      (kind == 'progress' || kind == 'batch')) {
    // 进度/批次心跳：旧协议无对应事件，忽略（有观测计数）
    debugPrint('[translate] tool $kind: ${content(p['toolName'])}');
  } else if (kind != null && kind.startsWith('tool.')) {
    // 兼容旧观察词表（仅 payload.kind，避免误吞外层 type=tool.updated）
    final callId = content(p['callId'] ?? p['toolCallId'] ?? p['id']);
    final toolName = content(p['tool'] ?? p['name']);
    if (kind == 'tool.call' || kind == 'tool.use' || kind == 'tool_start') {
      out.add(WsMessage(event: 'stream:agent:tool_call', data: {
        'sessionId': sessionId,
        'toolCallId': callId,
        'toolName': toolName,
        'input': p['input'] ?? p['params'] ?? '',
      },),);
    } else {
      final output = p['output'] is String ? p['output'] : (p['output']?.toString() ?? '');
      out.add(WsMessage(event: 'stream:agent:tool_result', data: {
        'sessionId': sessionId,
        'toolCallId': callId,
        'output': output.length > 2000 ? output.substring(0, 2000) : output,
        'isError': kind.contains('error'),
      },),);
    }
  }
  if (effectiveKind == 'turn.started') {
    out.add(WsMessage(event: 'stream:agent:running', data: {'sessionId': sessionId}));
  }
  if (effectiveKind == 'turn.terminal' || effectiveKind == 'turn.completed') {
    final status = content(p['status'] ?? p['resultType']);
    out.add(WsMessage(event: 'stream:agent:turn_end', data: {
      'sessionId': sessionId,
      'status': status,
    },),);
    out.add(WsMessage(event: 'stream:agent:done', data: {
      'sessionId': sessionId,
      'status': status,
      'usage': p['usage'],
      // turn.completed: {duration(ms), toolCallCount, response,...} → 已工作时长
      'durationMs': p['duration'],
    },),);
  }
  if (effectiveKind == 'model.error' || p['isError'] == true) {
    out.add(WsMessage(event: 'stream:agent:error', data: {
      'sessionId': sessionId,
      'error': content(p['error'] ?? p['message']),
    },),);
  }
  // agent 归属透传（payload 若携带）：子智能体事件据此折叠进卡片
  final agent = p['agent']?.toString() ??
      p['agentId']?.toString() ??
      '';
  if (agent.isNotEmpty && out.isNotEmpty) {
    return [
      for (final e in out)
        WsMessage(
          event: e.event,
          data: {...(e.data as Map? ?? const {}), 'agent': agent},
        ),
    ];
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
      },),
    ];
  }
  switch (method) {
    case 'session/list':
      final sessions = (result is Map ? result['sessions'] : null) as List? ?? [];
      final mapped =
          sessions.whereType<Map>().map(_mapSessionRow).toList();
      return [
        WsMessage(event: 'session:list:response', data: {
          'sessions': mapped,
          'runningSessionIds': [
            for (final s in mapped)
              if (s['isRunning'] == true) s['id'],
          ],
          'taskStatuses': <String, dynamic>{},
          'activeSessionId': null,
        },),
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
          // 尾窗语义诚实化：engine 的 session/resume / session/messages 只给
          // 最新 N 条滑窗，没有全量序列的 offset 锚点——旧协议的「hasMore+
          // offset 翻页」在此无法成立（曾致 ≥200 条会话翻页循环、时间线整片
          // 重复）。hasMore 恒 false，终止翻页；真分页待 afterMessageId 实测
          // 后另接（APP-SERVER.md 已支持 afterMessageId，未实测形状）。
          'hasMore': false,
        },),
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
        },),
      ];
  }
  return const [];
}

/// 工作区分组条目：session/list 结果按 workspaceKey 聚合。
/// [key] 为权威分组键（workspaceKey），[sessions] 为已映射的旧协议会话行。
class WorkspaceGroup {
  final String key;
  final String path;
  final List<Map<String, dynamic>> sessions;
  final int newestUpdatedAt;
  const WorkspaceGroup({
    required this.key,
    required this.path,
    required this.sessions,
    required this.newestUpdatedAt,
  });
}

/// session/list 结果 → 工作区分组（最新活跃在前）。
/// workspaceKey 是权威键（路径大小写可能不一致）；每条会话行带 workspacePath。
List<WorkspaceGroup> groupSessionsByWorkspace(dynamic result) {
  final sessions = (result is Map ? result['sessions'] : null) as List? ?? [];
  final groups = <String, WorkspaceGroup>{};
  for (final s in sessions.whereType<Map>()) {
    final ws = s['workspace'] is Map ? s['workspace'] as Map : const {};
    final key = ws['workspaceKey']?.toString() ??
        ws['workspacePath']?.toString() ??
        '';
    if (key.isEmpty) continue;
    final row = _mapSessionRow(s);
    final updatedAt = row['updatedAt'] as int? ?? 0;
    final g = groups[key];
    if (g == null) {
      groups[key] = WorkspaceGroup(
        key: key,
        path: ws['workspacePath']?.toString() ?? key,
        sessions: [row],
        newestUpdatedAt: updatedAt,
      );
    } else {
      g.sessions.add(row);
      if (updatedAt > g.newestUpdatedAt) {
        // WorkspaceGroup 不可变，替换为更新了 newest 的实例
        groups[key] = WorkspaceGroup(
          key: g.key,
          path: g.path,
          sessions: g.sessions,
          newestUpdatedAt: updatedAt,
        );
      }
    }
  }
  final list = groups.values.toList()
    ..sort((a, b) => b.newestUpdatedAt.compareTo(a.newestUpdatedAt));
  return list;
}

/// 选中工作区解析：显式选中键优先（大小写不敏感回退），否则最新活跃组。
WorkspaceGroup? resolveWorkspace(
    List<WorkspaceGroup> groups, String? selectedKey,) {
  if (groups.isEmpty) return null;
  if (selectedKey != null && selectedKey.isNotEmpty) {
    for (final g in groups) {
      if (g.key == selectedKey) return g;
    }
    for (final g in groups) {
      if (g.key.toLowerCase() == selectedKey.toLowerCase()) return g;
    }
    // 键未命中时按路径兜底（workspace:switch 传的是路径）
    for (final g in groups) {
      if (g.path.toLowerCase() == selectedKey.toLowerCase()) return g;
    }
    return null;
  }
  return groups.first; // 已按最新活跃排序
}

/// 旧协议 workspace:list:response（新格式：工作区卡片内嵌会话，
/// SessionSyncService._handleWorkspaceListResponse 的新格式分支）
WsMessage workspaceListWsResponse(String requestId, List<WorkspaceGroup> groups) {
  return WsMessage(event: 'workspace:list:response', data: {
    'requestId': requestId,
    'workspaces': [
      for (final g in groups)
        {
          'id': g.key,
          'title': workspaceBasename(g.path),
          'projects': [
            {'id': '', 'path': g.path, 'name': workspaceBasename(g.path)},
          ],
          'sessions': [
            for (final s in g.sessions)
              {
                'id': s['id'],
                'title': s['title'],
                'updatedAt': s['updatedAt'],
                'messageCount': s['messageCount'],
                'isRunning': s['isRunning'],
              },
          ],
          'activeSessionId': null,
          'runningSessionIds': [
            for (final s in g.sessions)
              if (s['isRunning'] == true) s['id'],
          ],
          'updatedAt': g.newestUpdatedAt,
        },
    ],
  },);
}

/// 旧协议 session:list:response（顶层带当前工作区 + 仅该工作区的会话）
WsMessage sessionListWsResponse(
    String requestId, List<WorkspaceGroup> groups, String? selectedKey,) {
  final g = resolveWorkspace(groups, selectedKey);
  final sessions = g?.sessions ?? const <Map<String, dynamic>>[];
  return WsMessage(event: 'session:list:response', data: {
    'requestId': requestId,
    'workspacePath': g?.path ?? '',
    'workspaceName': g == null ? '' : workspaceBasename(g.path),
    'sessions': sessions,
    'runningSessionIds': [
      for (final s in sessions)
        if (s['isRunning'] == true) s['id'],
    ],
    'taskStatuses': <String, dynamic>{},
    'activeSessionId': null,
  },);
}

String workspaceBasename(String path) {
  final norm = path.replaceAll('\\', '/');
  final parts = norm.split('/').where((p) => p.isNotEmpty).toList();
  return parts.isEmpty ? path : parts.last;
}

/// app-server session/list 行 → 旧协议会话行（分组与平铺共用）
Map<String, dynamic> _mapSessionRow(Map s) {
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
}

/// session/goal 响应 → 悬浮窗快照（todos/todoGroups/goalStats）。
/// 非法形状返回空快照（isEmpty），调用方以此判空。
GoalSnapshot parseGoalSnapshot(dynamic result) {
  if (result is! Map) return const GoalSnapshot(todos: [], groups: []);
  return GoalSnapshot.fromEngineJson(result);
}

/// session/subagents {action:'show'} 响应 → 子智能体线程列表。
/// messages 行按 info.agent 聚合（缺 agent 的行归入 '子智能体'）。
List<SubagentThread> parseSubagentThreads(dynamic result) {
  final rows = (result is Map ? result['messages'] : null) as List? ?? [];
  final byAgent = <String, List<Map<String, dynamic>>>{};
  for (final row in rows.whereType<Map>()) {
    final info = row['info'] is Map ? row['info'] as Map : const {};
    final agent = info['agent']?.toString() ?? '';
    final m = _mapEngineMessage(row);
    if (m == null) continue;
    byAgent.putIfAbsent(agent, () => []).add(m);
  }
  final threads = byAgent.entries
      .map((e) => SubagentThread(agent: e.key, messages: e.value))
      .toList();
  threads.sort((a, b) => _threadNewest(b).compareTo(_threadNewest(a)));
  return threads;
}

int _threadNewest(SubagentThread t) {
  var newest = 0;
  for (final m in t.messages) {
    final ts = m['created_at'];
    if (ts is int && ts > newest) newest = ts;
  }
  return newest;
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
        'inputSummary': _toolInputSummary(
            (raw['tool'] ?? state['tool'] ?? '').toString(), state['input'],),
        'outputSummary': _truncate(state['output']?.toString()),
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
    // agent 归属：null = 主时间线（旧数据兼容），子智能体按此折叠
    if (info['agent'] is String && (info['agent'] as String).isNotEmpty)
      'agent': info['agent'],
  };
}

int _num(dynamic v) => v is int ? v : (v is num ? v.toInt() : 0);

/// 引擎 assistant 行的 tool_calls 拆成独立 tool_result 行。
///
/// 背景（2026-09-17 真机 probe 实测）：引擎历史里一步工具 = 一条 assistant 行
/// （parts=step-start,tool,step-finish），工具不是独立消息；而流式链路的工具
/// 是独立事件。两套表示不统一导致历史渲染时工具全部消失/错组（用户实测：
/// 全堆进最后一个 Working 组）。本函数把翻译后的行拆为与流式一致的形状：
/// 每个工具一条 tool_result 行，有文本时保留 assistant 行在工具之后。
/// created_at 递增 i 保证 DB 排序稳定；无 tool_calls 的行原样返回。
List<Map<String, dynamic>> expandEngineToolCalls(Map<String, dynamic> row) {
  final calls = row['tool_calls'] as List?;
  if (row['role'] != 'assistant' || calls is! List || calls.isEmpty) {
    return [row];
  }
  final agent = row['agent'];
  final out = <Map<String, dynamic>>[];
  var i = 0;
  for (final tc in calls.whereType<Map>()) {
    out.add({
      'role': 'tool_result',
      'content': (tc['outputSummary'] ?? '').toString(),
      'created_at': _num(row['created_at']) + i,
      'toolCallId': (tc['toolCallId'] ?? '').toString(),
      'toolName': (tc['toolName'] ?? '').toString(),
      'inputSummary': tc['inputSummary']?.toString(),
      'isError': tc['isError'] == true,
      if (agent is String && agent.isNotEmpty) 'agent': agent,
    });
    i += 1;
  }
  final text = row['content'] as String? ?? '';
  if (text.isNotEmpty) {
    out.add({
      ...row,
      'tool_calls': null,
      'created_at': _num(row['created_at']) + i,
    });
  }
  return out;
}

String? _truncate(dynamic v) {
  if (v is! String || v.isEmpty) return null;
  return v.length > 200 ? v.substring(0, 200) : v;
}

/// 工具输入 → 单行摘要（与 ChatStore._summarizeToolInput 同语义，
/// 纯函数版供历史行映射复用）。state.input 实测是 Map（对象）而非字符串。
String? _toolInputSummary(String toolName, dynamic input) {
  if (input == null) return null;
  if (input is String) return _truncate(input);
  if (input is! Map) return _truncate(input.toString());
  String pick(List<String> keys) {
    for (final k in keys) {
      final v = input[k];
      if (v is String && v.isNotEmpty) return v;
    }
    return '';
  }

  final s = switch (toolName) {
    'Bash' || 'Shell' || 'shell-execute' => pick(['command']),
    'Read' || 'Write' || 'Edit' || 'file-read' || 'file-write' || 'file-edit' =>
      pick(['file_path', 'filePath', 'path']),
    'Grep' || 'Glob' => pick(['pattern']),
    'WebSearch' || 'web-search' => pick(['query']),
    'WebFetch' || 'web-fetch' => pick(['url']),
    _ => pick(['command', 'file_path', 'filePath', 'path', 'pattern', 'url',
      'query', 'description',]),
  };
  if (s.isNotEmpty) return _truncate(s);
  // 兜底：第一个字符串值 → 压缩 JSON → toString
  for (final v in input.values) {
    if (v is String && v.isNotEmpty) return _truncate(v);
  }
  try {
    return _truncate(jsonEncode(input));
  } catch (_) {
    return _truncate(input.toString());
  }
}
