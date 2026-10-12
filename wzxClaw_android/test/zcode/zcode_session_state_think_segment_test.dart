// ============================================================
// zcode_session_state_think_segment_test — 思考分段起止时间戳
//
// 分段语义（官方对齐「思考 · 持续了 N 秒」/「正在思考」）：
// - 新思考分段创建时盖起点戳（受控时钟）；
// - 追加异类 part（正文/工具）即核销尾部思考段的闭合戳；
// - 回合终结核销剩余尾部分段；
// - 权威回填/历史分段无本地时间 → 起止均为 null（UI 只显示「思考」）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

void main() {
  var nowMs = 0;
  DateTime clock() => DateTime.fromMillisecondsSinceEpoch(nowMs);
  late ZcodeSessionState state;

  setUp(() {
    nowMs = 1000;
    state = ZcodeSessionState('sess-think', clock: clock);
  });

  ChatProcessPart? tailPart() {
    final items = state.items;
    if (items.isEmpty) return null;
    final parts = items.last.message.processParts;
    return parts.isEmpty ? null : parts.last;
  }

  test('新思考分段盖起点戳；连续增量不重开分段', () {
    state.appendThinkingDelta('先');
    final first = tailPart();
    expect(first?.kind, ChatProcessPartKind.reasoning);
    expect(first?.startedAtMs, 1000);
    nowMs = 1500;
    state.appendThinkingDelta('想想');
    // 合并进同一分段：起点不变，无闭合
    expect(tailPart()?.startedAtMs, 1000);
    expect(tailPart()?.closedAtMs, isNull);
    expect(tailPart()?.text, '先想想');
  });

  test('工具插入核销前一段：闭合戳 = 插入时刻', () {
    state.appendThinkingDelta('想');
    nowMs = 5000;
    state.upsertStreamingTool(
      const ToolCallInfo(
        toolCallId: 't1',
        toolName: 'Read',
        inputFull: '{"file_path":"/a.dart"}',
      ),
    );
    final parts = state.items.last.message.processParts;
    expect(parts[0].closedAtMs, 5000, reason: '思考段在工具插入时闭合');
    expect(parts[1].kind, ChatProcessPartKind.tool);
  });

  test('正文插入同样核销；回合终结核销尾部分段', () {
    state.appendThinkingDelta('想');
    nowMs = 4000;
    state.appendThinkingDelta('更多');
    nowMs = 6000;
    state.appendTextDelta('结论'); // 正文插入 → 第一段闭合
    state.appendThinkingDelta('又想'); // 新分段（尾部）
    nowMs = 9000;
    state.finalizeStreaming();
    final parts = state.items.last.message.processParts;
    expect(parts[0].closedAtMs, 6000);
    expect(parts[2].closedAtMs, 9000, reason: '回合终结核销尾部分段');
  });

  test('分段起止随 process_parts_json 序列化往返（SQLite 缓存链路）', () {
    state.appendThinkingDelta('想');
    nowMs = 8000;
    state.appendTextDelta('答');
    final part = state.items.last.message.processParts[0];
    final round = ChatProcessPart.fromJson(part.toJson());
    expect(round.startedAtMs, 1000);
    expect(round.closedAtMs, 8000);
  });
}
