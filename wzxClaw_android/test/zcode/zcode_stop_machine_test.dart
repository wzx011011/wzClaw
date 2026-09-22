import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

import 'zcode_test_fakes.dart';

/// 柱1 停止状态机契约（2026-09-22 真实故障驱动）：
/// frpc 隧道僵死时 session/stop 应答丢失，旧实现 busy 永远挂 true。
/// 契约：停止应答丢失且链路中断 → 落显式 unconfirmed 态并释放 busy
/// （回合大概率已被引擎终止——请求能到引擎才会丢应答），禁止自动冲队；
/// 重连后自动对账；turn.completed 迟到也收敛；重试按钮可再次停止。
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  tearDown(() {
    ZcodeNotifier.resetInstanceForTest();
  });

  /// 构造：已打开会话 + 在途回合（isStreaming=true）的最小环境
  Future<({ZcodeChatStore store, FakeZcodeRelayClient fake})>
      busySessionWithStopHandler(
    FutureOr<Object?> Function(Map<String, dynamic>?) stopHandler,
  ) async {
    final fake = FakeZcodeRelayClient();
    stubResumeEmpty(fake);
    fake.handlers['session/events'] = (_) => {'events': []};
    fake.handlers['session/read'] = (_) => {
          'projection': {'status': 'idle'},
        };
    final serverMessages = <Map<String, dynamic>>[
      fakeMsg(
        'user',
        [
          {'type': 'text', 'text': '旧问题'},
        ],
        id: 'b0',
        created: 1,
      ),
      fakeMsg(
        'assistant',
        [
          {'type': 'text', 'text': '旧回答'},
        ],
        id: 'b1',
        created: 2,
      ),
    ];
    fake.handlers['session/send'] = (_) {
      serverMessages.add(
        fakeMsg(
          'user',
          [
            {'type': 'text', 'text': 'go'},
          ],
          id: 'u1',
          created: 3,
        ),
      );
      return {'accepted': true};
    };
    fake.handlers['session/stop'] = stopHandler;
    fake.handlers['session/messages'] = (params) {
      final after = params?['afterMessageId'] as String?;
      if (after == null) return {'messages': List.of(serverMessages)};
      final idx = serverMessages.indexWhere((m) => m['info']['id'] == after);
      return {
        'messages':
            idx < 0 ? List.of(serverMessages) : serverMessages.sublist(idx + 1),
      };
    };
    final store = pairedStore(fake);
    await store.openSession('sess-stop');
    await store.sendMessage('go');
    return (store: store, fake: fake);
  }

  group('停止状态机（柱1）', () {
    test('停止应答丢失且链路中断 → unconfirmed 显式态 + busy 释放', () async {
      final env = await busySessionWithStopHandler((_) {
        // 模拟 frpc 隧道僵死：请求发出但应答永远不回（超时抛错）
        throw Exception('timeout: no response');
      });
      final store = env.store;
      env.fake.handlers['session/read'] =
          (_) => throw Exception('link dead'); // 对账读取也失败
      expect(store.isStreaming, isTrue);

      await store.stopGeneration();

      // 旧实现缺陷：busy 永远 true。契约：显式 unconfirmed + busy 释放。
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);
    });

    test('unconfirmed 重连恢复且引擎已停 → 自动对账回 idle', () async {
      final env = await busySessionWithStopHandler(
        (_) => throw Exception('timeout: no response'),
      );
      final store = env.store;
      env.fake.handlers['session/read'] = (_) => throw Exception('link dead');
      await store.stopGeneration();
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);

      // 链路恢复：session/read 可达且引擎 idle
      env.fake.handlers['session/read'] = (_) => {
            'projection': {'status': 'idle'},
          };
      await store.debugReconcileStopAfterReconnect();

      expect(store.activeStopPhase, ZcodeStopPhase.idle);
      expect(store.isStreaming, isFalse);
    });

    test('unconfirmed 重连恢复但引擎仍在跑 → 重发停止并以 idle 收尾', () async {
      var stopCalls = 0;
      final env = await busySessionWithStopHandler((_) {
        stopCalls++;
        throw Exception('timeout: no response');
      });
      final store = env.store;
      env.fake.handlers['session/read'] = (_) => throw Exception('link dead');
      await store.stopGeneration();
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);

      // 链路恢复但引擎没收到停止（仍在跑）：应重发停止
      env.fake.handlers['session/read'] = (_) => {
            'projection': {'status': 'running'},
          };
      env.fake.handlers['session/stop'] = (_) {
        stopCalls++;
        return {};
      };
      await store.debugReconcileStopAfterReconnect();

      expect(stopCalls, 2, reason: '引擎仍在跑时必须重发停止');
      expect(store.activeStopPhase, ZcodeStopPhase.idle);
    });

    test('unconfirmed 期间 turn.completed 迟到 → 收敛回 idle', () async {
      final env = await busySessionWithStopHandler(
        (_) => throw Exception('timeout: no response'),
      );
      final store = env.store;
      env.fake.handlers['session/read'] = (_) => throw Exception('link dead');
      await store.stopGeneration();
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);

      pushEvent(
        store,
        sessionId: 'sess-stop',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-x',
        payload: {'resultType': 'interrupt'},
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(store.activeStopPhase, ZcodeStopPhase.idle);
    });

    test('停止成功路径 stopPhase 回 idle（happy path 回归锚）', () async {
      final env = await busySessionWithStopHandler((_) => {});
      final store = env.store;

      await store.stopGeneration();

      expect(store.activeStopPhase, ZcodeStopPhase.idle);
      expect(store.isStreaming, isFalse);
    });

    test('acknowledge 后 unconfirmed 通告解除（用户知情接受未知态）', () async {
      final env = await busySessionWithStopHandler(
        (_) => throw Exception('timeout: no response'),
      );
      final store = env.store;
      env.fake.handlers['session/read'] = (_) => throw Exception('link dead');
      await store.stopGeneration();
      expect(store.activeStopPhase, ZcodeStopPhase.unconfirmed);

      store.acknowledgeStopUnconfirmed();
      expect(store.activeStopPhase, ZcodeStopPhase.idle);
    });
  });
}
