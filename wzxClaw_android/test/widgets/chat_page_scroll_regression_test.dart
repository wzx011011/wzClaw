// ============================================================
// chat_page_scroll_regression_test — 消息列表滚动回归（根治钉）
//
// 复现并钉死的三条滚动契约：
// 1. 打开会话：视口定位到最新消息（聊天语义 = 打开即最新）；
// 2. 贴顶下滑：加载更早绝不吞掉进行中的手势（旧实现按 _loadingOlder
//    在「裸列表」与「Column(进度条+列表)」间切换树形状，ListView 的
//    Element/ScrollPosition 每次销毁重建 → 位置归零 + 拖动死亡）；
// 3. 加载更早：视口锚点不跳（前插只向头部增长，视口必须平移同样的
//    增量，正在看的内容原地不动）。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

import '../zcode/zcode_test_fakes.dart';

ZcodeSessionItem _seed(int i) => ZcodeSessionItem(
      protoId: 'h$i',
      synced: true,
      message: ChatMessage(
        role: i.isEven ? MessageRole.user : MessageRole.assistant,
        processParts: [ChatProcessPart.text('历史 $i')],
        createdAt: DateTime.fromMillisecondsSinceEpoch(1700000000000 + i),
      ),
    );

/// 真机 sqflite 往返必然跨帧：_loadingOlder 的树形状切换会真正渲染出
/// 一帧。替身缓存在微任务内完成时该帧永远不出现，测不出手势被杀。
/// 只对第二次及以后的 loadTail（真正的「加载更早」路径）延迟——首次
/// 发生在 openSession 期间，测试的 FakeAsync 时钟那时不会推进，延迟
/// 会死锁测试本身。
class _DelayedTailCache extends FakeZcodeSessionCache {
  int _calls = 0;

  @override
  Future<List<ZcodeSessionItem>> loadTail(
    String sessionId, {
    int limit = 80,
  }) async {
    final rows = await super.loadTail(sessionId, limit: limit);
    _calls++;
    if (_calls > 1) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    return rows;
  }
}

Future<ScrollController> _pumpPage(
  WidgetTester tester, {
  int cacheCount = 80,
  FakeZcodeSessionCache? cache,
}) async {
  SharedPreferences.setMockInitialValues({});
  ZcodeNotifier.resetInstanceForTest();
  ZcodeNotifier.setInstanceForTest(FakeZcodeNotifier());

  final effectiveCache = cache ?? FakeZcodeSessionCache();
  effectiveCache.messages['sess-scroll'] = [
    for (var i = 0; i < cacheCount; i++) _seed(i),
  ];
  final fake = FakeZcodeRelayClient();
  FakeSessionServer().bind(fake);
  final store = ZcodeChatStore(cache: effectiveCache)
    ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
  await store.openSession('sess-scroll');

  ChatPage.debugStoreOverride = store;
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData(extensions: const [AppColors.dark]),
      home: const ChatPage(),
    ),
  );
  await tester.pumpAndSettle();

  return tester
      .widgetList<ListView>(
        find.byWidgetPredicate((w) => w is ListView && w.controller != null),
      )
      .first
      .controller!;
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  tearDown(() {
    ChatPage.debugStoreOverride = null;
  });

  testWidgets('打开会话：视口定位到最新消息（不再停在历史顶部）', (tester) async {
    await _pumpPage(tester);

    expect(
      find.textContaining('历史 79', findRichText: true),
      findsOneWidget,
      reason: '聊天语义 = 打开即最新；旧实现打开后停在顶部，最新消息不可见',
    );
  });

  testWidgets('贴顶下滑：加载更早绝不吞掉进行中的手势', (tester) async {
    final controller = await _pumpPage(
      tester,
      cache: _DelayedTailCache(), // 加载跨帧：切换帧真正渲染（真机语义）
    );

    // 贴顶：触发一次加载更早（缓存只有尾窗 → added=0）
    controller.jumpTo(0);
    await tester.pump();
    await tester.pumpAndSettle();

    // 手动驱动手势并在中途 pump：让「加载更早」的树形状切换在手势进行中
    // 真正渲染一帧——旧实现在这一帧销毁重建 ListView，手势就此死亡
    final listFinder =
        find.byWidgetPredicate((w) => w is ListView && w.controller != null);
    final gesture = await tester.startGesture(tester.getCenter(listFinder));
    await gesture.moveBy(const Offset(0, -40)); // 越过 slop，贴顶触发加载
    await tester.pump();
    await gesture.moveBy(const Offset(0, -260)); // 手势继续：必须仍然生效
    await tester.pump(const Duration(milliseconds: 80));
    await gesture.up();
    await tester.pumpAndSettle();

    expect(
      controller.position.pixels,
      greaterThan(250),
      reason: '回归：加载更早的树形状切换把 ListView 连 Element 带滚动位置'
          '一起销毁重建，正在进行的拖动手势被杀，用户永远滑不离顶部',
    );
  });

  testWidgets('加载更早：视口锚点不跳（正在看的内容不位移）', (tester) async {
    final controller = await _pumpPage(tester, cacheCount: 160);

    // 先去底部（打开即最新的语义），再贴顶触发加载更早
    controller.jumpTo(controller.position.maxScrollExtent);
    await tester.pump();
    controller.jumpTo(0);
    await tester.pump();
    await tester.pumpAndSettle();

    expect(
      find.textContaining('历史 80', findRichText: true),
      findsOneWidget,
      reason: '贴顶前视口顶部的消息是「历史 80」；前插 40 条更早消息后它必须'
          '原位不动（锚点补偿），而不是被重置回更早的新加载内容',
    );
  });
}
