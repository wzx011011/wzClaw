import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/zcode/zcode_reverse_models.dart';
import 'package:wzxclaw_android/widgets/ask_user_bar.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

AskUserBar buildQuestion({
  required String requestId,
  required List<AskUserQuestionItem> questions,
  String? prompt,
  String? sessionId,
}) {
  return AskUserBar(
    question: AskUserQuestion(
      requestId: requestId,
      questions: questions,
      prompt: prompt,
      sessionId: sessionId,
    ),
  );
}

void main() {
  group('AskUserBar', () {
    testWidgets('单题：渲染题干与提交/取消按钮', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-1',
          questions: const [
            AskUserQuestionItem(
              question: 'Which approach do you prefer?',
              header: 'Which approach do you prefer?',
              options: [],
            ),
          ],
        ),
      ),);

      expect(find.text('Which approach do you prefer?'), findsOneWidget);
      expect(find.text('需要你的确认'), findsOneWidget);
      expect(find.text('提交'), findsOneWidget);
      expect(find.text('取消'), findsOneWidget);
    });

    testWidgets('单选：渲染选项 label 与 description', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-2',
          questions: const [
            AskUserQuestionItem(
              question: 'Pick one:',
              header: 'Pick one:',
              options: [
                AskUserOption(
                  value: 'a',
                  label: 'Option A',
                  description: 'First choice',
                ),
                AskUserOption(
                  value: 'b',
                  label: 'Option B',
                  description: 'Second choice',
                ),
              ],
            ),
          ],
        ),
      ),);

      expect(find.text('Option A'), findsOneWidget);
      expect(find.text('Option B'), findsOneWidget);
      expect(find.text('First choice'), findsOneWidget);
      expect(find.text('Second choice'), findsOneWidget);
    });

    testWidgets('多选：勾选框图标渲染', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-3',
          questions: const [
            AskUserQuestionItem(
              question: 'Select all:',
              header: 'Select all:',
              multiSelect: true,
              options: [
                AskUserOption(value: 'f1', label: 'Feature 1'),
                AskUserOption(value: 'f2', label: 'Feature 2'),
              ],
            ),
          ],
        ),
      ),);

      expect(find.text('Feature 1'), findsOneWidget);
      expect(find.text('Feature 2'), findsOneWidget);
      // 多选 = 勾选框；未勾选状态为 outline
      expect(find.byIcon(Icons.check_box_outline_blank), findsNWidgets(2));
    });

    testWidgets('无选项题：渲染自由文本输入框', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-4',
          questions: const [
            AskUserQuestionItem(
              question: 'Describe the change:',
              header: 'Describe the change:',
              options: [],
            ),
          ],
        ),
      ),);

      expect(find.text('Describe the change:'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('输入回答…'), findsOneWidget);
    });

    testWidgets('多题：全部题目按序渲染，标题带题数', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-5',
          questions: const [
            AskUserQuestionItem(
              question: 'Q1 text',
              header: 'Q1 header',
              options: [AskUserOption(value: 'x', label: 'X')],
            ),
            AskUserQuestionItem(
              question: 'Q2 text',
              header: 'Q2 header',
              options: [AskUserOption(value: 'y', label: 'Y')],
            ),
          ],
        ),
      ),);

      expect(find.text('需要你的回答（2 题）'), findsOneWidget);
      expect(find.text('Q1 header'), findsOneWidget);
      expect(find.text('Q2 header'), findsOneWidget);
    });

    testWidgets('单选点选：切换选中态', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        buildQuestion(
          requestId: 'req-6',
          questions: const [
            AskUserQuestionItem(
              question: 'Pick:',
              header: 'Pick:',
              options: [
                AskUserOption(value: 'a', label: 'A'),
                AskUserOption(value: 'b', label: 'B'),
              ],
            ),
          ],
        ),
      ),);

      // 未选：radio_button_off；点选 A 后变 radio_button_checked
      expect(find.byIcon(Icons.radio_button_off), findsNWidgets(2));
      await tester.tap(find.text('A'));
      await tester.pump();
      expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
      expect(find.byIcon(Icons.radio_button_off), findsOneWidget);
    });
  });
}
