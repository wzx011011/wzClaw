import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/services/chat_store.dart';
import 'package:wzxclaw_android/widgets/ask_user_bar.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

void main() {
  group('AskUserBar', () {
    testWidgets('renders question text', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-1',
            question: 'Which approach do you prefer?',
            options: [],
          ),
        ),
      ));

      expect(find.text('Which approach do you prefer?'), findsOneWidget);
    });

    testWidgets('renders option cards for single select', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-2',
            question: 'Pick one:',
            options: [
              {'label': 'Option A', 'description': 'First choice'},
              {'label': 'Option B', 'description': 'Second choice'},
            ],
          ),
        ),
      ));

      expect(find.text('Option A'), findsOneWidget);
      expect(find.text('Option B'), findsOneWidget);
      expect(find.text('First choice'), findsOneWidget);
      expect(find.text('Second choice'), findsOneWidget);
    });

    testWidgets('renders multi-select with checkbox icons', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-3',
            question: 'Select all:',
            options: [
              {'label': 'Feature 1', 'description': ''},
              {'label': 'Feature 2', 'description': ''},
            ],
            multiSelect: true,
          ),
        ),
      ));

      expect(find.text('Feature 1'), findsOneWidget);
      expect(find.text('Feature 2'), findsOneWidget);
      // Multi-select uses Icons.check_box_outline_blank (unchecked)
      expect(find.byIcon(Icons.check_box_outline_blank), findsNWidgets(2));
      // Should show "Select multiple" hint
      expect(find.text('Select multiple'), findsOneWidget);
    });

    testWidgets('renders Other option', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-4',
            question: 'Choose:',
            options: [
              {'label': 'Yes', 'description': ''},
            ],
          ),
        ),
      ));

      expect(find.text('Other...'), findsOneWidget);
    });

    testWidgets('renders with empty options list', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-5',
            question: 'Enter your answer:',
            options: [],
          ),
        ),
      ));

      expect(find.text('Enter your answer:'), findsOneWidget);
      expect(find.text('Other...'), findsOneWidget);
    });

    testWidgets('renders Question header', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        AskUserBar(
          question: AskUserQuestion(
            questionId: 'q-6',
            question: 'Test?',
            options: [],
          ),
        ),
      ));

      expect(find.text('Question'), findsOneWidget);
    });
  });
}
