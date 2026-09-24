// ============================================================
// zcode_chat_store_external_test — ConnectionManager 供帧契约
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ZcodeChatStore fedStore(FakeZcodeRelayClient fake) {
    final store = ZcodeChatStore(cache: FakeZcodeSessionCache());
    store.attach(
      fake,
      desktopId: 'desktop-1',
      desktopName: '办公室电脑',
    );
    return store;
  }

  test('attach：接收宿主客户端与桌面身份，不重复 connect', () {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    expect(store.connState, ZcodeConnState.matched);
    expect(store.desktopId, 'desktop-1');
    expect(store.desktopName, '办公室电脑');
    expect(fake.connectCount, 0);
  });

  test('ingestRelayState：掉线后重新 matched 自动刷新会话列表', () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/list'] = (_) => {'sessions': []};
    final store = fedStore(fake);

    store.ingestRelayState(ZcodeRelayState.waiting, false);
    store.ingestRelayState(ZcodeRelayState.matched, true);

    await Future<void>.delayed(Duration.zero);
    expect(fake.requests.map((e) => e.key), contains('session/list'));
  });

  test('detach：清空投影与桌面身份，不关闭宿主客户端', () {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    store.detach();

    expect(store.connState, ZcodeConnState.idle);
    expect(store.desktopId, isNull);
    expect(store.activeSessionId, isNull);
    expect(store.messages, isEmpty);
    expect(fake.closed, isFalse);
  });

  test('ingestReverseRequest：未知方法安全拒绝', () async {
    final store = fedStore(FakeZcodeRelayClient());

    await expectLater(
      store.ingestReverseRequest(
        const ZcodeFrame(id: 'server-9', method: 'x/unknown', params: {}),
      ),
      throwsException,
    );
  });

  test('fetchSubagentThreads：请求带 sessionId（0.16.9 必填）+ 按 agent 聚合',
      () async {
    final fake = FakeZcodeRelayClient();
    fake.handlers['session/resume'] = (_) => {
          'session': {
            'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
          },
          'projection': {'status': 'idle'},
          'messages': [],
        };
    Map<String, dynamic>? subagentsParams;
    fake.handlers['session/subagents'] = (params) {
      subagentsParams = params;
      // probe-subagentflow 实测形状：running[] + ended.items[]，元素
      // {childSessionId, agentId, toolCallId, subagentType, title,
      //  startedAt, status, summary}——协议无 messages 字段
      return {
        'revision': 2,
        'childSessionIds': ['sess_subagent_agent_aaaa'],
        'running': [],
        'ended': {
          'total': 1,
          'items': [
            {
              'childSessionId': 'sess_subagent_agent_aaaa',
              'agentId': 'agent_aaaa',
              'toolCallId': 'call_a1',
              'subagentType': 'Explore',
              'title': '评估 runtime 去桌面依赖',
              'startedAt': 200,
              'status': 'success',
              'summary': '子智能体结论',
            },
          ],
        },
      };
    };
    final store = fedStore(fake);

    await store.openSession('sess-1');
    final threads = await store.fetchSubagentThreads();

    // 协议契约锚定：缺 sessionId 会被 0.16.9 引擎 -32602 拒绝
    expect(subagentsParams?['sessionId'], 'sess-1');
    expect(subagentsParams?.containsKey('action'), isFalse);
    expect(threads, hasLength(1));
    expect(threads.first.agent, 'Explore');
    expect(threads.first.messages.single['content'], '子智能体结论');
    expect(threads.first.messages.single['status'], 'success');
  });

  test('fetchSubagentThreads：无活动会话直接返回空，不发请求', () async {
    final fake = FakeZcodeRelayClient();
    final store = fedStore(fake);

    final threads = await store.fetchSubagentThreads();

    expect(threads, isEmpty);
    expect(fake.requests.map((e) => e.key), isNot(contains('session/subagents')));
  });

  test('ingestNotifyFrame：未知通知帧不崩溃', () {
    final store = fedStore(FakeZcodeRelayClient());

    store.ingestNotifyFrame(
      const ZcodeFrame(method: 'v4/telemetry/event', params: {}),
    );
    expect(store.connState, ZcodeConnState.matched);
  });
}
