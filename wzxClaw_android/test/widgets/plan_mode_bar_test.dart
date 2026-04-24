import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/plan_mode_bar.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: child),
  );
}

void main() {
  group('PlanModeBar', () {
    testWidgets('renders plan text from planData[plan]', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {'plan': 'Refactor auth module'}),
      ));

      expect(find.text('Refactor auth module'), findsOneWidget);
      expect(find.text('Plan Mode'), findsOneWidget);
    });

    testWidgets('renders plan text from planData[planContent]', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {'planContent': 'Implement caching'}),
      ));

      expect(find.text('Implement caching'), findsOneWidget);
    });

    testWidgets('renders plan text from planData[summary] as fallback', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {'summary': 'Summary text'}),
      ));

      expect(find.text('Summary text'), findsOneWidget);
    });

    testWidgets('renders reject and approve buttons', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {'plan': 'Do something'}),
      ));

      expect(find.text('Reject'), findsOneWidget);
      expect(find.text('Approve & Execute'), findsOneWidget);
    });

    testWidgets('truncates long plan text', (tester) async {
      final longPlan = 'A' * 500;
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {'plan': longPlan}),
      ));

      final textWidget = tester.widget<Text>(find.byType(Text).at(2));
      expect(textWidget.data!.length, lessThan(500));
    });

    testWidgets('renders default message when no plan data', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PlanModeBar(planData: {}),
      ));

      expect(find.text('Plan Mode'), findsOneWidget);
      expect(find.textContaining('plan mode'), findsOneWidget);
    });
  });
}
