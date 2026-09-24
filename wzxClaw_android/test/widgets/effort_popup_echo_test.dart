// ============================================================
// effort_popup_echo_test — 思考档位弹层勾选回显回归
//
// 钉死的契约：弹层回显的数据源必须与选择的数据源一致。
// 1. 新任务态（无活动会话）：档位暂存在页面 _pendingThoughtLevel
//    （store 的 setter 在该态下是纯 no-op），弹层回显必须读 pending
//    ——同权限模式弹层 `_pendingPermissionMode ?? _store.sessionMode`
//    的既有范式。旧实现只读 store：选完「高」重开弹层勾选丢失。
// 2. 会话内：选择经 store.setThoughtLevel 直发引擎并乐观回写 store，
//    弹层回显读 store。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

import '../zcode/zcode_test_fakes.dart';

/// 泵起完整 ChatPage，返回 (store, fake)。默认新任务态（不 openSession）；
/// 会话态由调用方传 [sessionId] 并自备种子消息。
Future<({ZcodeChatStore store, FakeZcodeRelayClient fake})> _pumpPage(
  WidgetTester tester, {
  String? sessionId,
}) async {
  SharedPreferences.setMockInitialValues({});
  ZcodeNotifier.resetInstanceForTest();
  ZcodeNotifier.setInstanceForTest(FakeZcodeNotifier());

  final fake = FakeZcodeRelayClient();
  FakeSessionServer().bind(fake);
  final cache = FakeZcodeSessionCache();
  if (sessionId != null) {
    cache.messages[sessionId] = [
      ZcodeSessionItem(
        protoId: 'h0',
        synced: true,
        message: ChatMessage(
          role: MessageRole.user,
          processParts: const [ChatProcessPart.text('历史 0')],
          createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000),
        ),
      ),
    ];
  }
  final store = ZcodeChatStore(cache: cache)
    ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
  if (sessionId != null) {
    await store.openSession(sessionId);
  }

  // 工具栏按钮可用性挂在 ConnectionManager 单例连接态上；测试路径与
  // 真实路径同效地把状态置为 connected（null 替身不会被页面触达）
  ConnectionManager.instance.debugAttachClient(FakeZcodeRelayClient());

  ChatPage.debugStoreOverride = store;
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData(extensions: const [AppColors.dark]),
      home: const ChatPage(),
    ),
  );
  await tester.pumpAndSettle();
  return (store: store, fake: fake);
}

/// 打开思考档位弹层并断言「高」档的勾选回显（trailing 勾图标）
Future<void> _openPopupAndExpectEcho(
  WidgetTester tester, {
  required bool highChecked,
}) async {
  await tester.tap(find.byTooltip('思考档位'));
  await tester.pumpAndSettle();

  final highTile = tester.widget<ListTile>(
    find.widgetWithText(ListTile, '高'),
  );
  final lowTile = tester.widget<ListTile>(
    find.widgetWithText(ListTile, '低'),
  );
  if (highChecked) {
    expect(
      highTile.trailing,
      isNotNull,
      reason: '选过「高」后重开弹层必须回显勾选（回显数据源 = 实际选择的数据源）',
    );
    expect(lowTile.trailing, isNull, reason: '勾选必须唯一，只落在所选档位');
  } else {
    expect(highTile.trailing, isNull);
    expect(lowTile.trailing, isNull);
  }
}

/// 关掉弹层并冲走 SnackBar 的 2 秒 Timer（testWidgets 结束不留挂起 Timer）
Future<void> _dismissSheetAndFlushTimers(WidgetTester tester) async {
  await tester.tapAt(const Offset(10, 10)); // 点障碍物收起底部弹层
  await tester.pumpAndSettle();
  await tester.pump(const Duration(seconds: 3));
  await tester.pumpAndSettle();
}

void main() {
  tearDown(() {
    ChatPage.debugStoreOverride = null;
  });

  testWidgets('新任务态选档：SnackBar 确认 + 重开弹层勾选回显不丢', (tester) async {
    await _pumpPage(tester); // 不 openSession = 新任务态

    // 选「高」：走无会话分支（SnackBar 确认「将在新会话生效」）
    await tester.tap(find.byTooltip('思考档位'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(ListTile, '高'), findsOneWidget);
    expect(
      tester.widget<ListTile>(find.widgetWithText(ListTile, '高')).trailing,
      isNull,
      reason: '初始无任何档位选中（新任务态下 store 无权威值）',
    );
    await tester.tap(find.text('高'));
    await tester.pumpAndSettle();
    expect(
      find.text('思考档位将在新会话生效'),
      findsOneWidget,
      reason: '确认走的是新任务态暂存分支',
    );

    // 悬浮 SnackBar 盖在输入栏上方，档位按钮此刻点不到——先等它按
    // 2 秒时长自动退场（真机用户同样如此），再重开弹层验证回显
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // 修复点：重开弹层，勾选必须还在（旧实现回显读 store，新任务态下
    // store 从未被写入，勾选丢失）
    await _openPopupAndExpectEcho(tester, highChecked: true);
    await _dismissSheetAndFlushTimers(tester);
  });

  testWidgets('会话内选档：经 store.setThoughtLevel 直发引擎，回显读 store',
      (tester) async {
    final (:store, :fake) = await _pumpPage(tester, sessionId: 'sess-echo');
    fake.handlers['session/setThoughtLevel'] = (_) => {};

    await tester.tap(find.byTooltip('思考档位'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('高'));
    await tester.pumpAndSettle();

    // 引擎请求直发 + store 乐观回写（单一事实：回显只认 store）
    expect(
      fake.requests.any(
        (r) =>
            r.key == 'session/setThoughtLevel' &&
            r.value?['sessionId'] == 'sess-echo' &&
            r.value?['thoughtLevel'] == 'high',
      ),
      isTrue,
      reason: '会话内选择必须直发引擎 session/setThoughtLevel',
    );
    expect(store.thoughtLevel, 'high', reason: 'store 乐观回写是会话档位唯一权威');

    // 重开弹层：回显读 store，勾选落在「高」
    await _openPopupAndExpectEcho(tester, highChecked: true);
    await _dismissSheetAndFlushTimers(tester);
  });
}
