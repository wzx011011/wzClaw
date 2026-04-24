import 'dart:async';

import 'package:permission_handler/permission_handler.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Voice recognition error types for user-facing error messages.
enum VoiceError {
  /// Speech recognition failed (generic).
  recognitionFailed,

  /// No speech was detected.
  noSpeechDetected,

  /// Speech recognition service is not available on this device.
  notAvailable,

  /// Microphone permission was denied.
  permissionDenied,
}

/// Singleton service wrapping speech_to_text for voice input.
///
/// Follows the project's singleton + StreamController.broadcast() pattern.
/// Only listens during explicit start/stop calls -- no continuous listening.
/// Uses system default locale (Chinese devices get Chinese recognition).
class VoiceInputService {
  static final VoiceInputService _instance = VoiceInputService._();
  static VoiceInputService get instance => _instance;
  VoiceInputService._();

  final SpeechToText _speech = SpeechToText();
  bool _initialized = false;
  bool _listening = false;

  final _statusController = StreamController<bool>.broadcast();
  /// Emits true when listening starts, false when it stops.
  Stream<bool> get listeningStream => _statusController.stream;

  final _errorController = StreamController<VoiceError>.broadcast();
  /// Emits error types for UI to display as SnackBar messages.
  Stream<VoiceError> get errorStream => _errorController.stream;

  bool get isListening => _listening;
  bool get isAvailable => _initialized;

  /// Initialize the speech recognizer. Returns true if successful.
  /// Safe to call multiple times -- subsequent calls are no-ops if already initialized.
  Future<bool> initialize() async {
    if (_initialized) return true;
    _initialized = await _speech.initialize(
      onError: (error) {
        _handleError(error);
      },
      onStatus: (status) {
        if (status == 'done' || status == 'notListening') {
          if (_listening) {
            _listening = false;
            _statusController.add(false);
          }
        }
      },
    );
    return _initialized;
  }

  /// Request microphone permission. Returns true if granted.
  /// Handles permanent denial by opening app settings.
  Future<bool> requestPermission() async {
    final status = await Permission.microphone.status;
    if (status.isGranted) return true;
    if (status.isPermanentlyDenied) {
      await openAppSettings();
      return false;
    }
    final result = await Permission.microphone.request();
    return result.isGranted;
  }

  /// Start listening for speech input.
  /// [onResult] is called with recognized text when a final result is available.
  /// Requests microphone permission if not already granted.
  Future<void> startListening({
    required void Function(String) onResult,
  }) async {
    if (_listening) return;

    // Ensure initialized
    if (!_initialized) {
      final ok = await initialize();
      if (!ok) {
        _errorController.add(VoiceError.notAvailable);
        return;
      }
    }

    // Ensure permission
    final hasPermission = await requestPermission();
    if (!hasPermission) {
      _errorController.add(VoiceError.permissionDenied);
      return;
    }

    // Start listening with system default locale
    try {
      await _speech.listen(
        onResult: (result) {
          if (result.finalResult) {
            onResult(result.recognizedWords);
          }
        },
        // No localeId specified -- uses system default (per CONTEXT.md decision D-06)
      );

      _listening = true;
      _statusController.add(true);
    } catch (e) {
      _errorController.add(VoiceError.recognitionFailed);
    }
  }

  /// Stop listening. Called when user releases the mic button.
  Future<void> stopListening() async {
    if (!_listening) return;
    try {
      await _speech.stop();
    } catch (_) {
      // Speech engine may already be stopped by the system
    }
    _listening = false;
    _statusController.add(false);
  }

  void _handleError(SpeechRecognitionError error) {
    _listening = false;
    _statusController.add(false);

    if (error.errorMsg == 'no-speech' || error.errorMsg == 'no_match') {
      _errorController.add(VoiceError.noSpeechDetected);
    } else if (error.errorMsg == 'not-available') {
      _errorController.add(VoiceError.notAvailable);
    } else {
      _errorController.add(VoiceError.recognitionFailed);
    }
  }

  /// Map VoiceError to Chinese user-facing message (for SnackBar).
  static String errorMessage(VoiceError error) {
    switch (error) {
      case VoiceError.recognitionFailed:
        return '语音识别失败';
      case VoiceError.noSpeechDetected:
        return '未检测到语音';
      case VoiceError.notAvailable:
        return '语音识别不可用';
      case VoiceError.permissionDenied:
        return '麦克风权限被拒绝';
    }
  }

  /// Dispose all resources. Call only when app is being destroyed.
  void dispose() {
    _statusController.close();
    _errorController.close();
  }
}
