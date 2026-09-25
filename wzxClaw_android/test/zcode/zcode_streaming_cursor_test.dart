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
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
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

  group('f-streaming-ingest-cursor-2 api_retry 回合边界', () {
    test('已收尾未确认残影正文保留，仅当前在途行被清理', () {
      final state = ZcodeSessionState('sess-c2');
      // T1：流式回答 → 收尾（isStreaming=false，未 synced——权威刷新在途）
      state.appendTextDelta('T1 完整回答文本', turnId: 'turn-t1');
      state.finalizeStreaming();
      final t1 = state.items.single;
      expect(t1.message.isStreaming, isFalse);
      expect(t1.synced, isFalse);

      // T2 开始（sendMessage 不清 items，T1 残影保留在时间线）
      state.beginLocalTurn();
      state.ensureStreamingPlaceholder(turnId: 'turn-t2');
      state.appendTextDelta('T2 进行中', turnId: 'turn-t2');

      // T2 首个事件 api_retry（模型过载重试，进程内推送必达）
      state.discardAbortedAttempt();

      // 修复点：上一回合已收尾的未确认残影不得被剔除
      expect(
        state.items.first.message.text,
        'T1 完整回答文本',
        reason: 'api_retry 无回合边界会把上一回合未落权威的回答清空',
      );
      // 当前在途行仍正常清理（残部剔除语义不变）
      expect(
        state.items.last.message.processParts,
        isEmpty,
        reason: '活的在途行残部仍须剔除，重发从干净状态开始',
      );
    });
  });

  group('f-streaming-ingest-cursor-3 synced 行流式写入', () {
    test('中途权威替换后同 id 增量：不置 isStreaming，收尾后保持复位', () {
      final state = ZcodeSessionState('sess-c3');
      state.appendTextDelta('流式中', assistantMessageId: 'msg-a', turnId: 'turn-t1');

      // 工具 result 触发 finishTurn:false 权威刷新：同 id 原位替换为 synced 行
      //（游标按设计留指该行，见 mergeAuthoritative 方法注释）
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-a',
          turnId: 'turn-t1',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            processParts: const [ChatProcessPart.text('权威中途版')],
          ),
        ),
      ]);
      expect(state.items.single.synced, isTrue);

      // 后续同 id text_delta：扫描跳 synced → cursorUsable 放行写入 synced 行
      state.appendTextDelta('后续增量', assistantMessageId: 'msg-a');

      // 修复点：流式写入通道对 synced 行保持原 isStreaming（不置 true）
      final row = state.items.single;
      expect(
        row.message.isStreaming,
        isFalse,
        reason: 'synced 权威行被置 isStreaming=true 后收尾跳过，「生成中」永久滞留',
      );
      expect(row.message.text, '权威中途版后续增量');

      // 回合收尾：synced=true 且 isStreaming=false（缓存不持久化假忙碌态）
      state.finalizeStreaming();
      expect(state.items.single.synced, isTrue);
      expect(state.items.single.message.isStreaming, isFalse);
    });

    test('工具更新落 synced 权威行同样不置 isStreaming', () {
      final state = ZcodeSessionState('sess-c3b');
      state.upsertStreamingTool(
        const ToolCallInfo(toolCallId: 'call-1', toolName: 'Bash'),
        assistantMessageId: 'msg-a',
        turnId: 'turn-t1',
      );
      state.mergeAuthoritative([
        ZcodeSessionItem(
          protoId: 'msg-a',
          turnId: 'turn-t1',
          synced: true,
          message: ChatMessage(
            role: MessageRole.assistant,
            createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
            processParts: const [],
          ),
        ),
      ]);
      // 工具结果晚到落权威行（authoritative_parity 既有契约）
      state.upsertStreamingTool(
        const ToolCallInfo(
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: ToolCallStatus.done,
          outputSummary: 'ok',
        ),
      );
      expect(state.items.single.synced, isTrue);
      expect(
        state.items.single.message.isStreaming,
        isFalse,
        reason: '工具通道写入 synced 行同样不得翻起生成中态',
      );
    });
  });

  group('f-streaming-ingest-cursor-4 降级轮询推进式拉取', () {
    test('150 条事件超窗口：afterSeq 循环拉取无中段丢失', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      // 订阅失败 → pushAvailable=false，走降级轮询
      fake.handlers['session/subscribe'] = (_) =>
          throw const ZcodeRequestException(-32601, 'method not found');
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('sess-c4');
      await store.sendMessage('q');
      expect(store.isStreaming, isTrue);

      // APP-SERVER.md:311 实测语义（引擎源码 server-operations.ts:748 钉死）：
      // 先过滤 seq>afterSeq，再 slice(-limit)；limit 缺省返回全量
      final events = <Map<String, dynamic>>[
        for (var i = 0; i < 150; i++)
          {
            'eventId': 'ev-c4-$i',
            'seq': i + 1,
            'sessionId': 'sess-c4',
            'type': 'text_delta',
            'payload': {'delta': '字$i'},
          },
      ];
      fake.handlers['session/events'] = (params) {
        final after = (params?['afterSeq'] as num?)?.toInt() ?? 0;
        final limit = params?['limit'] as int?;
        var rows = events.where((e) => (e['seq'] as int) > after).toList();
        if (limit != null && rows.length > limit) {
          rows = rows.sublist(rows.length - limit); // slice(-limit)
        }
        return {'events': rows};
      };

      await store.debugPollOnce();

      // 修复点：推进式拉取必须把窗口滑出的头部事件补齐，无中段丢失
      final text = store.messages
          .where((m) => m.role == MessageRole.assistant)
          .map((m) => m.text)
          .join();
      expect(
        text,
        [for (var i = 0; i < 150; i++) '字$i'].join(),
        reason: '裸 limit:100 的 slice(-limit) 窗口把最早 50 条滑出并静默丢失',
      );
      // 轮询必须带 afterSeq 推进游标（否则与推送并存时全量重放）；
      // 窗口溢出时必须发出无 limit 的全量收口请求补头部
      final pollRequests = fake.requests
          .where((r) => r.key == 'session/events')
          .map((r) => r.value ?? const <String, dynamic>{})
          .toList();
      expect(
        pollRequests.every((r) => r.containsKey('afterSeq')),
        isTrue,
        reason: '轮询请求必须带 afterSeq（裸 limit 的全窗重放会丢中段）',
      );
      expect(
        pollRequests.any((r) => !r.containsKey('limit')),
        isTrue,
        reason: '满页后必须以同游标无 limit 收口，否则头部事件永不可达',
      );
    });
  });

  group('f-reconnect-replay-degrade-4 断线补放游标收口', () {
    test('缺口大于一页：补放循环拉平后 turn.started 被应用（用户气泡存在）',
        () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      addTearDown(store.dispose);
      await store.openSession('sess-gap');

      // 断线窗口内落盘批次 >100 条：seq 1 是 turn.started（携带用户输入），
      // seq 2..150 为 text_delta。fake 按 slice(-limit) 实测语义返回
      final events = <Map<String, dynamic>>[
        {
          'eventId': 'ev-gap-0',
          'seq': 1,
          'sessionId': 'sess-gap',
          'type': 'turn.started',
          'payload': {'messageId': 'srv-gap-u', 'input': '缺口首条'},
        },
        for (var i = 1; i < 150; i++)
          {
            'eventId': 'ev-gap-$i',
            'seq': i + 1,
            'sessionId': 'sess-gap',
            'type': 'text_delta',
            'payload': {'delta': '段$i '},
          },
      ];
      fake.handlers['session/events'] = (params) {
        final after = (params?['afterSeq'] as num?)?.toInt() ?? 0;
        final limit = params?['limit'] as int?;
        var rows = events.where((e) => (e['seq'] as int) > after).toList();
        if (limit != null && rows.length > limit) {
          rows = rows.sublist(rows.length - limit); // slice(-limit)
        }
        return {'events': rows};
      };

      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      for (var i = 0; i < 30; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      // 修复点：补放满页后同游标无 limit 收口，头部 turn.started 必须被
      // 应用（用户气泡存在）——单次 slice(-100) 会把 seq 1..50 永久丢失
      expect(
        store.messages.map((m) => m.text).where((t) => t.contains('缺口首条')),
        isNotEmpty,
        reason: 'turn.started 丢失 = 用户消息气泡缺失 + 完成通知降级',
      );
      // 拉平后不再重复请求同区间：本轮补放请求 = 探测 + 收口恰两次
      final replayRequests = fake.requests
          .where((r) => r.key == 'session/events')
          .map((r) => r.value ?? const <String, dynamic>{})
          .toList();
      expect(replayRequests, hasLength(2),
          reason: '推进式收口：探测页 + 无 limit 全量，无需多轮循环',);
      expect(
        replayRequests.every((r) => r['afterSeq'] == 0),
        isTrue,
        reason: '收口必须锚定补放起点游标（应用事件已推进水位）',
      );
    });
  });
}
