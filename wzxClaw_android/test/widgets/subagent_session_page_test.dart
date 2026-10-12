// ============================================================
// subagent_session_page_test — 子代理页轮询失败收敛回归
// （f-render-stream-consumption-3-dup）
//
// 钉死的契约：轮询在持久性拉取失败时必须收敛——连续失败达阈值后停表
// 并标注「数据更新失败，显示 HH:MM 的旧数据」（与 GoalStore.staleLabel
// 单源措辞同源）；恢复期退避低频重试，绝不能每 3 秒空转打已断链路。
// ============================================================


import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/pages/subagent_session_page.dart';

void main() {
  tearDown(() {
    SubagentSessionPage.debugRequester = null;
  });

  testWidgets('轮询持续失败达阈值：停表退避 + 陈旧标注', (tester) async {
    final startedAt =
        DateTime.now().millisecondsSinceEpoch - 60 * 1000; // 已工作 1 分钟
    var calls = 0;
    SubagentSessionPage.debugRequester = (method, [params]) async {
      calls++;
      if (calls <= 1) {
        // 首拉成功：running 状态触发轮询
        return {
          'revision': 1,
          'running': [
            {
              'toolCallId': 'tc-stale',
              'subagentType': 'Explore',
              'title': '子任务',
              'startedAt': startedAt,
              'summary': '阶段结论',
            },
          ],
          'ended': {
            'total': 0,
            'items': [],
          },
        };
      }
      // 持续失败（relay/隧道中断，本仓库高频实测故障）
      throw Exception('链路中断');
    };

    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(extensions: const [AppColors.dark]),
        home: const SubagentSessionPage(
          parentSessionId: 'sess-sub',
          toolCallId: 'tc-stale',
          agentType: 'Explore',
          fallbackTitle: '子任务',
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      find.textContaining('正在工作'),
      findsWidgets,
      reason: '前置：首拉成功显示运行中',
    );

    // 推进 3 个轮询周期：连续失败达阈值 → 停表 + 陈旧标注
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 100));
    final callsAtThreshold = calls;
    expect(callsAtThreshold, greaterThanOrEqualTo(4),
        reason: '前置：阈值前每 3 秒一次轮询（1 首拉 + 3 轮询）',);

    // 停表：不再按 3 秒周期空转（退避重试间隔远大于 3 秒）
    await tester.pump(const Duration(seconds: 10));
    expect(
      calls,
      callsAtThreshold,
      reason: '持续失败后每 3 秒空转一次请求 = 轮询永不收敛（缺陷语义）',
    );

    // UI 陈旧标注：任务真实已结束与否无从得知时，必须明示数据陈旧
    expect(
      find.textContaining('旧数据'),
      findsWidgets,
      reason: '失败后保留旧 running 投影且无陈旧标注 = 「正在工作」假象',
    );
    expect(
      find.textContaining('正在工作'),
      findsNothing,
      reason: '停表后不得继续显示「正在工作」的假象',
    );
  });
}
