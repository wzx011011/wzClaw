import 'package:flutter/material.dart';
import '../config/app_colors.dart';

/// Sticky question bar — 滚动阅读长回复时固定显示原始问题
///
/// 显示在消息列表顶部，点击后通过 [onTap] 回调跳回原始位置。
class StickyQuestionBar extends StatelessWidget {
  const StickyQuestionBar({
    super.key,
    required this.question,
    required this.onTap,
  });

  /// 要显示的问题文字
  final String question;

  /// 点击跳转回原始问题的回调
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.fromLTRB(8, 4, 8, 0),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: colors.bgElevated,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: colors.border),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.25),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            Text(
              '问题',
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: colors.accent,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                question,
                style: TextStyle(fontSize: 12, color: colors.textSecondary),
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
              ),
            ),
            const SizedBox(width: 4),
            Icon(Icons.arrow_upward, size: 14, color: colors.accent),
          ],
        ),
      ),
    );
  }
}
