// ============================================================
// zcodeSendWithHeal — command:send 全路径（发送 → 自愈 → 补订阅）
//
// 钉住契约（APP-SERVER.md「session/send 字符串 result 业务拒绝」+
// probe-modelheal4 时序）：
// - 字符串 result 含「模型」/ 错误帧 -32031 → 自动自愈
//   resume → setModel → close → resume → send（顺序不可变）
// - 自愈成功必须补发订阅；失败必须回传带原因的文案 + kind
// - 非模型类拒绝/异常不得触发自愈（不擅改桌面端会话配置）
// ============================================================

import 'dart:collection';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_model_heal.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart'
    show ZcodeRequestException;

void main() {
  const unavailable =
      '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。';
  final availableResume = {
    'settings': {
      'model': {
        'available': [
          {
            'ref': {'providerId': 'builtin:p', 'modelId': 'glm-x'},
          },
        ],
      },
    },
  };

  /// 按 [script]（method → 响应/抛出）回放；调用序列记录进 [calls]。
  /// 同一 method 多次调用按 script 中该 key 的列表顺序出队。
  (Future<dynamic> Function(String, [Map<String, dynamic>?]), List<String>)
      scripted(Map<String, List<Object?>> script) {
    final calls = <String>[];
    final queues = {
      for (final e in script.entries) e.key: Queue<Object?>.from(e.value),
    };
    Future<dynamic> fn(String method, [Map<String, dynamic>? params]) {
      calls.add(method);
      final q = queues[method];
      if (q == null || q.isEmpty) {
        throw StateError('script 缺少 $method 的响应');
      }
      final next = q.removeFirst();
      if (next is Exception) return Future.error(next);
      if (next is Function) return Future.sync(() => next());
      return Future.value(next);
    }

    return (fn, calls);
  }

  group('zcodeSendWithHeal', () {
    test('直发成功：send → subscribe，无自愈', () async {
      final (fn, calls) = scripted({
        'session/send': [
          {'accepted': true},
        ],
        'session/subscribe': [{}],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(error, isNull);
      expect(kind, isNull);
      expect(calls, ['session/send', 'session/subscribe']);
    });

    test('字符串模型拒绝 → 自愈成功时序 send→resume→setModel→close→resume→send→subscribe',
        () async {
      final (fn, calls) = scripted({
        'session/send': [unavailable, {'accepted': true}],
        'session/resume': [availableResume, {}],
        'session/setModel': [{}],
        'session/close': [
          {'closed': true},
        ],
        'session/subscribe': [{}],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(error, isNull);
      expect(kind, isNull);
      expect(calls, [
        'session/send',
        'session/resume',
        'session/setModel',
        'session/close',
        'session/resume',
        'session/send',
        'session/subscribe',
      ]);
    });

    test('-32031 错误帧同样触发自愈', () async {
      final (fn, calls) = scripted({
        'session/send': [
          const ZcodeRequestException(-32031, 'ZCODE_RUNTIME_MODEL_UNAVAILABLE'),
          {'accepted': true},
        ],
        'session/resume': [availableResume, {}],
        'session/setModel': [{}],
        'session/close': [{}],
        'session/subscribe': [{}],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(error, isNull);
      expect(kind, isNull);
      expect(calls, contains('session/setModel'));
    });

    test('自愈后重发仍被拒 → 带指引文案 + model-unavailable，不再补订阅', () async {
      final (fn, calls) = scripted({
        'session/send': [unavailable, unavailable],
        'session/resume': [availableResume, {}],
        'session/setModel': [{}],
        'session/close': [{}],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(kind, 'model-unavailable');
      expect(error, contains('请新建会话继续'));
      expect(calls.last, isNot('session/subscribe'));
    });

    test('无可用模型 → 明确文案 + model-unavailable', () async {
      final (fn, _) = scripted({
        'session/send': [unavailable],
        'session/resume': [
          {
            'settings': {
              'model': {'available': []},
            },
          },
        ],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(kind, 'model-unavailable');
      expect(error, contains('无可用模型'));
    });

    test('非模型类字符串拒绝：原文透传，不触发自愈', () async {
      final (fn, calls) = scripted({
        'session/send': ['会话已被桌面端锁定'],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(error, '会话已被桌面端锁定');
      expect(kind, isNull);
      expect(calls, ['session/send']);
    });

    test('非模型类异常：普通错误文案，errorKind 为空', () async {
      final (fn, calls) = scripted({
        'session/send': [
          const ZcodeRequestException(-32004, 'session not readable'),
        ],
      });
      final (error, kind) = await zcodeSendWithHeal(
          request: fn, sessionId: 's', content: 'hi',);
      expect(kind, isNull);
      expect(error, contains('发送失败'));
      expect(calls, ['session/send']);
    });
  });
}
