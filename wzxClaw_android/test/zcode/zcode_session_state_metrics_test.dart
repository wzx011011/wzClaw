// ============================================================
// zcode_session_state_metrics_test — 回合指标（首字延迟 / tok/s）
//
// 受控时钟注入钉死口径语义（见 ZcodeSessionState「回合指标」注释）：
// - TTFT 只认第一个到达的增量（思考或正文，谁先到算谁，不被覆盖）；
// - 滑动窗口速率随停顿衰减归零（不留陈旧读数）；
// - 回合收尾滚存权威 tok/s（outputTokens ÷ 生成跨度）并按实际
//   字符/token 比自校准；无 token 数据显式置 null 不冒充旧值；
// - 思考缓冲截断不影响增量字符计数（校准口径按原文计）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

void main() {
  // 受控时钟：nowMs 由用例直接推进
  var nowMs = 0;
  DateTime clock() => DateTime.fromMillisecondsSinceEpoch(nowMs);
  late ZcodeSessionState state;

  setUp(() {
    nowMs = 0;
    ZcodeSessionState.charsPerTokenEstimate = 2.5; // static 校准复位
    state = ZcodeSessionState('sess-m', clock: clock);
  });

  group('首字延迟', () {
    test('正文首增量 = TTFT；后续增量不覆盖', () {
      state.ensureStreamingPlaceholder(); // t=0 起表
      nowMs = 1200;
      state.appendTextDelta('你');
      nowMs = 2000;
      state.appendTextDelta('好');
      expect(state.firstTokenLatencyMs, 1200);
    });

    test('思考先到：reasoning_delta 即首字（口径含思考）', () {
      state.ensureStreamingPlaceholder();
      nowMs = 800;
      state.appendThinkingDelta('嗯');
      expect(state.firstTokenLatencyMs, 800);
      nowMs = 3000;
      state.appendTextDelta('答');
      expect(state.firstTokenLatencyMs, 800); // 不被正文增量覆盖
    });

    test('无增量为 null', () {
      state.ensureStreamingPlaceholder();
      expect(state.firstTokenLatencyMs, isNull);
    });
  });

  group('滑动窗口速率', () {
    test('窗口内字符速率：锚点之后的增量 ÷ 跨度', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a' * 10);
      nowMs = 2000;
      state.appendTextDelta('b' * 20);
      nowMs = 2500;
      // 锚点 = t=1000 的采样（仍在 3s 窗口内）：其后 20 字符 / 1.5s
      expect(state.liveCharsPerSecond(), closeTo(20 * 1000 / 1500, 0.001));
    });

    test('停顿超过窗口：速率衰减为 0（非陈旧值）', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a' * 10);
      nowMs = 1000 + 3001; // 全部采样滑出窗口
      expect(state.liveCharsPerSecond(), 0);
    });

    test('无采样为 null', () {
      expect(state.liveCharsPerSecond(), isNull);
    });
  });

  group('回合收尾滚存', () {
    test('finalizeStreaming 带权威 usage：tok/s = outputTokens ÷ 生成跨度', () {
      state.ensureStreamingPlaceholder(); // t=0
      nowMs = 1000;
      state.appendTextDelta('a' * 249); // 首增量 t=1000
      nowMs = 11000;
      state.appendTextDelta('b'); // 末增量 t=11000，跨度 10s
      state.finalizeStreaming(
        usage: const TokenUsage(inputTokens: 10, outputTokens: 100),
      );
      expect(state.lastFirstTokenMs, 1000);
      expect(state.lastTurnTokensPerSecond, closeTo(100 / 10, 0.001));
    });

    test('自校准：样本足够时按实际字符/token 比 EMA 更新比率', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a' * 499);
      nowMs = 11000;
      state.appendTextDelta('b'); // 共 500 字符
      // 500 字符 / 100 token = 5.0 → EMA = 2.5×0.5 + 5.0×0.5 = 3.75
      state.finalizeStreaming(
        usage: const TokenUsage(inputTokens: 10, outputTokens: 100),
      );
      expect(ZcodeSessionState.charsPerTokenEstimate, closeTo(3.75, 0.001));
    });

    test('样本不足（token/字符任一低于门槛）不动比率', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a'); // 1 字符 < 门槛
      nowMs = 2000;
      state.finalizeStreaming(
        usage: const TokenUsage(inputTokens: 1, outputTokens: 1),
      );
      expect(ZcodeSessionState.charsPerTokenEstimate, 2.5);
    });

    test('无增量的回合收尾不动上一回合指标', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a' * 300);
      nowMs = 3000;
      state.finalizeStreaming(
        usage: const TokenUsage(inputTokens: 10, outputTokens: 100),
      );
      final ttft = state.lastFirstTokenMs;
      final tps = state.lastTurnTokensPerSecond;

      // 下一回合无任何增量即 reset（收尾兜底后新发送等场景）
      state.resetTurnState();
      expect(state.lastFirstTokenMs, ttft);
      expect(state.lastTurnTokensPerSecond, tps);
    });

    test('有增量但无 token 数据：tok/s 置 null 不冒充上一回合的值', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendTextDelta('a' * 300);
      nowMs = 2000;
      state.finalizeStreaming(); // 无 usage 且 lastOutputTokens = 0
      expect(state.lastTurnTokensPerSecond, isNull);
    });
  });

  group('思考长文本', () {
    test('canonical 过程行不截断；校准按全部增量字符计', () {
      state.ensureStreamingPlaceholder();
      nowMs = 1000;
      state.appendThinkingDelta('x' * 15000);
      nowMs = 1001;
      state.appendThinkingDelta('y' * 10000);
      // 思考是过程行，完整保留（无独立缓冲、无截断）
      expect(state.liveThinkingText.length, 25000);
      nowMs = 2000;
      // 计数 25000 字符 / 5000 token = 5.0 → EMA = 3.75；
      // 增量字符计数与 liveThinkingText 长度必须一致
      state.finalizeStreaming(
        usage: const TokenUsage(inputTokens: 1, outputTokens: 5000),
      );
      expect(ZcodeSessionState.charsPerTokenEstimate, closeTo(3.75, 0.001));
    });
  });

  group('运行中已耗时', () {
    test('streamElapsed 随时钟推进；无在途回合为 null', () {
      expect(state.streamElapsed, isNull);
      state.ensureStreamingPlaceholder();
      nowMs = 1500;
      expect(state.streamElapsed!.inMilliseconds, 1500);
    });
  });
}
