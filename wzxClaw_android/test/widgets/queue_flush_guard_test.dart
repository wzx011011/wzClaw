// ============================================================
// queue_flush_guard_test — 排队消息冲放门禁回归
// （f-viewport-multi-session-1）
//
// 钉死的契约：队列冲放定时器到点时必须复查连接状态与停止状态机——
// 断连/停止未确认窗口内逐条放空且直发失败不回队 = 排队文本永久丢失。
// 「空闲判定+是否可冲放」抽成 store 派生 getter（单一真相）：
// 页面调度条件与定时器体复查同源。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/ui_prefs.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

import '../zcode/zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  group('store 派生门禁 canAutoFlushQueue', () {
    test('matched+空闲=true；断连=false；停止未确认=false', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('sess-gate');
      expect(
        store.canAutoFlushQueue,
        isTrue,
        reason: '已连接且空闲：允许冲放（基线）',
      );

      // 断连：connState 退回 idle
      fake.closed = true;
      store.ingestRelayState(ZcodeRelayState.closed, false);
      expect(
        store.canAutoFlushQueue,
        isFalse,
        reason: '断连窗口冲放 = sendMessage 未连接早退且消息不回队',
      );

      // 恢复连接并制造「停止未确认」
      fake.closed = false;
      store.ingestRelayState(ZcodeRelayState.matched, true);
      await store.sendMessage('hi');
      fake.handlers['session/stop'] = (_) =>
          throw const ZcodeRequestException(-32000, '链路中断');
      fake.handlers['session/read'] = (_) =>
          throw const ZcodeRequestException(-32000, '链路中断');
      await store.stopGeneration();
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);
      expect(
        store.canAutoFlushQueue,
        isFalse,
        reason: '停止未确认时放行队列下一条 = 引擎上第三个回合',
      );
    });
  });

  testWidgets('断连窗口内冲队定时器到点：队首保留不蒸发', (tester) async {
    final fake = FakeZcodeRelayClient();
    FakeSessionServer().bind(fake);
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache())
      ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
    await store.openSession('sess-flush');

    // 输入栏 enabled 依赖 ConnectionManager connected；测试后还原单例
    ConnectionManager.instance.debugAttachClient(FakeZcodeRelayClient());
    addTearDown(() {
      ChatPage.debugStoreOverride = null;
      ConnectionManager.instance.disconnect();
    });
    ChatPage.debugStoreOverride = store;
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(extensions: const [AppColors.dark]),
        home: const ChatPage(),
      ),
    );
    await tester.pumpAndSettle();

    // 制造流式：回合开始推送（发送即入队）
    pushEvent(
      store,
      sessionId: 'sess-flush',
      type: 'turn.started',
      seq: 1,
      turnId: 't-flush',
      payload: {'messageId': 'srv-u-flush', 'input': 'first'},
    );
    await tester.pump(const Duration(milliseconds: 50));

    // 流式中 UI 的发送按钮是「停止」；入队走回车发送路径
    UiPrefs.enterToSend.value = true;
    addTearDown(() => UiPrefs.enterToSend.value = false);
    await tester.enterText(find.byType(TextField).last, '排队消息甲');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      find.textContaining('排队消息甲'),
      findsWidgets,
      reason: '前置：流式期间发送已入队（排队条卡片可见）',
    );
    expect(
      fake.requests.any((r) => r.key == 'session/send'),
      isFalse,
      reason: '前置：排队消息未直发',
    );

    // 回合结束：调度门禁满足（只查空闲/恢复/停止，不查连接）→ 冲放
    // 定时器排定；随后 500ms 窗口内 relay 掉线——调度时的门禁不约束
    // 已排定的定时器，这正是缺陷时序
    pushEvent(
      store,
      sessionId: 'sess-flush',
      type: 'turn.completed',
      seq: 2,
      turnId: 't-flush',
      payload: {'response': '回答完毕', 'resultType': 'success'},
    );
    await tester.pump(const Duration(milliseconds: 50));
    fake.closed = true;
    store.ingestRelayState(ZcodeRelayState.closed, false);
    await tester.pump(const Duration(milliseconds: 50));

    // 定时器到点（500ms 去抖 + 余量）；再 pump 2s 让 turn.completed 触发
    // 的列表延迟刷新跑完（避免 pending Timer 违例干扰断言）
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pump(const Duration(milliseconds: 2000));

    expect(
      find.textContaining('排队消息甲'),
      findsWidgets,
      reason: '断连窗口冲放 = removeAt 后 sendMessage 未连接早退不回队，'
          '消息文本永久丢失',
    );
    expect(
      fake.requests.any((r) => r.key == 'session/send'),
      isFalse,
      reason: '断连状态下绝不能发出排队消息',
    );
    store.dispose();
  });
}
