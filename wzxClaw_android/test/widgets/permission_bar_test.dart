import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/zcode/zcode_reverse_models.dart';
import 'package:wzxclaw_android/widgets/permission_bar.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: child),
  );
}

void main() {
  group('PermissionBar', () {
    testWidgets('渲染工具名与入参预览', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PermissionBar(
          request: PermissionRequest(
            requestId: 'perm-tc-1',
            toolCallId: 'tc-1',
            toolName: 'Bash',
            input: {'command': 'ls -la'},
            options: [],
          ),
        ),
      ),);

      expect(find.textContaining('Bash'), findsOneWidget);
      expect(find.textContaining('ls -la'), findsOneWidget);
    });

    testWidgets('三键：拒绝 / 允许 / 总是允许（remember 语义暴露）', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PermissionBar(
          request: PermissionRequest(
            requestId: 'perm-tc-2',
            toolCallId: 'tc-2',
            toolName: 'FileWrite',
            input: {'path': '/tmp/test.txt'},
            options: [],
          ),
        ),
      ),);

      expect(find.text('拒绝'), findsOneWidget);
      expect(find.text('允许'), findsOneWidget);
      expect(find.text('总是允许'), findsOneWidget);
    });

    testWidgets('中文动作标签「想要执行」', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PermissionBar(
          request: PermissionRequest(
            requestId: 'perm-tc-3',
            toolCallId: 'tc-3',
            toolName: 'Bash',
            input: {},
            options: [],
          ),
        ),
      ),);

      expect(find.textContaining('想要执行'), findsOneWidget);
    });

    testWidgets('中文标题「权限确认请求」', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PermissionBar(
          request: PermissionRequest(
            requestId: 'perm-tc-4',
            toolCallId: 'tc-4',
            toolName: 'Bash',
            input: {},
            options: [],
          ),
        ),
      ),);

      expect(find.text('权限确认请求'), findsOneWidget);
    });

    testWidgets('空 input 不渲染入参预览', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PermissionBar(
          request: PermissionRequest(
            requestId: 'perm-tc-5',
            toolCallId: 'tc-5',
            toolName: 'Grep',
            input: {},
            options: [],
          ),
        ),
      ),);

      expect(find.textContaining('Grep'), findsOneWidget);
      expect(find.textContaining('想要执行'), findsOneWidget);
    });
  });
}
