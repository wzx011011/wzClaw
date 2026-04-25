import 'package:flutter/material.dart';
import '../config/app_colors.dart';

/// Sticky question bubble — 滚动阅读长回复时，原始问题以「用户气泡」的样式
/// pin 在列表顶部。视觉上与 [_buildUserBubble] 一致，让用户感觉就是原始气泡
/// 自己被顶住，而不是另一个独立的小条。
///
/// 点击通过 [onTap] 回调跳回原始位置。
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
    final screenWidth = MediaQuery.of(context).size.width;
    return GestureDetector(
      onTap: onTap,
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          constraints: BoxConstraints(maxWidth: screenWidth * 0.80),
          margin: const EdgeInsets.fromLTRB(8, 4, 8, 4),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: colors.userBubble,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16),
              topRight: Radius.circular(16),
              bottomLeft: Radius.circular(16),
              bottomRight: Radius.circular(4),
            ),
          ),
          child: Text(
            question,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 13,
              height: 1.5,
            ),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ),
    );
  }
}

