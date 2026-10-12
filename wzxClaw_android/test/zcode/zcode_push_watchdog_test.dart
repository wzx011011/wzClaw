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

  test('f-reconnect-replay-degrade-3 推送帧到即续期看门狗：轮询停止后再次静默能重新拉起',
      () async {
    final fake = FakeZcodeRelayClient();
    FakeSessionServer().bind(fake);
    fake.handlers['session/events'] = (_) => {
          'events': [
            {
              'eventId': 'ev-dg3',
              'seq': 99,
              'sessionId': 'sess-dg3',
              'type': 'text_delta',
              'payload': {'delta': '轮询增量'},
            },
          ],
        };
    final store = pairedStore(fake);
    addTearDown(store.dispose);
    store.pushWatchdogDelay = const Duration(milliseconds: 60);
    await store.openSession('sess-dg3');
    await store.sendMessage('hi');

    // 第一次推送静默：看门狗到期 → 拉起降级轮询
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(
      fake.requests.any((r) => r.key == 'session/events'),
      isTrue,
      reason: '前置：推送静默触发了降级轮询',
    );

    // 一帧推送恢复：轮询停止；修复点——该帧同时续期看门狗。
    // 断言窗口取 30ms（< 60ms 看门狗延迟）：窗口内无新轮询请求即证明
    // 「推送恢复即停轮询」；窗口之后看门狗若因推送再次静默而到期拉起
    // 轮询，属修复后的预期自持行为
    var pollCount =
        fake.requests.where((r) => r.key == 'session/events').length;
    pushEvent(
      store,
      sessionId: 'sess-dg3',
      type: 'model.streaming',
      seq: 100,
      turnId: 't-dg3',
      payload: {
        'assistantMessageId': 'msg-dg3',
        'kind': 'text_delta',
        'delta': '推送增量',
      },
    );
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(
      fake.requests.where((r) => r.key == 'session/events').length,
      pollCount,
      reason: '推送恢复即停轮询（既有语义，验证窗口在看门狗延迟内）',
    );

    // 同回合内推送再次静默：续期后的看门狗到期 → 轮询必须重新拉起
    //（修复前：看门狗被消费后无人重武装，防线永久拆除）
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(
      fake.requests.where((r) => r.key == 'session/events').length,
      greaterThan(pollCount),
      reason: '看门狗到期拉起轮询后，一帧推送停轮询不应永久拆除防线',
    );
  });
}
