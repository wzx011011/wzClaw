// ============================================================
// zcode_chat_store_external_test — 外部供帧模式（R1 换接线桥）
//
// 连接所有权在宿主（services/ConnectionManager）时，引擎帧经
// attachExternal + ingest* 转入 store。本套件钉住供帧契约：
// 连接态同步、不自建连接（restore/reconnect/unpair 守卫）、
// detach 复位、反向请求安全拒绝。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(client: fake, cache: FakeZcodeSessionCache());
    store.attachExternal(fake);
    return store;
  }

  test('attachExternal：连接态取自宿主客户端，不自建连接', () {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    expect(store.isExternallyFed, isTrue);
    expect(store.connState, ZcodeConnState.matched);
    expect(fake.connectCount, 0, reason: '宿主已连接，store 不得再次 connect');
  });

  test('ingestRelayState：掉线→重连后自动刷新会话列表', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/list'] = (_) => {'sessions': []};
    final store = fedStore(fake);

    store.ingestRelayState(ZcodeRelayState.waiting, false);
    expect(store.connState, isNot(ZcodeConnState.matched));
    store.ingestRelayState(ZcodeRelayState.matched, true);

    await Future<void>.delayed(Duration.zero);
    expect(
      fake.requests.map((e) => e.key),
      contains('session/list'),
      reason: '重连 matched 后自动拉会话列表（语义同自建路径）',
    );
  });

  test('外部供帧守卫：restore/reconnect/unpair 不自建连接、不清宿主客户端',
      () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/list'] = (_) => {'sessions': []};
    final store = fedStore(fake);

    await store.restore();
    expect(store.isExternallyFed, isTrue);
    expect(fake.connectCount, 0, reason: 'restore 不得自建第二条连接');

    await store.reconnect();
    expect(fake.closed, isFalse);
    expect(fake.requests.map((e) => e.key), contains('session/list'));

    store.unpair();
    expect(store.isExternallyFed, isTrue, reason: 'unpair 被守卫忽略');
    expect(fake.closed, isFalse, reason: '宿主客户端生命周期归宿主');
  });

  test('detachExternal：回到未配对空态，宿主客户端不受影响', () {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    store.detachExternal();
    expect(store.isExternallyFed, isFalse);
    expect(store.connState, ZcodeConnState.idle);
    expect(store.activeSessionId, isNull);
    expect(store.messages, isEmpty);
    expect(fake.closed, isFalse);

    // 幂等：重复 detach 无害
    store.detachExternal();
    expect(store.isExternallyFed, isFalse);
  });

  test('ingestReverseRequest：未知方法安全拒绝（不默认批准）', () async {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    await expectLater(
      store.ingestReverseRequest(
        const ZcodeFrame(id: 'server-9', method: 'x/unknown', params: {}),
      ),
      throwsException,
    );
  });


  test('fetchSubagentThreads：按 info.agent 聚合、最新线程在前', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/subagents'] = (_) => {
          'messages': [
            {
              'info': {
                'id': 'sa-2',
                'agent': 'Explore',
                'role': 'assistant',
                'time': {'created': 200},
              },
              'parts': [
                {'type': 'text', 'text': '子智能体结论'},
              ],
            },
            {
              'info': {
                'id': 'sa-1',
                'agent': 'Explore',
                'role': 'assistant',
                'time': {'created': 100},
              },
              'parts': [
                {'type': 'text', 'text': '子智能体开始'},
              ],
            },
          ],
        };
    final store = fedStore(fake);

    final threads = await store.fetchSubagentThreads();

    expect(threads, hasLength(1));
    expect(threads.first.agent, 'Explore');
    expect(threads.first.messages.length, 2);
    // 聚合行形状：role/content/created_at（面板摘要渲染依赖）
    expect(threads.first.messages.first['content'], '子智能体结论');
    expect(threads.first.messages.first['role'], 'assistant');
  });

  test('ingestNotifyFrame：未知通知帧不崩溃', () {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    store.ingestNotifyFrame(
      const ZcodeFrame(method: 'v4/telemetry/event', params: {}),
    );
    expect(store.isExternallyFed, isTrue);
  });
}
