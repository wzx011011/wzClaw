import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/connection_state.dart';
import 'package:wzxclaw_android/widgets/connection_status_bar.dart';

void main() {
  group('ConnectionStatusBar', () {
    Widget buildSubject({
      WsConnectionState state = WsConnectionState.connected,
      String? desktopIdentity,
      bool desktopOnline = false,
      String? errorMessage,
    }) =>
        MaterialApp(
          theme: ThemeData.dark().copyWith(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: ConnectionStatusBar(
              state: state,
              desktopIdentity: desktopIdentity,
              desktopOnline: desktopOnline,
              errorMessage: errorMessage,
            ),
          ),
        );

    group('connection state display', () {
      testWidgets('connected state shows "已连接" text', (tester) async {
        await tester.pumpWidget(buildSubject(
          state: WsConnectionState.connected,
          desktopIdentity: 'MyDesktop',
        ),);
        expect(find.textContaining('已连接'), findsOneWidget);
      });

      testWidgets('connecting state shows "连接中" text', (tester) async {
        await tester.pumpWidget(
            buildSubject(state: WsConnectionState.connecting),);
        expect(find.textContaining('连接中'), findsOneWidget);
      });

      testWidgets('disconnected state shows "已断开" text', (tester) async {
        await tester.pumpWidget(
            buildSubject(state: WsConnectionState.disconnected),);
        expect(find.text('已断开'), findsOneWidget);
      });
    });

    group('status messages', () {
      testWidgets('error message shown when provided', (tester) async {
        await tester.pumpWidget(buildSubject(
          state: WsConnectionState.disconnected,
          errorMessage: 'Connection refused',
        ),);
        expect(find.textContaining('Connection refused'), findsOneWidget);
      });

      testWidgets('"桌面已连接" shown when desktopOnline=true', (tester) async {
        await tester.pumpWidget(buildSubject(
          state: WsConnectionState.connected,
          desktopOnline: true,
        ),);
        expect(find.text('桌面已连接'), findsOneWidget);
      });

      testWidgets(
          '"等待桌面" shown when desktopOnline=false and connected',
          (tester) async {
        await tester.pumpWidget(buildSubject(
          state: WsConnectionState.connected,
          desktopOnline: false,
        ),);
        expect(find.textContaining('等待桌面'), findsOneWidget);
      });
    });
  });
}
