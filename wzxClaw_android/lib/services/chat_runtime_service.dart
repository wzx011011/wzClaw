// ============================================================
// chat_runtime_service — 输入区运行时只读查询
//
// session/usage 实测返回 totalTokens/inputTokens/outputTokens/
// reasoningTokens/cacheReadTokens/modelRequestCount；协议不提供 contextWindow，
// 上下文百分比无法诚实计算。会话 mutation 统一由 ZcodeChatStore 执行并
// 回填状态，本服务不能成为第二写入口。
// ============================================================

import 'package:flutter/foundation.dart';

import 'connection_manager.dart';

/// 模型引用（providerId/modelId）：模型选择器与重试流共用的轻量值类型
/// （home_page 构造与消费；读取入口已统一到 NodeCatalogService / store）。
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
  static Future<dynamic> Function(
    String method, [
    Map<String, dynamic>? params,
  ])? debugRequester;

  Future<dynamic> _call(String method, [Map<String, dynamic>? params]) {
    final requester = debugRequester;
    if (requester != null) return requester(method, params);
    return ConnectionManager.instance.zcodeRequest(method, params);
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

  // 模型与思考档位 mutation 已迁 ZcodeChatStore，保证协议生效与页面投影
  // 同步更新；本服务只保留运行时读取。

  // 思考档位设置已迁直连栈（ZcodeChatStore.setThoughtLevel：枚举经
  // 2026-09-17 真机探针实测 low|high|max，且乐观回显 store.thoughtLevel）。
}
