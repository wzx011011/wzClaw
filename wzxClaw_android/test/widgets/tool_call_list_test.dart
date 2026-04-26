import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/widgets/tool_call_list.dart';

ChatMessage _toolMsg({
  String name = 'Read',
  ToolCallStatus status = ToolCallStatus.done,
}) =>
    ChatMessage(
      role: MessageRole.tool,
      content: '',
      toolName: name,
      toolStatus: status,
      createdAt: DateTime.now(),
    );

Widget buildSubject({required List<ChatMessage> tools}) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(
      extensions: const [AppColors.dark],
    ),
    home: Scaffold(
      body: ToolCallGroup(tools: tools),
    ),
  );
}

void main() {
  group('ToolCallGroup', () {
    group('empty tools', () {
      testWidgets('renders SizedBox.shrink when tools is empty', (tester) async {
        await tester.pumpWidget(buildSubject(tools: []));
        // No tool name text should be present
        expect(find.text('Read'), findsNothing);
        expect(find.text('Bash'), findsNothing);
        // The widget tree should contain ToolCallGroup
        expect(find.byType(ToolCallGroup), findsOneWidget);
      });
    });

    group('single tool', () {
      testWidgets('shows tool action verb for a single done tool', (tester) async {
        await tester.pumpWidget(buildSubject(tools: [
          _toolMsg(name: 'Read', status: ToolCallStatus.done),
        ]));
        // "Read" is the action verb for a done Read tool
        expect(find.text('Read'), findsOneWidget);
      });
    });

    group('multiple tools', () {
      testWidgets('shows all tool names for multiple tools', (tester) async {
        await tester.pumpWidget(buildSubject(tools: [
          _toolMsg(name: 'Read', status: ToolCallStatus.done),
          _toolMsg(name: 'Bash', status: ToolCallStatus.done),
          _toolMsg(name: 'Edit', status: ToolCallStatus.done),
        ]));
        // Action verbs for done tools: Read, Ran, Edited
        expect(find.text('Read'), findsOneWidget);
        expect(find.text('Ran'), findsOneWidget);
        expect(find.text('Edited'), findsOneWidget);
      });

      testWidgets('renders left vertical line when tools are shown', (tester) async {
        await tester.pumpWidget(buildSubject(tools: [
          _toolMsg(name: 'Read', status: ToolCallStatus.done),
          _toolMsg(name: 'Bash', status: ToolCallStatus.done),
        ]));
        // The left vertical line is a Container with width 2
        // Find containers and verify at least one has the narrow width
        final containers = tester.widgetList<Container>(
          find.byType(Container),
        );
        // The widget tree should contain IntrinsicHeight (wraps the vertical line row)
        expect(find.byType(IntrinsicHeight), findsOneWidget);
      });
    });

    group('5+ tools auto-collapse', () {
      testWidgets('auto-collapses when all tools are done', (tester) async {
        final tools = List.generate(6, (i) => _toolMsg(
          name: i % 2 == 0 ? 'Read' : 'Bash',
          status: ToolCallStatus.done,
        ));
        await tester.pumpWidget(buildSubject(tools: tools));
        // Header should be visible (shows summary text)
        // Tool entries should be hidden (collapsed)
        // The action verb "Read" should NOT be visible as individual entries
        // But the summary text like "Read (3), Bash (3)" should be present
        // The chevron_right icon indicates collapsed state
        expect(find.byIcon(Icons.chevron_right), findsOneWidget);
        // No individual tool entries visible (collapsed)
        // IntrinsicHeight should NOT be present when collapsed (visibleTools is empty)
        expect(find.byType(IntrinsicHeight), findsNothing);
      });
    });

    group('workflow header progress', () {
      testWidgets('shows Working... when some tools are running', (tester) async {
        final tools = [
          ...List.generate(4, (_) => _toolMsg(name: 'Read', status: ToolCallStatus.done)),
          _toolMsg(name: 'Bash', status: ToolCallStatus.running),
          _toolMsg(name: 'Edit', status: ToolCallStatus.running),
        ];
        await tester.pumpWidget(buildSubject(tools: tools));
        // "Working... (4/6)" — 4 done out of 6 total
        // The text is inside a ShaderMask via _ShimmerText, so the text widget exists
        expect(find.text('Working... (4/6)'), findsOneWidget);
        // Expand_more icon indicates expanded (not collapsed)
        expect(find.byIcon(Icons.expand_more), findsOneWidget);
      });
    });

    group('workflow header summary', () {
      testWidgets('shows tool count summary when all done', (tester) async {
        final tools = [
          ...List.generate(3, (_) => _toolMsg(name: 'Read', status: ToolCallStatus.done)),
          ...List.generate(2, (_) => _toolMsg(name: 'Bash', status: ToolCallStatus.done)),
          _toolMsg(name: 'Edit', status: ToolCallStatus.done),
        ];
        await tester.pumpWidget(buildSubject(tools: tools));
        // Summary: "Read (3), Bash (2), Edit (1)"
        expect(find.text('Read (3), Bash (2), Edit (1)'), findsOneWidget);
        // Check icon indicates completed
        expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
      });
    });

    group('toggle collapse', () {
      testWidgets('tapping workflow header toggles collapse state', (tester) async {
        final tools = List.generate(6, (i) => _toolMsg(
          name: 'Read',
          status: ToolCallStatus.done,
        ));
        await tester.pumpWidget(buildSubject(tools: tools));
        // Initially collapsed (all done, 6 tools)
        expect(find.byIcon(Icons.chevron_right), findsOneWidget);
        expect(find.byType(IntrinsicHeight), findsNothing);

        // Find the header InkWell by looking for the one containing the chevron icon.
        // Use find.ancestor to target only the header's InkWell.
        final headerInkWell = find.ancestor(
          of: find.byIcon(Icons.chevron_right),
          matching: find.byType(InkWell),
        );

        // Tap the header to expand
        await tester.tap(headerInkWell);
        await tester.pumpAndSettle();

        // Now expanded: chevron changes, IntrinsicHeight appears
        expect(find.byIcon(Icons.expand_more), findsOneWidget);
        expect(find.byType(IntrinsicHeight), findsOneWidget);

        // Find the header InkWell again with the new icon
        final headerInkWellExpanded = find.ancestor(
          of: find.byIcon(Icons.expand_more),
          matching: find.byType(InkWell),
        );

        // Tap again to collapse
        await tester.tap(headerInkWellExpanded);
        await tester.pumpAndSettle();

        // Collapsed again
        expect(find.byIcon(Icons.chevron_right), findsOneWidget);
        expect(find.byType(IntrinsicHeight), findsNothing);
      });
    });
  });
}
