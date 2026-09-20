// ============================================================
// zcode_model_heal — 「模型已不可用」发送自愈（共享尾段）
//
// 历史/桌面端改配的会话可能钉在一个已下线的模型上：session/send 被
// 拒（字符串 result 或错误帧 -32031 / ZCODE_RUNTIME_MODEL_UNAVAILABLE）。
// 两条发送路径（旧 UI 换芯桥 ConnectionManager.command:send 与
// ZcodeChatStore.sendMessage）共用本模块的自愈时序，避免两份实现漂移。
//
// 时序出处：relay/zcode/probe-modelheal4.js 真链路验证
// （RESULT: healed-by-setmodel-rematerialize）：
//   setModel → close → resume → send
// - setModel model 为对象 {providerId, modelId, options?{reasoningLevel}}；
//   imported 模型必填 reasoningLevel（0.16.9 实测，缺失即 -32603）
// - close + resume 重新物化运行时是关键：只 setModel 后重发仍 -32031
// 可用模型的解析（缓存 vs resume 现取）由调用方各自完成。
// ============================================================

import 'package:flutter/foundation.dart';

import 'zcode_relay_client.dart' show ZcodeRequestException;

/// app-server 请求函数形状（ZcodeRelayClient.request 的签名子集）
typedef ZcodeRequestFn = Future<dynamic> Function(
  String method, [
  Map<String, dynamic>? params,
]);

/// setModel + 重新物化 + 重发一次。
///
/// [reasoningLevel]：imported 模型（Codex/DeepSeek 导入）setModel 必填
/// 推理档位（实测契约，缺失即 -32603）；无档位模型传 null、不带 options。
///
/// 返回 null = 重发已被接受（订阅由调用方按各自链路补发）；
/// 非 null = 给用户看的错误文案（已含原始 [reason]）。
Future<String?> zcodeSetModelResend({
  required ZcodeRequestFn request,
  required String sessionId,
  required String content,
  required String providerId,
  required String modelId,
  required String reason,
  String? reasoningLevel,
}) async {
  try {
    await request('session/setModel', {
      'sessionId': sessionId,
      'model': {
        'providerId': providerId,
        'modelId': modelId,
        if (reasoningLevel != null && reasoningLevel.isNotEmpty)
          'options': {'reasoningLevel': reasoningLevel},
      },
    });
    await request('session/close', {'sessionId': sessionId});
    await request('session/resume', {'sessionId': sessionId});
    final retry = await request('session/send', {
      'sessionId': sessionId,
      'content': content,
    });
    if (retry is String) {
      return '发送失败：$retry。已自动切换可用模型仍被拒，请新建会话继续。';
    }
    return null;
  } catch (e) {
    // 自愈链任何一步失败 → 带上真实失败原因。吞掉真实错误会造成误导：
    // 网络断开/setModel -32602 会被误报成「历史模型已下线」
    return '发送失败：$reason。自动切换可用模型未成功（$e），请新建会话继续。';
  }
}

/// 「模型已不可用」自愈（桥内无模型缓存）：resume 现取可用模型后走
/// [zcodeSetModelResend] 共享尾段。返回 null = 已恢复。
Future<String?> zcodeHealWithAvailableModel({
  required ZcodeRequestFn request,
  required String sessionId,
  required String content,
  required String reason,
}) async {
  try {
    final resume = await request('session/resume', {'sessionId': sessionId});
    final settings = resume is Map ? resume['settings'] as Map? : null;
    final modelCfg = settings?['model'] as Map?;
    final available = modelCfg?['available'] as List? ?? const [];
    Map? ref;
    String? reasoningLevel;
    for (final item in available) {
      final m = item is Map ? item : null;
      final r = m?['ref'] as Map?;
      if (r is Map && r['providerId'] is String && r['modelId'] is String) {
        ref = r;
        // 引擎 reasoning 形状（实测）：{levels:[{value,label}...],
        // defaultLevel?}——imported 模型缺失档位 setModel 会被 -32603 拒绝
        final reasoning = m?['reasoning'];
        if (reasoning is Map && reasoning['levels'] is List) {
          String? levelOf(Object? e) {
            if (e is String) return e.isEmpty ? null : e;
            if (e is Map) {
              final v = e['value']?.toString();
              return (v == null || v.isEmpty) ? null : v;
            }
            return null;
          }

          final levels = (reasoning['levels'] as List)
              .map(levelOf)
              .whereType<String>()
              .toList(growable: false);
          if (levels.isNotEmpty) {
            final def = reasoning['defaultLevel']?.toString();
            reasoningLevel =
                (def != null && levels.contains(def)) ? def : levels.first;
          }
        }
        break;
      }
    }
    if (ref == null) return '发送失败：$reason（当前无可用模型，请检查桌面端登录状态）';
    return await zcodeSetModelResend(
      request: request,
      sessionId: sessionId,
      content: content,
      providerId: ref['providerId'] as String,
      modelId: ref['modelId'] as String,
      reason: reason,
      reasoningLevel: reasoningLevel,
    );
  } catch (e) {
    // 吞掉自愈链的真实失败步骤会误导用户（网络断/超时被当成模型问题）
    debugPrint('[zcode-model-heal] 模型自愈失败: $e');
    return '发送失败：$reason（自动恢复失败：$e）';
  }
}

/// command:send 全路径：发送 → 按拒因决定自愈 → 成功补订阅。
///
/// 返回 `(error, errorKind)`：
/// - error == null：发送已被接受（含自愈成功），订阅已补发；
/// - errorKind == 'model-unavailable'：模型不可用且自愈失败，UI 应渲染
///   「选择可用模型重试 / 新建会话」操作卡片，而非纯文本报错；
/// - 其余错误 errorKind 为 null，按普通错误展示。
Future<(String?, String?)> zcodeSendWithHeal({
  required ZcodeRequestFn request,
  required String sessionId,
  required String content,
}) async {
  try {
    final r = await request('session/send', {
      'sessionId': sessionId,
      'content': content,
    });
    if (r is String) {
      // 字符串 result = 业务拒绝；仅「模型不可用」类走自愈，
      // 其他按原文提示，不擅自改桌面端会话配置
      if (r.contains('模型')) {
        final healError = await zcodeHealWithAvailableModel(
          request: request,
          sessionId: sessionId,
          content: content,
          reason: r,
        );
        if (healError != null) return (healError, 'model-unavailable');
        // 自愈成功 → 落到与直发成功相同的补订阅路径
      } else {
        return (r, null);
      }
    }
    await request('session/subscribe', {
      'sessionId': sessionId,
      'deliveryKind': 'web-remote-replayable',
    });
    return (null, null);
  } catch (e) {
    if (e is ZcodeRequestException &&
        (e.code == -32031 || e.message.contains('模型'))) {
      final error = await zcodeHealWithAvailableModel(
        request: request,
        sessionId: sessionId,
        content: content,
        reason: e.message,
      );
      return (error, error == null ? null : 'model-unavailable');
    }
    return ('发送失败: $e', null);
  }
}
