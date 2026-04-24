import 'package:flutter/material.dart';

import '../config/app_colors.dart';

/// A thin shimmer gradient bar shown at the bottom of a streaming assistant message.
class StreamingShimmer extends StatefulWidget {
  const StreamingShimmer({super.key});

  @override
  State<StreamingShimmer> createState() => _StreamingShimmerState();
}

class _StreamingShimmerState extends State<StreamingShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (_, __) {
        final dx = _controller.value * 3 - 1;
        return Container(
          height: 2,
          margin: const EdgeInsets.only(top: 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(1),
            gradient: LinearGradient(
              begin: Alignment(dx - 0.5, 0),
              end: Alignment(dx + 0.5, 0),
              colors: [Colors.transparent, colors.accent, Colors.transparent],
              stops: const [0.0, 0.5, 1.0],
            ),
          ),
        );
      },
    );
  }
}
