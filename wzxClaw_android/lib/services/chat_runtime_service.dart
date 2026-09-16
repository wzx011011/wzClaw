// ============================================================
// chat_runtime_service — 输入区快捷钮的运行时查询/设置
//
// 协议依据（APP-SERVER.md，2026-09-16 probe-runtime*.js 实测）：
// - session/usage：{sessionId} → totalTokens/inputTokens/outputTokens/
//   reasoningTokens/cacheReadTokens/modelRequestCount/...（✅ 实测可用；
//   协议不提供 contextWindow，上下文百分比无法诚实计算，故不显示）
// - session/setModel：{sessionId, model:{providerId, modelId}}（✅ 已实测，
//   字符串形式被 -32602 拒）
// - session/setThoughtLevel：{sessionId, thoughtLevel}（✅ 方法存在——level
//   键被 zod 拒、thoughtLevel 键通过校验；档位枚举值未实测到样本，先按
//   官方 UI 三档 low/high/max 实现，错误显性上浮）
// - 模型目录：协议不存在（session/models 等候选全 -32601）。模型选项取
//   本会话历史用过的模型（session/messages 的 info.modelID/providerID，
//   已实测字段），不做假目录。
// ============================================================

import 'package:flutter/foundation.dart';

import 'connection_manager.dart';

class SessionModelUse {
  final String providerId;
  final String modelId;
  const SessionModelUse({required this.providerId, required this.modelId});
}

class ChatUsageInfo {
  final int totalTokens;
  final int inputTokens;
  final int outputTokens;
  final int reasoningTokens;
  final int cacheReadTokens;
  final int modelRequestCount;
  const ChatUsageInfo({
    required this.totalTokens,
    required this.inputTokens,
    required this.outputTokens,
    required this.reasoningTokens,
    required this.cacheReadTokens,
    required this.modelRequestCount,
  });
}

class ChatRuntimeService {
  ChatRuntimeService._();
  static final ChatRuntimeService instance = ChatRuntimeService._();

  /// 仅测试使用：注入请求实现
  @visibleForTesting
  static Future<dynamic> Function(String method, [Map<String, dynamic>? params])?
      debugRequester;

  Future<dynamic> _call(String method, [Map<String, dynamic>? params]) {
    final requester = debugRequester;
    if (requester != null) return requester(method, params);
    return ConnectionManager.instance.zcodeRequest(method, params);
  }

  /// 本会话历史用过的模型（最新在前，去重，不含空值）
  Future<List<SessionModelUse>> sessionModels(String sessionId) async {
    final r = await _call('session/messages', {'sessionId': sessionId, 'limit': 40});
    if (r is! Map) throw StateError('消息响应异常');
    final messages = (r['messages'] as List? ?? []);
    final seen = <String>[];
    final result = <SessionModelUse>[];
    // messages 按时间升序（实测契约）：倒序扫，最新模型排前
    for (final m in messages.reversed) {
      final info = (m is Map && m['info'] is Map) ? m['info'] as Map : const {};
      final modelId = info['modelID']?.toString() ?? '';
      final providerId = info['providerID']?.toString() ?? '';
      if (modelId.isEmpty || providerId.isEmpty) continue;
      final key = '$providerId/$modelId';
      if (seen.contains(key)) continue;
      seen.add(key);
      result.add(SessionModelUse(providerId: providerId, modelId: modelId));
    }
    return result;
  }

  /// 可用模型目录：session/resume 响应的 settings.model.available（实测形状，
  /// 模型自愈同源）。失败（-32004 会话未激活等）由调用方降级到 [sessionModels]。
  Future<List<SessionModelUse>> availableModels(String sessionId) async {
    final r = await _call('session/resume', {'sessionId': sessionId});
    if (r is! Map) throw StateError('resume 响应异常');
    final settings = r['settings'] is Map ? r['settings'] as Map : const {};
    final modelCfg = settings['model'] is Map ? settings['model'] as Map : const {};
    final available = modelCfg['available'] as List? ?? const [];
    final result = <SessionModelUse>[];
    for (final item in available) {
      final ref = item is Map && item['ref'] is Map ? item['ref'] as Map : null;
      if (ref == null) continue;
      final providerId = ref['providerId']?.toString() ?? '';
      final modelId = ref['modelId']?.toString() ?? '';
      if (providerId.isEmpty || modelId.isEmpty) continue;
      result.add(SessionModelUse(providerId: providerId, modelId: modelId));
    }
    return result;
  }

  /// 会话 token 用量（session/usage 实测形状）
  Future<ChatUsageInfo> usage(String sessionId) async {
    final r = await _call('session/usage', {'sessionId': sessionId});
    if (r is! Map) throw StateError('用量响应异常');
    int asInt(String k) => (r[k] is num) ? (r[k] as num).toInt() : 0;
    return ChatUsageInfo(
      totalTokens: asInt('totalTokens'),
      inputTokens: asInt('inputTokens'),
      outputTokens: asInt('outputTokens'),
      reasoningTokens: asInt('reasoningTokens'),
      cacheReadTokens: asInt('cacheReadTokens'),
      modelRequestCount: asInt('modelRequestCount'),
    );
  }

  /// 切换模型（session/setModel 实测：对象形式，字符串会被拒）
  Future<void> setModel(
    String sessionId,
    String providerId,
    String modelId,
  ) async {
    await _call('session/setModel', {
      'sessionId': sessionId,
      'model': {'providerId': providerId, 'modelId': modelId},
    });
  }

  /// 设置思考档位。枚举值未实测（协议无读回方法），错误显性上浮。
  Future<void> setThoughtLevel(String sessionId, String level) async {
    await _call('session/setThoughtLevel', {
      'sessionId': sessionId,
      'thoughtLevel': level,
    });
  }
}
