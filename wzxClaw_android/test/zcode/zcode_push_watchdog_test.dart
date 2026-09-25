// ============================================================
// zcode_push_watchdog_test — 推送看门狗多会话并发回归
// （f-streaming-ingest-cursor-5）
//
// 钉死的契约：看门狗不得是全局单槽——多会话并发流式时，后武装者
// cancel 掉先武装者的检测，被顶掉的会话推送静默失效后无人拉起降级轮询。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  test('双会话并发流式：后武装者不得取消先武装者的看门狗，两者均按期触发',
      () async {
    final fake = FakeZcodeRelayClient();
    FakeSessionServer().bind(fake);
    fake.handlers['session/events'] = (params) => {
          'events': [
            {
              'eventId': 'ev-wd-${params?['sessionId']}',
              'seq': 1,
              'sessionId': params?['sessionId'],
              'type': 'text_delta',
              'payload': {'delta': '轮询增量'},
            },
          ],
        };
    final store = pairedStore(fake);
    addTearDown(store.dispose);
    store.pushWatchdogDelay = const Duration(milliseconds: 60);

    // 后台会话 A：先打开、发送开启流式（武装 A 的看门狗）
    await store.openSession('sess-wa');
    await store.sendMessage('hi-a');
    // 切到视口会话 B 并发送（武装 B 的看门狗）
    await store.openSession('sess-wb');
    await store.sendMessage('hi-b');

    // 修复点：A 与 B 的看门狗必须同时处于排程态（旧单槽实现 B 顶掉 A）
    expect(
      store.debugWatchdogSessionIds,
      containsAll(<String>['sess-wa', 'sess-wb']),
      reason: '看门狗被单槽顶掉 = 后台会话推送静默失效后无人兜底',
    );

    // 推进超过看门狗阈值：两者均按期触发——视口 B 拉起降级轮询；
    // A 的看门狗到期消费（不再滞留在排程集合 = 按期触发而非被顶掉）
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(
      store.debugWatchdogSessionIds,
      isNot(contains('sess-wa')),
      reason: 'A 的看门狗应按期到期触发，而不是被 B 的武装取消',
    );
    expect(
      fake.requests
          .where((r) => r.key == 'session/events')
          .map((r) => r.value?['sessionId']),
      contains('sess-wb'),
      reason: '视口会话 B 的看门狗到期应拉起降级轮询',
    );
  });
}
