import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';

/// 实时思维链面板：无内容时显示 Shimmer 占位；reasoning_delta 内容到达后
/// 切换为灰色折叠面板实时滚动（对应桌面端「思考」块）。
class AgentThinkingBlock extends StatefulWidget {
  final Stream<String> thinkingStream;
  const AgentThinkingBlock({super.key, required this.thinkingStream});

  @override
  State<AgentThinkingBlock> createState() => _AgentThinkingBlockState();
}

class _AgentThinkingBlockState extends State<AgentThinkingBlock> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<String>(
      stream: widget.thinkingStream,
      initialData: '',
      builder: (context, snap) {
        final text = snap.data ?? '';
        if (text.trim().isEmpty) return const ThinkingIndicator();
        final colors = AppColors.of(context);
        return Container(
          margin: const EdgeInsets.only(left: 12, right: 48, top: 4, bottom: 4),
          decoration: BoxDecoration(
            color: colors.bgTertiary,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  child: Row(
                    children: [
                      Icon(Icons.psychology_outlined,
                          size: 16, color: colors.accent,),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '思考中',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: colors.textSecondary,
                          ),
                        ),
                      ),
                      Icon(
                        _expanded
                            ? Icons.keyboard_arrow_down
                            : Icons.keyboard_arrow_right,
                        size: 18,
                        color: colors.textMuted,
                      ),
                    ],
                  ),
                ),
              ),
              if (_expanded)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 180),
                    // reverse 锚定底部：新内容到达自动贴底，无需滚动控制器
                    child: SingleChildScrollView(
                      reverse: true,
                      child: Text(
                        text,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.45,
                          color: colors.textMuted,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

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
