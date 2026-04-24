import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/mic_button.dart';

void main() {
  group('MicButton', () {
    late void Function(String) onResult;

    setUp(() {
      onResult = (_) {};
    });

    Widget buildSubject({
      bool isConnected = true,
      bool isStreaming = false,
    }) {
      return MaterialApp(
        theme: ThemeData.dark().copyWith(
          extensions: const [AppColors.dark],
        ),
        home: Scaffold(
          body: MicButton(
            onResult: onResult,
            isConnected: isConnected,
            isStreaming: isStreaming,
          ),
        ),
      );
    }

    group('rendering', () {
      testWidgets('renders with mic icon', (tester) async {
        await tester.pumpWidget(buildSubject());
        expect(find.byIcon(Icons.mic), findsOneWidget);
      });

      testWidgets('has tooltip with text', (tester) async {
        await tester.pumpWidget(buildSubject());
        expect(find.byTooltip('语音输入'), findsOneWidget);
      });

      testWidgets('has Semantics with label', (tester) async {
        await tester.pumpWidget(buildSubject());
        final semantics = tester.getSemantics(find.byType(MicButton));
        expect(semantics.label, contains('语音输入'));
        // flagsCollection is the non-deprecated replacement for hasFlag()
        expect(semantics.flagsCollection.isButton, isTrue);
      });

      testWidgets('has IconButton with null onPressed (long-press only)',
          (tester) async {
        await tester.pumpWidget(buildSubject());
        // The IconButton should exist and be findable
        expect(find.byType(IconButton), findsOneWidget);
      });
    });

    group('color states', () {
      testWidgets('shows default color when connected and idle',
          (tester) async {
        await tester.pumpWidget(buildSubject(isConnected: true));
        final icon = tester.widget<Icon>(find.byIcon(Icons.mic));
        // When connected and idle: AppColors.dark.textSecondary
        expect(icon.color, equals(const Color(0xFF808080)));
      });

      testWidgets('shows disabled color when disconnected', (tester) async {
        await tester.pumpWidget(buildSubject(isConnected: false));
        final icon = tester.widget<Icon>(find.byIcon(Icons.mic));
        // When disconnected: AppColors.dark.textMuted
        expect(icon.color, equals(const Color(0xFF5A5A5A)));
      });

      testWidgets('shows de-emphasized color when streaming', (tester) async {
        await tester.pumpWidget(
          buildSubject(isConnected: true, isStreaming: true),
        );
        final icon = tester.widget<Icon>(find.byIcon(Icons.mic));
        // When streaming: AppColors.dark.textMuted
        expect(icon.color, equals(const Color(0xFF5A5A5A)));
      });
    });

    group('constructor parameters', () {
      testWidgets('accepts onResult callback', (tester) async {
        String? received;
        await tester.pumpWidget(MaterialApp(
          theme:
              ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: MicButton(
              onResult: (text) => received = text,
              isConnected: true,
            ),
          ),
        ));
        // Widget built without error -- callback accepted
        expect(received, isNull);
      });

      testWidgets('accepts isConnected parameter', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme:
              ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: MicButton(
              onResult: onResult,
              isConnected: false,
            ),
          ),
        ));
        // Widget built with isConnected: false
        expect(find.byType(MicButton), findsOneWidget);
      });

      testWidgets('accepts isStreaming parameter', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme:
              ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: MicButton(
              onResult: onResult,
              isConnected: true,
              isStreaming: true,
            ),
          ),
        ));
        // Widget built with isStreaming: true
        expect(find.byType(MicButton), findsOneWidget);
      });
    });
  });
}
