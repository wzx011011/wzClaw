// ============================================================
// zcode_streaming_cursor_test — 流式游标与占位身份回归（2026-09-25 审查）
//
// 钉死的契约：
// 1. finalizeStreaming 收尾必须清 streamingProtoId/streamingTurnId——
//    否则非手机 sendMessage 开启的新回合（桌面壳发起）经旧形态无 id
//    增量建占位时继承上一回合 assistantMessageId，被旧回合收尾权威
//    刷新按同 id 原位覆盖（f-streaming-ingest-cursor-1）。
// ============================================================

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  group('f-streaming-ingest-cursor-1 收尾清流式游标', () {
    test('finalize 后无 id 增量新建占位的 protoId 必须为 null', () {
      final state = ZcodeSessionState('sess-c1');
      // T1：带 id 增量建占位（protoId=msg-1）
      state.ensureStreamingPlaceholder(
        assistantMessageId: 'msg-1',
        turnId: 'turn-t1',
      );
      state.appendTextDelta('T1 回答', assistantMessageId: 'msg-1');
      expect(state.streamingProtoId, 'msg-1');

      // T1 收尾：turn.completed → finalizeStreaming
      state.finalizeStreaming();

      // 修复点：收尾必须连 streamingProtoId/streamingTurnId 一并清空
      //（对齐 resetTurnState 语义）
      expect(state.streamingProtoId, isNull, reason: '收尾后流式游标 id 必须清空');
      expect(state.streamingTurnId, isNull, reason: '收尾后流式回合 id 必须清空');

      // 下一回合（桌面壳发起）的旧形态无 id 增量：新建占位不得继承 msg-1
      state.ensureStreamingPlaceholder(turnId: 'turn-t2');
      expect(
        state.items.last.protoId,
        isNull,
        reason: '无 id 增量新建占位不得继承上一回合的 assistantMessageId',
      );
    });

    test('桌面端 T2 旧形态增量 + T1 权威刷新迟到：T1 权威消解 P1、T2 正文完好、无同 id 双行',
        () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('sess-c1s');

      // T1：手机端 sendMessage 开启，流式占位 P1（protoId=msg-1）
      await store.sendMessage('T1 问题');
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'turn.started',
        seq: 1,
        turnId: 'turn-t1',
        payload: {'messageId': 'srv-u-0', 'input': 'T1 问题'},
      );
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'model.streaming',
        seq: 2,
        turnId: 'turn-t1',
        payload: {
          'assistantMessageId': 'msg-1',
          'kind': 'text_delta',
          'delta': 'T1 部分',
        },
      );

      // 挂起 T1 收尾触发的权威刷新（session/messages），模拟「响应迟到」
      final gate = Completer<void>();
      fake.handlers['session/messages'] = (params) async {
        await gate.future;
        final s = server.session('sess-c1s');
        return {'messages': List.of(s.messages)};
      };
      // 服务端权威消息：T1 的完整回答落库（id=msg-1）
      server.session('sess-c1s').messages.add(
            fakeMsg(
              'assistant',
              [
                {'type': 'text', 'text': 'T1 完整回答'},
              ],
              id: 'msg-1',
              created: 200,
            ),
          );

      // T1 收尾：finalizeStreaming 置 streamingIndex=-1，权威刷新在途
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'turn.completed',
        seq: 3,
        turnId: 'turn-t1',
        payload: {'response': 'T1 完整回答', 'resultType': 'success'},
      );

      // 桌面壳（同 app-server 进程）发起 T2：turn.started 推进代次后，
      // 旧形态无 id 增量到达（session/events 降级轮询/断线补放的
      // {'kind':'text_delta'} 形态不带 assistantMessageId）
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'turn.started',
        seq: 4,
        turnId: 'turn-t2',
        payload: {'messageId': 'srv-u-1', 'input': 'T2 问题'},
      );
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'text_delta',
        seq: 5,
        turnId: 'turn-t2',
        payload: {'delta': 'T2 新回答'},
      );
      final t2Item = store.debugItems('sess-c1s').last;
      // 修复点：新建占位不得继承上一回合的 msg-1
      expect(
        t2Item.protoId,
        isNull,
        reason: 'T2 占位继承 msg-1 后会被 T1 权威刷新按同 id 原位覆盖',
      );

      // T1 收尾权威刷新迟到落地
      gate.complete();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final items = store.debugItems('sess-c1s');
      // T1 权威消息恰一行（消解 P1，不得留下重复行）
      expect(
        items.where((e) => e.message.text.contains('T1 完整回答')),
        hasLength(1),
        reason: 'T1 回答重复出现 = 占位被权威合并遗弃',
      );
      // T2 正文完好（未被 T1 权威消息覆盖）
      expect(
        items.last.message.text,
        contains('T2 新回答'),
        reason: 'T2 正在累积的正文被 T1 权威消息覆盖 = 串台',
      );
      // T2 后续无 id 增量继续落 T2 行（不串进 T1 权威行）
      pushEvent(
        store,
        sessionId: 'sess-c1s',
        type: 'text_delta',
        seq: 6,
        turnId: 'turn-t2',
        payload: {'delta': '（追加）'},
      );
      expect(
        store.debugItems('sess-c1s').last.message.text,
        'T2 新回答（追加）',
        reason: 'T2 增量不得写进已被 T1 权威占据的行',
      );
    });
  });
}
