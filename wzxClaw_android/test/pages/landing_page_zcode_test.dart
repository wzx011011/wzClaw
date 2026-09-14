// ============================================================
// landing_page_zcode_test — 配对门（LandingPage 换芯）widget 测试
//
// 通过构造注入 FakeZcodeRelayClient 驱动的 ZcodeChatStore，
// 覆盖：① 未配对态入口展示；② 粘贴合法配对链接 → store.pair
// 发起连接并进入等待态；③ matched 自动导航进 /chat；
// ④ 粘贴非法链接的行内错误提示。
//
// 注意：页面持有 repeat 型脉冲动画，测试用 pump() 而非 pumpAndSettle。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/pages/landing_page.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

import '../zcode/zcode_test_fakes.dart';

/// 注入 store 的测试壳：需要命名路由 /chat 供自动导航断言
Widget _wrap(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    routes: {
      '/': (context) => child,
      '/chat': (context) =>
          const Scaffold(body: Center(child: Text('CHAT_PAGE'))),
    },
  );
}

/// 等待态替身：pair 后停在 waiting（桌面 companion 未上线）
class _WaitingFakeClient extends FakeZcodeRelayClient {
  _WaitingFakeClient() : super(initiallyPaired: false);

  @override
  ZcodeRelayState get currentState => ZcodeRelayState.waiting;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('未配对态显示扫码/粘贴入口与 companion 命令提示', (tester) async {
    final store = ZcodeChatStore(client: FakeZcodeRelayClient());

    await tester.pumpWidget(_wrap(LandingPage(store: store)));
    await tester.pump();

    expect(find.text('扫码配对'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.widgetWithText(ElevatedButton, '配对'), findsOneWidget);
    // companion 启动命令提示区
    expect(find.textContaining('companion.js'), findsOneWidget);
    // 未配对：不应发生自动导航
    expect(find.text('CHAT_PAGE'), findsNothing);
  });

  testWidgets('粘贴合法配对链接点确认 → pair 发起连接并进入等待态', (tester) async {
    final fake = _WaitingFakeClient();
    final store = ZcodeChatStore(client: fake);

    await tester.pumpWidget(_wrap(LandingPage(store: store)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), pairingUrl);
    await tester.tap(find.widgetWithText(ElevatedButton, '配对'));
    await tester.pump();

    // store.pair 已生效：配对信息解析 + 连接发起（等待桌面端上线）
    expect(store.pairing?.sid, 'device-sid-1');
    expect(fake.connectCount, 1);
    expect(store.connState, ZcodeConnState.waiting);
    // 等待态脉冲文案
    expect(find.text('等待桌面端上线'), findsOneWidget);
    expect(find.text('请确认桌面端 companion 已运行'), findsOneWidget);
  });

  testWidgets('粘贴非法链接显示行内错误且不发起配对', (tester) async {
    final fake = FakeZcodeRelayClient();
    final store = ZcodeChatStore(client: fake);

    await tester.pumpWidget(_wrap(LandingPage(store: store)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), 'not-a-pair-url');
    await tester.tap(find.widgetWithText(ElevatedButton, '配对'));
    await tester.pump();

    expect(find.textContaining('配对链接无效'), findsOneWidget);
    expect(store.pairing, isNull); // 未进入配对流程
    expect(fake.connectCount, 0);
  });

  testWidgets('connState matched 时自动导航到 /chat', (tester) async {
    final fake = FakeZcodeRelayClient();
    final store = pairedStore(fake); // 已配对且 matched

    await tester.pumpWidget(_wrap(LandingPage(store: store)));
    await tester.pump(); // 首帧（post-frame 安排导航）
    await tester.pump(); // 导航后重建

    expect(find.text('CHAT_PAGE'), findsOneWidget);
  });
}
