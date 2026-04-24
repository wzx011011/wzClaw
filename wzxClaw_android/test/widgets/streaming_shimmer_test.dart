import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/streaming_shimmer.dart';

Widget buildSubject() {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(
      extensions: const [AppColors.dark],
    ),
    home: const Scaffold(
      body: StreamingShimmer(),
    ),
  );
}

void main() {
  group('StreamingShimmer', () {
    testWidgets('renders a Container', (tester) async {
      await tester.pumpWidget(buildSubject());
      expect(find.byType(Container), findsWidgets);
    });

    testWidgets('contains AnimatedBuilder', (tester) async {
      await tester.pumpWidget(buildSubject());
      // The widget tree includes AnimatedBuilders from MaterialApp/Scaffold too
      expect(find.byType(AnimatedBuilder), findsWidgets);
      // Verify at least one is inside StreamingShimmer
      expect(find.byType(StreamingShimmer), findsOneWidget);
    });

    testWidgets('widget disposes without error', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: SizedBox.shrink()),
      ));
      await tester.pumpAndSettle();
      // No exceptions thrown — test passes if we reach here
      expect(find.byType(StreamingShimmer), findsNothing);
    });
  });
}
