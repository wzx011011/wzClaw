// ============================================================
// chat_runtime_service 单元测试 — 输入区快捷钮的协议形状钉住
//
// 依据（APP-SERVER.md 2026-09-16 实测）：
// - session/messages 的 info.modelID/providerID 用于历史模型去重
// - session/setModel 必须对象形式 {providerId, modelId}
// - session/setThoughtLevel 用 thoughtLevel 键（level 被 zod 拒）
// - session/usage 实测字段映射
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/chat_runtime_service.dart';

void main() {
  tearDown(() {
    ChatRuntimeService.debugRequester = null;
  });

  test('sessionModels：从消息 info 去重提取模型，最新在前，空值跳过', () async {
    Map<String, dynamic>? captured;
    ChatRuntimeService.debugRequester = (method, [params]) async {
      captured = params;
      return {'messages': [
        {'info': {'role': 'user', 'modelID': '', 'providerID': ''}},
        {'info': {'role': 'assistant', 'modelID': 'glm-5.3', 'providerID': 'builtin:bigmodel-coding-plan'}},
        {'info': {'role': 'assistant', 'modelID': 'glm-5.3', 'providerID': 'builtin:bigmodel-coding-plan'}},
        {'info': {'role': 'assistant', 'modelID': 'glm-5.3-flash', 'providerID': 'builtin:bigmodel-coding-plan'}},
      ],};
    };

    final models = await ChatRuntimeService.instance.sessionModels('sess-1');

    expect(captured, {'sessionId': 'sess-1', 'limit': 40});
    // 倒序扫：最新的 flash 在前，重复的 glm-5.3 去重
    expect(models.map((m) => m.modelId).toList(), ['glm-5.3-flash', 'glm-5.3']);
    expect(models.first.providerId, 'builtin:bigmodel-coding-plan');
  });

  test('usage：实测字段映射到 ChatUsageInfo', () async {
    String? method;
    ChatRuntimeService.debugRequester = (m, [params]) async {
      method = m;
      return {
        'totalTokens': 1722446,
        'inputTokens': 1371333,
        'outputTokens': 351113,
        'reasoningTokens': 0,
        'cacheReadTokens': 493376,
        'modelRequestCount': 637,
      };
    };

    final u = await ChatRuntimeService.instance.usage('sess-1');

    expect(method, 'session/usage');
    expect(u.totalTokens, 1722446);
    expect(u.cacheReadTokens, 493376);
    expect(u.modelRequestCount, 637);
  });

  test('setModel：对象形式 model{providerId, modelId}（字符串形式实测被 -32602 拒）', () async {
    Map<String, dynamic>? captured;
    ChatRuntimeService.debugRequester = (m, [params]) async {
      captured = params;
      return {'ok': true};
    };

    await ChatRuntimeService.instance.setModel('sess-1', 'prov', 'model-x');

    expect(captured, {
      'sessionId': 'sess-1',
      'model': {'providerId': 'prov', 'modelId': 'model-x'},
    });
  });

  test('setThoughtLevel：用 thoughtLevel 键（level 键实测被 zod 拒）', () async {
    Map<String, dynamic>? captured;
    ChatRuntimeService.debugRequester = (m, [params]) async {
      captured = params;
      return {'ok': true};
    };

    await ChatRuntimeService.instance.setThoughtLevel('sess-1', 'high');

    expect(captured, {'sessionId': 'sess-1', 'thoughtLevel': 'high'});
  });
}
