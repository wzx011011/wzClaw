// ============================================================
// turn_block_workflow_test — 工作流行渲染契约
//
// 家族标签（工作流/保存工作流/…）、目标=工作流名、展开细节=
// 阶段流水线（probe-workflow 实测数据源 ToolCallInfo.workflowDisplay）、
// 编译诊断可见、计数入账。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/turn_block.dart';
import 'package:wzxclaw_android/zcode/zcode_workflow_display.dart';

ChatMessage _assistant(List<ChatProcessPart> parts) => ChatMessage(
      role: MessageRole.assistant,
      processParts: parts,
      createdAt: DateTime(2026, 10, 11),
    );

ZcodeWorkflowDisplay _display({
  bool ok = true,
  int errorCount = 0,
  List<ZcodeWorkflowDiagnostic> diagnostics = const [],
}) =>
    ZcodeWorkflowDisplay(
      ok: ok,
      errorCount: errorCount,
      diagnostics: diagnostics,
      causalityGraph: const ZcodeCausalityGraph(
        steps: [
          ZcodeWorkflowStep(
            id: 'ask#1',
            kind: 'ask',
            label: 'smoke-worker',
            lane: 'actor#1',
            phase: 'phase#1',
          ),
        ],
        lanes: [ZcodeWorkflowLane(id: 'actor#1', name: 'smoke-worker')],
        participants: [
          ZcodeWorkflowParticipant(
            id: 'phase#1:actor#1',
            phase: 'phase#1',
            lane: 'actor#1',
            steps: ['ask#1'],
            memberIndex: null,
            memberOf: null,
            many: false,
          ),
        ],
        phases: [ZcodeWorkflowPhase(id: 'phase#1', name: 'smoke')],
        truncated: false,
      ),
      truncated: false,
    );

void main() {
  test('工作流行：种类标签「工作流」，目标=工作流名，计数入账', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            ToolCallInfo(
              toolCallId: 'call_wf1',
              toolName: 'CreateWorkflow',
              status: ToolCallStatus.done,
              workflowDisplay: _display(),
              workflowName: '冒烟测试工作流',
              inputFull: '{"name":"冒烟测试工作流","script":"phase(\\"smoke\\");"}',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.single.tool!;
    expect(row.verb, '工作流'); // 完成态标签（运行态=正在启动工作流）
    expect(row.target, '冒烟测试工作流'); // 结构化名优先于输入摘要
    expect(vm.countsLabel, contains('工作流 1'));
  });

  test('展开细节：阶段流水线一行（阶段名：车道 · N 步）', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            ToolCallInfo(
              toolCallId: 'call_wf1',
              toolName: 'CreateWorkflow',
              status: ToolCallStatus.done,
              workflowDisplay: _display(),
              workflowName: '冒烟测试工作流',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.single.tool!;
    final pipeline = row.details
        .map((d) => d.text)
        .where((t) => t.contains('smoke'))
        .toList();
    expect(pipeline, isNotEmpty);
    expect(pipeline.first, contains('smoke：'));
    expect(pipeline.first, contains('smoke-worker'));
    expect(pipeline.first, contains('1 步'));
  });

  test('编译失败：诊断行红标（del kind）+ ok=false 兜底文案', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            ToolCallInfo(
              toolCallId: 'call_wf2',
              toolName: 'CreateWorkflow',
              status: ToolCallStatus.error,
              isError: true,
              workflowDisplay: _display(
                ok: false,
                errorCount: 1,
                diagnostics: [
                  const ZcodeWorkflowDiagnostic(
                    line: 3,
                    column: 4,
                    code: 42,
                    message: 'agent() 不能在 .map 里用字面量名',
                  ),
                ],
              ),
              workflowName: '坏脚本',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.single.tool!;
    final diag = row.details
        .where((d) => d.kind == DetailLineKind.del)
        .map((d) => d.text)
        .toList();
    expect(diag, hasLength(1));
    expect(diag.single, contains('L3C4'));
    expect(diag.single, contains('#42'));
    expect(diag.single, contains('agent() 不能在 .map 里用字面量名'));
  });

  test('无结构化显示（引擎未给/未落地）：回退纯名字行，不产生空壳细节', () {
    final vm = buildTurnVM(
      [
        _assistant([
          const ChatProcessPart.tool(
            ToolCallInfo(
              toolCallId: 'call_wf3',
              toolName: 'CreateWorkflow',
              status: ToolCallStatus.running,
              workflowName: '运行中的工作流',
            ),
          ),
        ]),
      ],
      busy: true,
    );

    final row = vm.parts.single.tool!;
    expect(row.verb, '正在启动工作流');
    expect(row.target, '运行中的工作流');
    expect(row.running, isTrue);
    // 无 display → 无工作流细节行；脚本输入照常在展开区
    expect(row.details.any((d) => d.text.startsWith('编译诊断')), isFalse);
    expect(row.details.any((d) => d.text.startsWith('未分阶段')), isFalse);
  });

  test('workflow 家族标签词典：辅助工具各有专名', () {
    const cases = {
      'SaveWorkflow': '保存工作流',
      'AmendWorkflow': '调整工作流',
      'ListWorkflowRuns': '运行历史',
      'ResolveWorkflowQuestion': '回答问题',
      'EvalWorkflowSnippet': '测试片段',
      'ListSavedWorkflows': '工作流库',
      'GetWorkflowRun': '运行详情',
      'ResumeWorkflowRun': '恢复运行',
    };
    for (final entry in cases.entries) {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              ToolCallInfo(
                toolCallId: 'c',
                toolName: entry.key,
                status: ToolCallStatus.done,
              ),
            ),
          ]),
        ],
        busy: false,
      );
      expect(
        vm.parts.single.tool!.verb,
        entry.value,
        reason: '${entry.key} 标签',
      );
    }
  });

  testWidgets('折叠态点头部展开：工作流行与详情阶段流水线重新可见（E2E 场景 C 同路径）',
      (tester) async {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            ToolCallInfo(
              toolCallId: 'call_wf1',
              toolName: 'CreateWorkflow',
              status: ToolCallStatus.done,
              workflowDisplay: _display(),
              workflowName: '冒烟整理工作流',
              inputFull: '{"name":"冒烟整理工作流","script":"phase(\\"smoke\\");"}',
            ),
          ),
          const ChatProcessPart.text('答案收好了，整理完成。'),
        ]),
      ],
      busy: false,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(extensions: const [AppColors.dark]),
        home: Scaffold(
          body: SingleChildScrollView(
            // 完成态自动折叠由宿主推导传入（E2E 同款：busy=false + finish=stop）
            child: TurnBlockView(vm: vm, defaultCollapsed: true),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));

    // 完成态自动折叠：计数可见、行目标不可见
    expect(find.textContaining('工作流 1'), findsWidgets);
    expect(find.textContaining('冒烟整理工作流'), findsNothing);

    // 点折叠头（E2E 同一 finder）→ 块展开 → 行可见
    await tester.tap(find.textContaining('工作流 1').first);
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.textContaining('冒烟整理工作流'),
      findsOneWidget,
      reason: '点折叠头后工作流行应重新可见',
    );

    // 点行 → 详情区阶段流水线可见
    await tester.tap(find.textContaining('冒烟整理工作流').first);
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.textContaining('smoke：smoke-worker'),
      findsOneWidget,
      reason: '工作流详情阶段流水线应可见',
    );
  });
}
