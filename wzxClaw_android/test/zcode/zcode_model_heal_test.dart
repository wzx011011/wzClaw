// ============================================================
// zcodeSetModelResend — 「模型已不可用」自愈尾段（setModel → close →
// resume → send，顺序不可变）
//
// 钉住契约（APP-SERVER.md「session/send 字符串 result 业务拒绝」+
// probe-modelheal4 时序 RESULT: healed-by-setmodel-rematerialize）：
// - 时序 setModel → close → resume → send，只 setModel 重发仍 -32031；
// - imported 模型必填 reasoningLevel：传入时 setModel params 必带
//   options.reasoningLevel，不传则不带 options；
// - 自愈重发再被拒 / 任一步失败 → 带原始 reason 的指引文案。
// （zcodeSendWithHeal / zcodeHealWithAvailableModel 已随换芯桥退役删除。）
// ============================================================

import 'dart:collection';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_model_heal.dart';

void main() {
  const unavailable =
      '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。';

  /// 按 [script]（method → 响应/抛出）回放；调用序列记录进 [calls]，
  /// 请求参数记录进 [paramsOf]。同一 method 多次调用按列表顺序出队。
  (Future<dynamic> Function(String, [Map<String, dynamic>?]), List<String>,
      Map<String, List<Map<String, dynamic>?>>)
  scripted(Map<String, List<Object?>> script) {
    final calls = <String>[];
    final paramsOf = <String, List<Map<String, dynamic>?>>{};
    final queues = {
      for (final e in script.entries) e.key: Queue<Object?>.from(e.value),
    };
    Future<dynamic> fn(String method, [Map<String, dynamic>? params]) {
      calls.add(method);
      paramsOf.putIfAbsent(method, () => []).add(params);
      final q = queues[method];
      if (q == null || q.isEmpty) {
        throw StateError('script 缺少 $method 的响应');
      }
      final next = q.removeFirst();
      if (next is Exception) return Future.error(next);
      if (next is Function) return Future.sync(() => next());
      return Future.value(next);
    }

    return (fn, calls, paramsOf);
  }

  test('自愈时序固定：setModel → close → resume → send，成功返回 null', () async {
    final (fn, calls, _) = scripted({
      'session/setModel': [{}],
      'session/close': [
        {'closed': true},
      ],
      'session/resume': [
        {'ok': true},
      ],
      'session/send': [
        {'accepted': true},
      ],
    });
    final error = await zcodeSetModelResend(
      request: fn,
      sessionId: 's',
      content: 'hi',
      providerId: 'builtin:p',
      modelId: 'glm-x',
      reason: unavailable,
    );
    expect(error, isNull);
    expect(calls, [
      'session/setModel',
      'session/close',
      'session/resume',
      'session/send',
    ]);
  });

  test('reasoningLevel 传入时 setModel 带 options；不传则不带（imported 模型契约）',
      () async {
    final (fn, _, paramsOf) = scripted({
      'session/setModel': [{}, {}],
      'session/close': [{}, {}],
      'session/resume': [{}, {}],
      'session/send': [{}, {}],
    });
    await zcodeSetModelResend(
      request: fn,
      sessionId: 's',
      content: 'hi',
      providerId: 'builtin:p',
      modelId: 'glm-x',
      reason: unavailable,
      reasoningLevel: 'high',
    );
    await zcodeSetModelResend(
      request: fn,
      sessionId: 's',
      content: 'hi',
      providerId: 'builtin:p',
      modelId: 'glm-x',
      reason: unavailable,
    );
    final withLevel = paramsOf['session/setModel']![0]!;
    expect(withLevel['model'], {
      'providerId': 'builtin:p',
      'modelId': 'glm-x',
      'options': {'reasoningLevel': 'high'},
    });
    final withoutLevel = paramsOf['session/setModel']![1]!;
    expect(withoutLevel['model'], {
      'providerId': 'builtin:p',
      'modelId': 'glm-x',
    });
  });

  test('重发仍被拒（字符串 result）→ 带指引文案', () async {
    final (fn, _, _) = scripted({
      'session/setModel': [{}],
      'session/close': [{}],
      'session/resume': [{}],
      'session/send': [unavailable],
    });
    final error = await zcodeSetModelResend(
      request: fn,
      sessionId: 's',
      content: 'hi',
      providerId: 'builtin:p',
      modelId: 'glm-x',
      reason: unavailable,
    );
    expect(error, contains('已自动切换可用模型仍被拒'));
    expect(error, contains('请新建会话继续'));
  });

  test('自愈链任一步失败 → 文案带原始 reason 与真实错误，不得冒充模型问题',
      () async {
    final (fn, _, _) = scripted({
      'session/setModel': [Exception('network down')],
    });
    final error = await zcodeSetModelResend(
      request: fn,
      sessionId: 's',
      content: 'hi',
      providerId: 'builtin:p',
      modelId: 'glm-x',
      reason: unavailable,
    );
    expect(error, contains(unavailable));
    expect(error, contains('network down'));
  });
}
