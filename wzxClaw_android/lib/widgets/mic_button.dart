import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/app_colors.dart';
import '../services/voice_input_service.dart';

/// Callback type for when voice recognition produces a final result.
typedef VoiceResultCallback = void Function(String text);

/// Mic button widget for voice input.
///
/// Long-press to start recording, release to stop.
/// Recognized text is sent to parent via [onResult] callback.
class MicButton extends StatefulWidget {
  final VoiceResultCallback onResult;
  final bool isConnected;
  final bool isStreaming;

  const MicButton({
    super.key,
    required this.onResult,
    required this.isConnected,
    this.isStreaming = false,
  });

  @override
  State<MicButton> createState() => _MicButtonState();
}

class _MicButtonState extends State<MicButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController;
  bool _isRecording = false;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  Future<void> _onLongPressStart(LongPressStartDetails details) async {
    if (!widget.isConnected || widget.isStreaming) return;

    await VoiceInputService.instance.startListening(
      onResult: (text) {
        widget.onResult(text);
      },
    );

    if (VoiceInputService.instance.isListening && mounted) {
      setState(() => _isRecording = true);
      _pulseController.repeat(reverse: true);
      HapticFeedback.mediumImpact();
    }
  }

  Future<void> _onLongPressEnd(LongPressEndDetails details) async {
    if (!_isRecording) return;

    _pulseController.stop();
    _pulseController.value = 0;
    setState(() => _isRecording = false);

    await VoiceInputService.instance.stopListening();
  }

  Color _iconColor(AppColors colors) {
    if (!widget.isConnected) return colors.textMuted;
    if (_isRecording) return colors.error;
    if (widget.isStreaming) return colors.textMuted;
    return colors.textSecondary;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final color = _iconColor(colors);
    return GestureDetector(
      onLongPressStart: widget.isConnected && !widget.isStreaming
          ? _onLongPressStart
          : null,
      onLongPressEnd: _onLongPressEnd,
      child: Semantics(
        label: '语音输入',
        button: true,
        child: IconButton(
          onPressed: null,
          icon: _isRecording
              ? FadeTransition(
                  opacity: Tween<double>(begin: 0.5, end: 1.0).animate(
                    CurvedAnimation(
                      parent: _pulseController,
                      curve: Curves.easeInOut,
                    ),
                  ),
                  child: Icon(Icons.mic, color: color),
                )
              : Icon(Icons.mic, color: color),
          tooltip: '语音输入',
        ),
      ),
    );
  }
}
