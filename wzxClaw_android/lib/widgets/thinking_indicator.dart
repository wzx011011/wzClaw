import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';

/// Shimmer "Thinking..." indicator shown while waiting for the first token.
class ThinkingIndicator extends StatefulWidget {
  const ThinkingIndicator({super.key});

  @override
  State<ThinkingIndicator> createState() => _ThinkingIndicatorState();
}

class _ThinkingIndicatorState extends State<ThinkingIndicator>
    with TickerProviderStateMixin {
  static const _phrases = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Evaluating...'];

  late final AnimationController _shimmerController;
  late final AnimationController _dotController;
  late final AnimationController _fadeController;
  Timer? _phraseTimer;
  int _phraseIndex = 0;

  @override
  void initState() {
    super.initState();
    _phraseIndex = Random().nextInt(_phrases.length);
    _shimmerController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    )..repeat();
    _dotController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 300),
      value: 1.0,
    );
    _phraseTimer = Timer.periodic(const Duration(seconds: 3), (_) => _nextPhrase());
  }

  void _nextPhrase() {
    _fadeController.reverse().then((_) {
      if (!mounted) return;
      setState(() => _phraseIndex = (_phraseIndex + 1) % _phrases.length);
      _fadeController.forward();
    });
  }

  @override
  void dispose() {
    _phraseTimer?.cancel();
    _shimmerController.dispose();
    _dotController.dispose();
    _fadeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      margin: const EdgeInsets.only(left: 12, right: 48, top: 4, bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: colors.bgTertiary,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedBuilder(
            animation: _dotController,
            builder: (_, __) => Opacity(
              opacity: 0.4 + _dotController.value * 0.6,
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: colors.accent,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          FadeTransition(
            opacity: _fadeController,
            child: AnimatedBuilder(
              animation: _shimmerController,
              builder: (_, __) {
                final dx = _shimmerController.value * 3 - 1;
                return ShaderMask(
                  shaderCallback: (bounds) => LinearGradient(
                    begin: Alignment(dx - 0.3, 0),
                    end: Alignment(dx + 0.3, 0),
                    colors: [colors.textMuted, colors.accent, colors.textMuted],
                    stops: const [0.0, 0.5, 1.0],
                  ).createShader(bounds),
                  blendMode: BlendMode.srcIn,
                  child: Text(
                    _phrases[_phraseIndex],
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: Colors.white,
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
