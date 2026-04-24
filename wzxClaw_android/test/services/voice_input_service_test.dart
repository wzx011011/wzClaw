import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/voice_input_service.dart';

void main() {
  // Required before any code that touches Flutter platform channels
  TestWidgetsFlutterBinding.ensureInitialized();

  group('VoiceInputService', () {
    group('singleton', () {
      test('instance returns same object on repeated access', () {
        final a = VoiceInputService.instance;
        final b = VoiceInputService.instance;
        expect(identical(a, b), isTrue);
      });
    });

    group('initial state', () {
      test('isListening is false before any action', () {
        expect(VoiceInputService.instance.isListening, isFalse);
      });

      test('isAvailable is false before initialize', () {
        // Note: in test env, _initialized starts false.
        // After initialize() is called in other tests, this state may change.
        // We verify the initial API exists.
        expect(VoiceInputService.instance.isAvailable, isFalse);
      });
    });

    group('API surface', () {
      test('exposes listeningStream as Stream<bool>', () {
        expect(VoiceInputService.instance.listeningStream, isA<Stream<bool>>());
      });

      test('exposes errorStream as Stream<VoiceError>', () {
        expect(
          VoiceInputService.instance.errorStream,
          isA<Stream<VoiceError>>(),
        );
      });

      test('has initialize method returning Future<bool>', () async {
        final result = VoiceInputService.instance.initialize();
        expect(result, isA<Future<bool>>());
        // Await to completion so the MissingPluginException doesn't leak past the test
        await result.catchError((_) => false);
      });

      test('has startListening method accepting onResult callback', () async {
        // Verify the method signature compiles -- it accepts required onResult
        // Await so async platform exception doesn't leak past the test
        try {
          await VoiceInputService.instance.startListening(
            onResult: (String text) {},
          );
        } catch (_) {
          // Expected: MissingPluginException or similar in test environment
        }
      });

      test('has stopListening method returning Future<void>', () {
        expect(
          VoiceInputService.instance.stopListening(),
          isA<Future<void>>(),
        );
      });
    });

    group('VoiceError enum', () {
      test('has all expected values', () {
        expect(VoiceError.values, containsAll([
          VoiceError.recognitionFailed,
          VoiceError.noSpeechDetected,
          VoiceError.notAvailable,
          VoiceError.permissionDenied,
        ]));
      });
    });

    group('errorMessage', () {
      test('returns Chinese message for recognitionFailed', () {
        expect(
          VoiceInputService.errorMessage(VoiceError.recognitionFailed),
          equals('语音识别失败'),
        );
      });

      test('returns Chinese message for noSpeechDetected', () {
        expect(
          VoiceInputService.errorMessage(VoiceError.noSpeechDetected),
          equals('未检测到语音'),
        );
      });

      test('returns Chinese message for notAvailable', () {
        expect(
          VoiceInputService.errorMessage(VoiceError.notAvailable),
          equals('语音识别不可用'),
        );
      });

      test('returns Chinese message for permissionDenied', () {
        expect(
          VoiceInputService.errorMessage(VoiceError.permissionDenied),
          equals('麦克风权限被拒绝'),
        );
      });

      test('handles all VoiceError values without missing cases', () {
        for (final error in VoiceError.values) {
          final message = VoiceInputService.errorMessage(error);
          expect(message, isNotEmpty);
          expect(message, isA<String>());
        }
      });
    });

    group('listeningStream emission', () {
      test('listeningStream does not emit before startListening', () async {
        final service = VoiceInputService.instance;
        // Listen for a short duration -- should not receive any events
        final events = <bool>[];
        final sub = service.listeningStream.listen(events.add);
        await Future<void>.delayed(const Duration(milliseconds: 100));
        sub.cancel();
        expect(events, isEmpty);
      });
    });
  });
}
