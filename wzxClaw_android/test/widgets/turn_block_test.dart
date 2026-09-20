import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/widgets/turn_block.dart';

ChatMessage _assistant(
  List<ChatProcessPart> parts, {
  String? agent,
  bool isStreaming = false,
}) =>
    ChatMessage(
      role: MessageRole.assistant,
      processParts: parts,
      createdAt: DateTime(2026, 9, 18),
      agent: agent,
      isStreaming: isStreaming,
    );

ToolCallInfo _call(
  String name, {
  ToolCallStatus status = ToolCallStatus.done,
  String? input,
  String? output,
  String id = '',
  String? subagentType,
}) =>
    ToolCallInfo(
      toolCallId: id,
      toolName: name,
      inputSummary: input,
      outputSummary: output,
      status: status,
      isError: status == ToolCallStatus.error,
      inputFull: input,
      outputFull: output,
      subagentType: subagentType,
    );

void main() {
  test('原序渲染：reasoning → text → tool → text，末段文本为正文', () {
    final vm = buildTurnVM(
      [
        _assistant([
          const ChatProcessPart.reasoning('先想想'),
          const ChatProcessPart.text('开始执行'),
          ChatProcessPart.tool(
            _call(
              'Bash',
              input: '{"command":"npm test"}',
              output: 'ok',
              id: 'c1',
            ),
          ),
          const ChatProcessPart.text('测试通过。'),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts.map((p) => p.kind), [
      TurnPartKind.thinking,
      TurnPartKind.text,
      TurnPartKind.tool,
    ]);
    expect(vm.parts[1].text, contains('开始执行'));

    final row = vm.parts[2].tool!;
    expect(row.verb, '执行');
    expect(row.target, 'npm test'); // Bash 提取命令本体
    expect(row.details.any((line) => line.text.contains('ok')), isTrue);
    expect(row.defaultOpen, isTrue); // 完成且有输出 → 默认展开
    expect(vm.answerMarkdown, '测试通过。');
    expect(vm.countsLabel, contains('执行 1'));
  });

  test('查阅聚合：相邻 Read 合并为查阅伞，成员行独立展开详情', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'r1'),
          ),
          ChatProcessPart.tool(
            _call(
              'Read',
              input: '{"file_path":"/a/two.dart"}',
              output: '20 行',
              id: 'r2',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts, hasLength(1));
    final row = vm.parts.first.tool!;
    expect(row.verb, '查阅');
    expect(row.count, 2);
    expect(row.target, '2 文件');
    // 组行不直接挂详情；二级是成员行，成员各自带目标与输入/输出
    expect(row.details, isEmpty);
    expect(row.memberRows, hasLength(2));
    expect(row.memberRows![0].verb, '文件');
    expect(row.memberRows![0].target, 'one.dart');
    expect(
      row.memberRows![1].details.any((d) => d.text.contains('20 行')),
      isTrue,
    );
    // 任一成员完成且有输出 → 组默认展开成员列表；成员自身默认收起
    expect(row.defaultOpen, isTrue);
    expect(row.memberRows![1].defaultOpen, isFalse);
    expect(vm.countsLabel, contains('查阅 1'));
  });

  test('Bash 语义分桶：只读命令按内容归类（2 搜索，1 列表）', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call(
              'Bash',
              input: '{"command":"wc -l APP-SERVER.md && ls relay"}',
              output: '824 行',
              id: 'b1',
            ),
          ),
          ChatProcessPart.tool(
            _call(
              'Bash',
              input: '{"command":"grep -n thinking lib/a.dart"}',
              output: '3 命中',
              id: 'b2',
            ),
          ),
          ChatProcessPart.tool(
            _call(
              'Bash',
              input: '{"command":"rg -n duration lib/b.dart"}',
              output: '5 命中',
              id: 'b3',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts, hasLength(1));
    final row = vm.parts.first.tool!;
    expect(row.verb, '查阅');
    expect(row.target, '2 搜索，1 列表');
    expect(row.memberRows, hasLength(3));
    expect(row.memberRows![0].verb, '列表');
    expect(row.memberRows![1].verb, '搜索');
    expect(row.memberRows![2].verb, '搜索');
  });

  test('写入/非白名单命令不进查阅：npm 单行保持执行', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call('Bash', input: '{"command":"npm test"}', id: 'n1'),
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.first.tool!;
    expect(row.verb, '执行');
    expect(row.memberRows, isNull);
  });

  test('正文/reasoning 打断聚合：不再合并后续同类工具', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'r1'),
          ),
          const ChatProcessPart.text('中间说明'),
          const ChatProcessPart.reasoning('再想想'),
          ChatProcessPart.tool(
            _call('Read', input: '{"file_path":"/a/two.dart"}', id: 'r2'),
          ),
          const ChatProcessPart.text('最终答复'),
        ]),
      ],
      busy: false,
    );

    final toolParts = vm.parts
        .where((p) => p.kind == TurnPartKind.tool)
        .toList(growable: false);
    expect(toolParts, hasLength(2));
    expect(vm.parts.any((p) => p.kind == TurnPartKind.text), isTrue);
    expect(vm.parts.any((p) => p.kind == TurnPartKind.thinking), isTrue);
    expect(vm.answerMarkdown, '最终答复');
  });

  test('marker 只打断聚合，不渲染为可见行', () {
    final vm = buildTurnVM(
      [
        _assistant([
          const ChatProcessPart.marker('step-start', id: 's1'),
          ChatProcessPart.tool(
            _call('Bash', input: '{"command":"a"}', id: 'b1'),
          ),
          const ChatProcessPart.marker('step-finish', id: 's2'),
          ChatProcessPart.tool(
            _call('Bash', input: '{"command":"b"}', id: 'b2'),
          ),
        ]),
      ],
      busy: false,
    );

    // marker 不产生部件，但打断执行聚合 → 两个独立工具行
    expect(vm.parts.map((p) => p.kind), everyElement(TurnPartKind.tool));
    expect(vm.parts, hasLength(2));
  });

  test('权限拒绝：error 状态标失败，无输出不默认展开', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call(
              'Bash',
              status: ToolCallStatus.error,
              input: '{"command":"x"}',
              output: 'Permission request failed',
              id: 'c8',
            ),
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.first.tool!;
    expect(row.failed, isTrue);
    expect(row.recovered, isFalse);
    expect(row.defaultOpen, isTrue); // 有错误原因输出 → 展开可读
  });

  test('Edit 行数增减：old/new 去公共前后缀后计算 +N -M', () {
    const input = '{"file_path":"/a/x.dart","old_string":"a\\nb\\nc",'
        '"new_string":"a\\nX\\nY\\nc"}';
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(_call('Edit', input: input, id: 'e1')),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.first.tool!;
    expect(row.verb, contains('编辑'));
    expect(row.add, 2);
    expect(row.del, 1);
  });

  test('工具别名：FileRead / FileWrite / ShellExecute 语义映射', () {
    final vm = buildTurnVM(
      [
        _assistant([
          ChatProcessPart.tool(
            _call('FileRead', input: '{"file_path":"/a/x.dart"}', id: 'f1'),
          ),
          // marker 打断：避免查阅家族相邻成组，验证单行动词映射
          const ChatProcessPart.marker('step-start', id: 'm1'),
          ChatProcessPart.tool(
            _call(
              'ShellExecute',
              input: '{"command":"ls"}',
              output: 'x',
              id: 'f2',
            ),
          ),
          const ChatProcessPart.marker('step-finish', id: 'm2'),
          ChatProcessPart.tool(
            _call('FileWrite', input: '{"file_path":"/a/y.dart"}', id: 'f3'),
          ),
        ]),
      ],
      busy: false,
    );

    expect((vm.parts[0].tool!).verb, '文件');
    expect((vm.parts[1].tool!).verb, '列表');
    expect((vm.parts[2].tool!).verb, '写入');
  });

  test('Agent 工具 → 内联子智能体行，subagent_type 生效', () {
    final vm = buildTurnVM(
      [
        _assistant([
          const ChatProcessPart.text('让我调查一下'),
          ChatProcessPart.tool(
            _call(
              'Agent',
              input: '{"description":"全面搜索","prompt":"查找用法"}',
              output: '结论',
              id: 'ag1',
              subagentType: 'Explore',
            ),
          ),
          const ChatProcessPart.text('调查完毕'),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts.map((p) => p.kind), [
      TurnPartKind.text,
      TurnPartKind.agent,
    ]);
    final agent = vm.parts[1].agent!;
    expect(agent.agentType, 'Explore');
    expect(agent.defaultOpen, isTrue);
    expect(vm.answerMarkdown, '调查完毕');
    expect(vm.countsLabel, contains('子智能体 1'));
  });

  test('info.agent 子智能体消息内联为 Agent 行，不旁路不丢失', () {
    final vm = buildTurnVM(
      [
        _assistant([const ChatProcessPart.text('我先派个探查者')]),
        _assistant(
          [
            const ChatProcessPart.text('子智能体结论'),
            ChatProcessPart.tool(
              _call('Read', input: '{"file_path":"/a.dart"}', id: 'sr1'),
            ),
          ],
          agent: 'Explore',
        ),
        _assistant([const ChatProcessPart.text('汇总完成')]),
      ],
      busy: false,
    );

    final kinds = vm.parts.map((p) => p.kind).toList();
    expect(kinds, contains(TurnPartKind.agent));
    final agent =
        vm.parts.firstWhere((p) => p.kind == TurnPartKind.agent).agent!;
    expect(agent.agentType, 'Explore');
    expect(agent.details.any((d) => d.text.contains('子智能体结论')), isTrue);
    expect(agent.details.any((d) => d.text.contains('a.dart')), isTrue);
    expect(vm.answerMarkdown, '汇总完成');
  });

  test('运行中：工具行 running；被工具接续的思考段已停表', () {
    final vm = buildTurnVM(
      [
        _assistant(
          [
            const ChatProcessPart.reasoning('思考中'),
            ChatProcessPart.tool(
              _call(
                'Bash',
                status: ToolCallStatus.running,
                input: '',
                id: 'r1',
              ),
            ),
          ],
          isStreaming: true,
        ),
      ],
      busy: true,
    );

    // 官方对齐：思考段后工具已在执行 → 思考段不再跟整轮转圈
    expect(vm.parts[0].think!.running, isFalse);
    expect(vm.parts[1].tool!.running, isTrue);
    expect(vm.busy, isTrue);
  });

  test('思考分段状态：整轮运行中，已闭合分段停表、只有尾部分段 running', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    final vm = buildTurnVM(
      [
        _assistant(
          [
            // 第一段：已被工具插入核销（closed = start + 4000）
            ChatProcessPart.reasoning(
              '先想想',
              startedAtMs: now - 10000,
              closedAtMs: now - 6000,
            ),
            ChatProcessPart.tool(
              _call('Read', input: '{"file_path":"/a.dart"}', id: 'r9'),
            ),
            // 第二段：仍在流式的尾部分段（无 closedAt）
            ChatProcessPart.reasoning('再想想', startedAtMs: now - 2000),
          ],
          isStreaming: true,
        ),
      ],
      busy: true,
    );

    expect(vm.parts[0].think!.running, isFalse, reason: '已闭合分段不跟整轮转圈');
    expect(vm.parts[0].think!.duration, const Duration(seconds: 4));
    expect(vm.parts[1].tool!.running, isFalse);
    expect(vm.parts[2].think!.running, isTrue, reason: '尾部分段才是正在思考');
    expect(vm.parts[2].think!.duration, isNotNull); // 随当前时间滚算
  });

  test('思考分段无本地时间（权威回填）→ duration null，不显示秒数', () {
    final vm = buildTurnVM(
      [
        _assistant([const ChatProcessPart.reasoning('历史思考')]),
      ],
      busy: false,
    );

    expect(vm.parts[0].think!.duration, isNull);
    expect(vm.parts[0].think!.running, isFalse);
  });

  group('回合指标（首字延迟 / tok/s）', () {
    test('formatTtft：<10s 一位小数，≥10s 整数秒', () {
      expect(formatTtft(999), '首字 1.0s');
      expect(formatTtft(1800), '首字 1.8s');
      expect(formatTtft(9500), '首字 9.5s');
      expect(formatTtft(21000), '首字 21s');
    });

    test('formatTps：估算带 ≈ 前缀，权威裸数值；≥100 取整', () {
      expect(formatTps(31.63, estimated: true), '≈31.6 tok/s');
      expect(formatTps(45.34, estimated: false), '45.3 tok/s');
      expect(formatTps(123.4, estimated: false), '123 tok/s');
    });

    test('buildTurnVM 透传指标字段；完成态缺省为权威口径', () {
      final busy = buildTurnVM(
        const [],
        busy: true,
        firstTokenMs: 1200,
        tokensPerSecond: 31.6,
        tpsIsEstimate: true,
        busyElapsed: const Duration(seconds: 12),
      );
      expect(busy.firstTokenMs, 1200);
      expect(busy.tokensPerSecond, 31.6);
      expect(busy.tpsIsEstimate, isTrue);
      expect(busy.busyElapsed!.inSeconds, 12);

      final done = buildTurnVM(
        const [],
        busy: false,
        firstTokenMs: 1200,
        tokensPerSecond: 45.3,
      );
      expect(done.tpsIsEstimate, isFalse);
      expect(done.busyElapsed, isNull);
    });
  });

  group('Write 行下载入口', () {
    test('完成态 Write 行携带 file_path 供下载', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Write',
                input: '{"file_path":"E:\\\\work\\\\out.md","content":"# hi"}',
                output: '写入 4 行',
                id: 'w1',
              ),
            ),
          ]),
        ],
        busy: false,
      );

      final row = vm.parts.first.tool!;
      expect(row.verb, '写入');
      expect(row.filePath, 'E:\\work\\out.md');
    });

    test('Read 行 / 运行中 / 失败态不携带 filePath', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'r1'),
            ),
            ChatProcessPart.tool(
              _call('Write', status: ToolCallStatus.running, id: 'w-run'),
            ),
            ChatProcessPart.tool(
              _call(
                'Write',
                status: ToolCallStatus.error,
                input: '{"file_path":"/a/bad.md"}',
                id: 'w-err',
              ),
            ),
          ]),
        ],
        busy: false,
      );

      expect(vm.parts.map((p) => p.tool!.filePath), [null, null, null]);
    });

    testWidgets('Write 完成行显示下载图标，点击回调携带完整路径', (tester) async {
      String? downloaded;
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Write',
                input: '{"file_path":"E:\\\\work\\\\out.md","content":"# hi"}',
                output: '写入 4 行',
                id: 'w1',
              ),
            ),
            ChatProcessPart.tool(
              _call('Bash', input: '{"command":"ls"}', output: 'ok', id: 'b1'),
            ),
          ]),
        ],
        busy: false,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: SingleChildScrollView(
              child: TurnBlockView(
                vm: vm,
                defaultCollapsed: false,
                onDownloadFile: (p) => downloaded = p,
              ),
            ),
          ),
        ),
      );

      expect(find.byIcon(Icons.download_outlined), findsOneWidget);
      await tester.tap(find.byIcon(Icons.download_outlined));
      expect(downloaded, 'E:\\work\\out.md');
    });

    testWidgets('onDownloadFile 未接线时不显示下载图标', (tester) async {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Write',
                input: '{"file_path":"E:\\\\work\\\\out.md"}',
                output: 'ok',
                id: 'w1',
              ),
            ),
          ]),
        ],
        busy: false,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(extensions: const [AppColors.dark]),
          home: Scaffold(
            body: SingleChildScrollView(
              child: TurnBlockView(vm: vm, defaultCollapsed: false),
            ),
          ),
        ),
      );

      expect(find.byIcon(Icons.download_outlined), findsNothing);
    });
  });
}
