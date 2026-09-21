import 'dart:convert';

import 'package:flutter/material.dart';
import '../config/app_colors.dart';
import '../zcode/zcode_reverse_models.dart';
import '../zcode/zcode_chat_store.dart';

/// 权限确认条：桌面 agent 请求工具执行授权时出现在聊天列表与输入栏之间。
/// 三键对应协议实测的三个 option：拒绝 / 允许（本次）/ 总是允许
/// （allow_project，回放其 response 原文，等价 remember:true）。
class PermissionBar extends StatelessWidget {
  final PermissionRequest request;

  const PermissionBar({super.key, required this.request});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    // 来源标注（2026-09-19 评审 P1）：待处理请求保留后台有效性后，
    // 请求可能不属于当前视口会话——用户必须在批准前看到它来自哪个
    // 会话，否则会在 B 的上下文里批准 A 的操作（相对路径命令尤甚）
    final sourceLabel =
        ZcodeChatStore.instance.reverseSourceLabel(request.sessionId);
    // 完整参数原文（评审 #11）：不做预截断——批准前必须能看到实际执行的
    // 全部命令/路径/改动内容；长内容由外层滚动区（限高）消化
    String inputSummary = '';
    if (request.input.isNotEmpty) {
      inputSummary = const JsonEncoder.withIndent('  ').convert(request.input);
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.toolRunning),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.security, size: 16, color: colors.toolRunning),
              const SizedBox(width: 6),
              Text(
                '权限确认请求',
                style: TextStyle(
                  color: colors.toolRunning,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          if (sourceLabel != null) ...[
            const SizedBox(height: 4),
            Text(
              sourceLabel,
              style: TextStyle(color: colors.textMuted, fontSize: 12),
            ),
          ],
          const SizedBox(height: 6),
          Text(
            '${request.toolName} 想要执行：',
            style: TextStyle(color: colors.textSecondary, fontSize: 12),
          ),
          if (request.riskLevel != null) ...[
            const SizedBox(height: 4),
            Text(
              '风险级：${request.riskLevel}',
              style: TextStyle(color: colors.textMuted, fontSize: 11),
            ),
          ],
          if (request.reason != null) ...[
            const SizedBox(height: 2),
            Text(
              request.reason!,
              style: TextStyle(color: colors.textMuted, fontSize: 11),
            ),
          ],
          if (inputSummary.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 220),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: colors.bgSecondary,
                borderRadius: BorderRadius.circular(4),
              ),
              child: SingleChildScrollView(
                child: Text(
                  inputSummary,
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    height: 1.4,
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => ZcodeChatStore.instance
                    .respondToPermission(request.requestId, approved: false),
                style: TextButton.styleFrom(
                  foregroundColor: colors.error,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.error),
                  ),
                ),
                child: const Text('拒绝', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () => ZcodeChatStore.instance
                    .respondToPermission(request.requestId, approved: true),
                style: TextButton.styleFrom(
                  foregroundColor: colors.success,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.success),
                  ),
                ),
                child: const Text('允许', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () => ZcodeChatStore.instance.respondToPermission(
                  request.requestId,
                  approved: true,
                  remember: true,
                ),
                style: TextButton.styleFrom(
                  foregroundColor: colors.success,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.success),
                  ),
                ),
                child: const Text(
                  '总是允许',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
