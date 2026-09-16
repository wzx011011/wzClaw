import 'package:flutter/material.dart';
import '../config/app_colors.dart';

/// A bar that appears when the desktop agent enters plan mode.
class PlanModeBar extends StatelessWidget {
  final Map<String, dynamic> planData;

  const PlanModeBar({super.key, required this.planData});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final planContent = planData['plan'] as String? ??
        planData['planContent'] as String? ??
        planData['summary'] as String? ??
        '';

    final displayContent = planContent.isNotEmpty
        ? (planContent.length > 400
            ? '${planContent.substring(0, 400)}…'
            : planContent)
        : 'Agent has entered plan mode and is ready to execute.';

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.warning),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.lightbulb_outline, size: 16, color: colors.warning),
              const SizedBox(width: 6),
              Text(
                'Plan Mode',
                style: TextStyle(
                  color: colors.warning,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                'Review the plan before execution',
                style: TextStyle(color: colors.textMuted, fontSize: 11),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 160),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: colors.bgSecondary,
              borderRadius: BorderRadius.circular(4),
            ),
            child: SingleChildScrollView(
              child: Text(
                displayContent,
                style: TextStyle(color: colors.textPrimary, fontSize: 12, height: 1.4),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            '当前远程节点未提供可验证的计划确认接口；请在桌面端确认或拒绝。',
            style: TextStyle(color: colors.textMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}
