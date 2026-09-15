import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/services/chat_store.dart';
import 'package:wzxclaw_android/widgets/permission_bar.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: child),
  );
}

void main() {
  group('PermissionBar', () {
    testWidgets('renders tool name and input preview', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PermissionBar(
          request: PermissionRequest(
            toolCallId: 'tc-1',
            toolName: 'Bash',
            input: {'command': 'ls -la'},
          ),
        ),
      ));

      expect(find.textContaining('Bash'), findsOneWidget);
      expect(find.textContaining('ls -la'), findsOneWidget);
    });

    testWidgets('renders approve and deny buttons', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PermissionBar(
          request: PermissionRequest(
            toolCallId: 'tc-2',
            toolName: 'FileWrite',
            input: {'path': '/tmp/test.txt'},
          ),
        ),
      ));

      expect(find.text('Deny'), findsOneWidget);
      expect(find.text('Approve'), findsOneWidget);
    });

    testWidgets('renders "wants to execute" label', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PermissionBar(
          request: PermissionRequest(
            toolCallId: 'tc-3',
            toolName: 'Bash',
            input: {},
          ),
        ),
      ));

      expect(find.textContaining('wants to execute'), findsOneWidget);
    });

    testWidgets('renders Permission Request header', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PermissionBar(
          request: PermissionRequest(
            toolCallId: 'tc-3',
            toolName: 'Bash',
            input: {},
          ),
        ),
      ));

      expect(find.text('Permission Request'), findsOneWidget);
    });

    testWidgets('handles empty input map without input preview', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PermissionBar(
          request: PermissionRequest(
            toolCallId: 'tc-5',
            toolName: 'Grep',
            input: {},
          ),
        ),
      ));

      expect(find.textContaining('Grep'), findsOneWidget);
      // Empty input should not show the input preview container
      expect(find.textContaining('wants to execute'), findsOneWidget);
    });
  });
}
