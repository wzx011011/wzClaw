import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/widgets/tool_card.dart';

void main() {
  group('ToolCard', () {
    ChatMessage _toolMsg({
      String name = 'Bash',
      ToolCallStatus status = ToolCallStatus.done,
      String? input,
      String? output,
    }) =>
        ChatMessage(
          role: MessageRole.tool,
          content: '',
          toolName: name,
          toolStatus: status,
          createdAt: DateTime.now(),
          toolInput: input,
          toolOutput: output,
        );

    Widget buildSubject(ChatMessage message) => MaterialApp(
          theme: ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(body: ToolCard(message: message)),
        );

    group('rendering', () {
      testWidgets('renders tool name text', (tester) async {
        await tester.pumpWidget(buildSubject(_toolMsg(name: 'Bash')));
        expect(find.text('Bash'), findsOneWidget);
      });

      testWidgets('shows "Running" text when toolStatus=running',
          (tester) async {
        await tester
            .pumpWidget(buildSubject(_toolMsg(status: ToolCallStatus.running)));
        expect(find.text('Running'), findsOneWidget);
      });

      testWidgets('shows "Done" text when toolStatus=done', (tester) async {
        await tester.pumpWidget(buildSubject(_toolMsg(status: ToolCallStatus.done)));
        expect(find.text('Done'), findsOneWidget);
      });

      testWidgets('shows "Error" text when toolStatus=error', (tester) async {
        await tester
            .pumpWidget(buildSubject(_toolMsg(status: ToolCallStatus.error)));
        expect(find.text('Error'), findsOneWidget);
      });

      testWidgets(
          'auto-expands when toolStatus=error (input/output visible without tap)',
          (tester) async {
        await tester.pumpWidget(buildSubject(
          _toolMsg(
            status: ToolCallStatus.error,
            input: 'error input details',
            output: 'error output details',
          ),
        ));
        await tester.pumpAndSettle();
        // Input appears twice (header ellipsis + expanded body), output once
        expect(find.text('error input details'), findsWidgets);
        expect(find.text('error output details'), findsOneWidget);
      });

      testWidgets('shows input text when provided and expanded',
          (tester) async {
        await tester.pumpWidget(
            buildSubject(_toolMsg(input: 'ls -la /home')));
        await tester.pumpAndSettle();
        // Header shows input in ellipsis form even when collapsed
        expect(find.text('ls -la /home'), findsOneWidget);
        // Tap to expand — now input appears twice (header + expanded body)
        await tester.tap(find.byType(InkWell).first);
        await tester.pumpAndSettle();
        expect(find.text('ls -la /home'), findsWidgets);
      });

      testWidgets('shows output text when provided and expanded',
          (tester) async {
        await tester.pumpWidget(
            buildSubject(_toolMsg(output: 'total 42')));
        await tester.pumpAndSettle();
        // Tap to expand
        await tester.tap(find.byType(InkWell).first);
        await tester.pumpAndSettle();
        expect(find.text('total 42'), findsOneWidget);
      });

      testWidgets('shows "✓ 文件已修改" for Write tool when done with output',
          (tester) async {
        await tester.pumpWidget(buildSubject(
          _toolMsg(name: 'Write', output: 'file written ok'),
        ));
        await tester.pumpAndSettle();
        expect(find.text('✓ 文件已修改'), findsOneWidget);
      });

      testWidgets('shows correct icon for Bash tool (terminal)',
          (tester) async {
        await tester.pumpWidget(buildSubject(_toolMsg(name: 'Bash')));
        expect(find.byIcon(Icons.terminal), findsOneWidget);
      });

      testWidgets('shows correct icon for Read tool (description_outlined)',
          (tester) async {
        await tester.pumpWidget(buildSubject(_toolMsg(name: 'Read')));
        expect(find.byIcon(Icons.description_outlined), findsOneWidget);
      });

      testWidgets('shows correct icon for unknown tool (build_outlined)',
          (tester) async {
        await tester
            .pumpWidget(buildSubject(_toolMsg(name: 'UnknownTool')));
        expect(find.byIcon(Icons.build_outlined), findsOneWidget);
      });
    });

    group('expand/collapse toggle', () {
      testWidgets('tap to expand then tap again to collapse', (tester) async {
        await tester.pumpWidget(
            buildSubject(_toolMsg(input: 'hidden input', output: 'hidden output')));
        await tester.pumpAndSettle();

        // Collapsed: header shows input in ellipsis row, but output hidden
        expect(find.text('hidden input'), findsOneWidget);
        expect(find.text('hidden output'), findsNothing);

        // Tap to expand — input now appears twice (header + body), output appears
        await tester.tap(find.byType(InkWell).first);
        await tester.pumpAndSettle();
        expect(find.text('hidden input'), findsWidgets);
        expect(find.text('hidden output'), findsOneWidget);

        // Tap again to collapse — back to header-only input, output hidden
        await tester.tap(find.byType(InkWell).first);
        await tester.pumpAndSettle();
        expect(find.text('hidden input'), findsOneWidget);
        expect(find.text('hidden output'), findsNothing);
      });
    });
  });
}
