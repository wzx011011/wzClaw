import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/widgets/session_list_tile.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: ListView(children: [child])),
  );
}

/// 构造引擎 session/list 实测形状的会话元数据（R1 直连栈契约）
ZcodeSessionMeta makeSession({
  String id = 'sess-1',
  String title = 'Test Session',
  int? updatedAt,
  String? status,
}) {
  final now = DateTime.now().millisecondsSinceEpoch;
  return ZcodeSessionMeta(
    sessionId: id,
    title: title,
    updatedAt: updatedAt ?? now,
    status: status,
  );
}

void main() {
  group('SessionListTile', () {
    testWidgets('renders session title', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(title: 'My Session'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.text('My Session'), findsOneWidget);
    });

    testWidgets('shows active indicator when isActive is true', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: true,
          onTap: () {},
        ),
      ),);

      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('does not show active indicator when isActive is false', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.byIcon(Icons.check_circle), findsNothing);
    });

    testWidgets('shows running badge for running sessions', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(status: 'running'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.text('运行'), findsOneWidget);
    });

    testWidgets('no running badge for idle sessions', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(status: 'idle'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.text('运行'), findsNothing);
    });

    testWidgets('calls onTap when tapped', (tester) async {
      var tapped = false;
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: false,
          onTap: () => tapped = true,
        ),
      ),);

      await tester.tap(find.byType(SessionListTile));
      expect(tapped, isTrue);
    });

    testWidgets('renders relative time text', (tester) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(updatedAt: now - 300000), // 5 minutes ago
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.textContaining('分钟前'), findsOneWidget);
    });
  });
}
