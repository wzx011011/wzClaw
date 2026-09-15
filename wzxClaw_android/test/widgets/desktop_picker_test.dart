import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/desktop_info.dart';
import 'package:wzxclaw_android/widgets/desktop_picker.dart';

void main() {
  group('DesktopPicker', () {
    Widget buildSubject({
      List<DesktopInfo> desktops = const [],
      String? selectedDesktopId,
      ValueChanged<String?>? onSelect,
    }) =>
        MaterialApp(
          theme: ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: DesktopPicker(
              desktops: desktops,
              selectedDesktopId: selectedDesktopId,
              onSelect: onSelect ?? (_) {},
            ),
          ),
        );

    group('rendering', () {
      testWidgets('renders "全部桌面" chip text', (tester) async {
        await tester.pumpWidget(buildSubject());
        expect(find.text('全部桌面'), findsOneWidget);
      });

      testWidgets('renders each desktop name as a chip', (tester) async {
        final desktops = [
          DesktopInfo(desktopId: 'd1', name: 'Office-PC', connectedAt: 0),
          DesktopInfo(desktopId: 'd2', name: 'Home-PC', connectedAt: 0),
        ];
        await tester.pumpWidget(buildSubject(desktops: desktops));
        expect(find.text('Office-PC'), findsOneWidget);
        expect(find.text('Home-PC'), findsOneWidget);
      });

      testWidgets('platform icon: win32 -> desktop_windows icon',
          (tester) async {
        final desktops = [
          DesktopInfo(
              desktopId: 'd1', name: 'PC', platform: 'win32', connectedAt: 0),
        ];
        await tester.pumpWidget(buildSubject(desktops: desktops));
        expect(find.byIcon(Icons.desktop_windows), findsOneWidget);
      });
    });

    group('selection', () {
      testWidgets('selected chip (matching selectedDesktopId) is rendered',
          (tester) async {
        final desktops = [
          DesktopInfo(desktopId: 'd1', name: 'PC1', connectedAt: 0),
          DesktopInfo(desktopId: 'd2', name: 'PC2', connectedAt: 0),
        ];
        await tester.pumpWidget(buildSubject(
          desktops: desktops,
          selectedDesktopId: 'd1',
        ));
        // Both chips rendered, d1 is selected
        expect(find.text('PC1'), findsOneWidget);
        expect(find.text('PC2'), findsOneWidget);
      });

      testWidgets('unselected chip is rendered', (tester) async {
        final desktops = [
          DesktopInfo(desktopId: 'd1', name: 'PC1', connectedAt: 0),
        ];
        // No selectedDesktopId -> "全部桌面" is selected, PC1 is unselected
        await tester.pumpWidget(buildSubject(desktops: desktops));
        expect(find.text('PC1'), findsOneWidget);
      });
    });

    group('tap interaction', () {
      testWidgets('tapping "全部桌面" chip calls onSelect(null)',
          (tester) async {
        String? selected;
        await tester.pumpWidget(buildSubject(
          desktops: [
            DesktopInfo(desktopId: 'd1', name: 'PC1', connectedAt: 0),
          ],
          selectedDesktopId: 'd1',
          onSelect: (id) => selected = id,
        ));
        await tester.tap(find.text('全部桌面'));
        await tester.pump();
        expect(selected, isNull);
      });

      testWidgets('tapping a desktop chip calls onSelect with that desktopId',
          (tester) async {
        String? selected;
        await tester.pumpWidget(buildSubject(
          desktops: [
            DesktopInfo(desktopId: 'abc123', name: 'MyPC', connectedAt: 0),
          ],
          onSelect: (id) => selected = id,
        ));
        await tester.tap(find.text('MyPC'));
        await tester.pump();
        expect(selected, equals('abc123'));
      });
    });
  });
}
