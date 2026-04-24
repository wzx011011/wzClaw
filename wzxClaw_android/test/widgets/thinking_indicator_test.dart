import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/thinking_indicator.dart';

Widget buildSubject() {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(
      extensions: const [AppColors.dark],
    ),
    home: const Scaffold(
      body: ThinkingIndicator(),
    ),
  );
}

void main() {
  group('ThinkingIndicator', () {
    const phrases = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Evaluating...'];

    testWidgets('renders one of the thinking phrases', (tester) async {
      await tester.pumpWidget(buildSubject());
      // At least one of the 4 phrases must be present
      final hasPhrase = phrases.any(
        (p) => find.text(p).evaluate().isNotEmpty,
      );
      expect(hasPhrase, isTrue);
    });

    testWidgets('contains a circular container (pulsing dot)', (tester) async {
      await tester.pumpWidget(buildSubject());
      // The pulsing dot is a Container with BoxShape.circle decoration
      final containers = tester.widgetList<Container>(
        find.byType(Container),
      );
      final hasCircle = containers.any((c) {
        final decoration = c.decoration;
        if (decoration is BoxDecoration) {
          return decoration.shape == BoxShape.circle;
        }
        return false;
      });
      expect(hasCircle, isTrue);
    });

    testWidgets('widget disposes without error', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: SizedBox.shrink()),
      ));
      await tester.pumpAndSettle();
      // No exceptions thrown — test passes if we reach here
      expect(find.byType(ThinkingIndicator), findsNothing);
    });
  });
}
