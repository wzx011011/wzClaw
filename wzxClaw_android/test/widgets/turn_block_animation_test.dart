// ============================================================
// turn_block_animation_test — 入场动画包装稳定性回归
// （f-render-stream-consumption-2）
//
// 钉死的契约：入场动画判定从「数量比较」改为「块键集合差集」——
// 数量比较下流式下一条增量即追平 prevCount，AnimatedMessageItem 槽位
// 类型翻回裸块 → 子树销毁重建，150ms 淡入在 1/3 处跳变为全不透明；
// 前插加载更早时旧尾块被误包装重播动画。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/widgets/animated_message_item.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

import '../zcode/zcode_test_fakes.dart';

/// 种子消息：user/assistant 交替，时间递增（缓存翻页契约）
ZcodeSessionItem _seed(int i) => ZcodeSessionItem(
      protoId: 'seed-$i',
      synced: true,
      message: ChatMessage(
        role: i.isEven ? MessageRole.user : MessageRole.assistant,
        processParts: [ChatProcessPart.text('历史 $i')],
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000 + i),
      ),
    );

Future<ZcodeChatStore> _pumpPage(
  WidgetTester tester, {
  required FakeZcodeSessionCache cache,
}) async {
  SharedPreferences.setMockInitialValues({});
  ZcodeNotifier.resetInstanceForTest();
  ZcodeNotifier.setInstanceForTest(FakeZcodeNotifier());

  final fake = FakeZcodeRelayClient();
  FakeSessionServer().bind(fake);
  final store = ZcodeChatStore(cache: cache)
    ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
  addTearDown(store.dispose);
  await store.openSession('sess-anim');

  ChatPage.debugStoreOverride = store;
  addTearDown(() => ChatPage.debugStoreOverride = null);
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData(extensions: const [AppColors.dark]),
      home: const ChatPage(),
    ),
  );
  await tester.pumpAndSettle();
  return store;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  testWidgets('追加侧：流式下一条增量后 AnimatedMessageItem 仍在树中（不截断）',
      (tester) async {
    final cache = FakeZcodeSessionCache();
    cache.messages['sess-anim'] = [
      _seed(0),
      _seed(1),
    ];
    final store = await _pumpPage(tester, cache: cache);

    // 新回合：turn.started + 首条带 id 增量（新块键首帧被包装入场动画）
    pushEvent(
      store,
      sessionId: 'sess-anim',
      type: 'turn.started',
      seq: 1,
      turnId: 't-anim',
      payload: {'messageId': 'srv-anim-u', 'input': '新问题'},
    );
    pushEvent(
      store,
      sessionId: 'sess-anim',
      type: 'model.streaming',
      seq: 2,
      turnId: 't-anim',
      payload: {
        'assistantMessageId': 'msg-anim',
        'kind': 'text_delta',
        'delta': '回答第一段',
      },
    );
    await tester.pump(const Duration(milliseconds: 20));
    final wrappersAfterFirst =
        find.byType(AnimatedMessageItem).evaluate().length;
    expect(
      wrappersAfterFirst,
      greaterThan(0),
      reason: '前置：新块首帧被包入场动画',
    );

    // 流式下一条增量（几十 ms 内）：修复前 prevCount 追平 → 槽位翻回
    // 裸块 → AnimatedMessageItem 从树中消失（动画截断 + 子树重建）
    pushEvent(
      store,
      sessionId: 'sess-anim',
      type: 'model.streaming',
      seq: 3,
      turnId: 't-anim',
      payload: {
        'assistantMessageId': 'msg-anim',
        'kind': 'text_delta',
        'delta': '回答第二段',
      },
    );
    await tester.pump(const Duration(milliseconds: 20));

    expect(
      find.byType(AnimatedMessageItem).evaluate().length,
      greaterThanOrEqualTo(wrappersAfterFirst),
      reason: '动画包装必须保持（槽位类型翻回 = 150ms 淡入截断 + 子树重建）',
    );
    // 收尾回合（解除看门狗）并让动画 ticker 与列表延迟刷新走完，
    // 避免 pending Timer 违例
    pushEvent(
      store,
      sessionId: 'sess-anim',
      type: 'turn.completed',
      seq: 4,
      turnId: 't-anim',
      payload: {'response': '回答完毕', 'resultType': 'success'},
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 2000));
  });

  testWidgets('前插侧：加载更早的旧块不被包装重播动画', (tester) async {
    final cache = FakeZcodeSessionCache();
    // 缓存尾窗 6 条（视口同款）；更早 40 条在上滑前补入缓存
    //（模拟历史会话的既有缓存——缓存多于视口的真实形态）
    cache.messages['sess-anim'] = [
      for (var i = 0; i < 6; i++) _seed(100 + i),
    ];
    final store = await _pumpPage(tester, cache: cache);
    final wrappersBefore = find.byType(AnimatedMessageItem).evaluate().length;

    // 补入更早历史后贴顶触发前插（走页面 _loadOlderWithFeedback：
    // 豁免旗标在该路径置位；等价用户上滑翻页）
    cache.messages['sess-anim'] = [
      ...cache.messages['sess-anim']!,
      for (var i = 0; i < 40; i++) _seed(60 + i),
    ]..sort((a, b) => a.message.createdAt.compareTo(b.message.createdAt));
    final controller = tester
        .widgetList<ListView>(
          find.byWidgetPredicate((w) => w is ListView && w.controller != null),
        )
        .first
        .controller!;
    controller.jumpTo(200); // 先离开顶部（jumpTo 同值不触发滚动通知）
    await tester.pump(const Duration(milliseconds: 30));
    controller.jumpTo(0); // 贴顶：触发 _onScroll → _loadOlderWithFeedback
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 120));

    // 前插生效断言在 store 层（锚点补偿会把视口推离新前插的内容，
    // 懒加载列表里它不参与 build）
    expect(
      store.messages.map((m) => m.text).where((t) => t.contains('历史 60')),
      isNotEmpty,
      reason: '前置：前插已生效（更早历史进入时间线）',
    );
    expect(
      find.byType(AnimatedMessageItem).evaluate().length,
      wrappersBefore,
      reason: '前插的更早历史是旧内容，不得被误包装重播入场动画',
    );
  });
}
