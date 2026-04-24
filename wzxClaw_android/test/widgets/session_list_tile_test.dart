import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/session_meta.dart';
import 'package:wzxclaw_android/widgets/session_list_tile.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: ListView(children: [child])),
  );
}

SessionMeta makeSession({
  String id = 'sess-1',
  String title = 'Test Session',
  int messageCount = 5,
  bool isSynced = true,
  int? updatedAt,
}) {
  final now = DateTime.now().millisecondsSinceEpoch;
  return SessionMeta(
    id: id,
    workspacePath: '/home/user/project',
    workspaceName: 'project',
    title: title,
    createdAt: now - 3600000,
    updatedAt: updatedAt ?? now,
    messageCount: messageCount,
    isSynced: isSynced,
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
      ));

      expect(find.text('My Session'), findsOneWidget);
    });

    testWidgets('renders message count', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(messageCount: 12),
          isActive: false,
          onTap: () {},
        ),
      ));

      expect(find.textContaining('12'), findsOneWidget);
    });

    testWidgets('shows active indicator when isActive is true', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: true,
          onTap: () {},
        ),
      ));

      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('does not show active indicator when isActive is false', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: false,
          onTap: () {},
        ),
      ));

      expect(find.byIcon(Icons.check_circle), findsNothing);
    });

    testWidgets('shows cache badge when isSynced is false', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(isSynced: false),
          isActive: false,
          onTap: () {},
        ),
      ));

      expect(find.textContaining('缓存'), findsOneWidget);
    });

    testWidgets('calls onTap when tapped', (tester) async {
      var tapped = false;
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeSession(),
          isActive: false,
          onTap: () => tapped = true,
        ),
      ));

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
      ));

      expect(find.textContaining('分钟前'), findsOneWidget);
    });
  });
}
