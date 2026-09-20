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
    expect(row.verb, '终端'); // 官方对齐：shell 家族标签终端（非「执行」）
    expect(row.target, 'npm test'); // Bash 提取命令本体
    expect(row.details.any((line) => line.text.contains('ok')), isTrue);
    expect(vm.answerMarkdown, '测试通过。');
    expect(vm.countsLabel, contains('终端 1'));
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
    expect(row.target, '· 2 文件'); // 半角间隔点 + 桶计数
    // 组行不直接挂详情；二级是成员行，成员各自带目标与输入/输出
    expect(row.details, isEmpty);
    expect(row.memberRows, hasLength(2));
    expect(row.memberRows![0].verb, '读取'); // 成员行挂种类标签
    expect(row.memberRows![0].target, 'one.dart');
    expect(
      row.memberRows![1].details.any((d) => d.text.contains('20 行')),
      isTrue,
    );
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
    expect(row.target, '· 2 搜索, 1 列表'); // 官方半角逗号
    expect(row.memberRows, hasLength(3));
    // 官方对齐：shell 成员完成态一律挂家族标签「终端」（桶只体现在组计数）
    expect(row.memberRows![0].verb, '终端');
    expect(row.memberRows![1].verb, '终端');
    expect(row.memberRows![2].verb, '终端');
  });

  test('非白名单 shell 单发落单行，挂「终端」标签', () {
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
    expect(row.verb, '终端'); // 不再叫「执行」
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

    expect((vm.parts[0].tool!).verb, '读取'); // 单发挂种类标签
    expect((vm.parts[1].tool!).verb, '终端'); // 白名单 shell 单发=终端
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

  group('展开只由点击驱动（官方对齐）', () {
    // 完成且有输出的工具行：结果到达绝不自动弹开
    Future<TurnVM> pumpCompletedTool(WidgetTester tester) async {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"npm test"}',
                output: '全部通过',
                id: 'c1',
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
      return vm;
    }

    testWidgets('完成且有输出的行默认收起，点击展开，再点收起', (tester) async {
      await pumpCompletedTool(tester);

      // 默认收起：详情输出不可见
      expect(find.textContaining('全部通过'), findsNothing);

      // 点击行 → 展开
      await tester.tap(find.text('终端'));
      await tester.pumpAndSettle();
      expect(find.textContaining('全部通过'), findsOneWidget);

      // 再点 → 收起
      await tester.tap(find.text('终端'));
      await tester.pumpAndSettle();
      expect(find.textContaining('全部通过'), findsNothing);
    });

    testWidgets('查阅组默认收起；点开组后成员行仍收起，再点成员才看详情',
        (tester) async {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"grep -n a lib/x.dart"}',
                output: 'x.dart:3',
                id: 'g1',
              ),
            ),
            ChatProcessPart.tool(
              _call(
                'Read',
                input: '{"file_path":"/a/one.dart"}',
                output: '10 行',
                id: 'g2',
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

      // 组默认收起：成员目标与详情都不可见
      expect(find.text('one.dart'), findsNothing);
      expect(find.textContaining('10 行'), findsNothing);

      // 点开组 → 成员行出现，但成员详情仍收起
      await tester.tap(find.text('查阅'));
      await tester.pumpAndSettle();
      expect(find.text('one.dart'), findsOneWidget);
      expect(find.textContaining('10 行'), findsNothing);

      // 点成员行 → 才看到该成员详情
      await tester.tap(find.text('one.dart'));
      await tester.pumpAndSettle();
      expect(find.textContaining('10 行'), findsOneWidget);
    });
  });

  group('分类体系（官方分类表逐格断言）', () {
    test('单条只读 bash（grep）→ 终端标签，不成组', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"grep -n foo lib/a.dart"}',
                output: 'a.dart:3',
                id: 'g1',
              ),
            ),
          ]),
        ],
        busy: false,
      );

      final row = vm.parts.single.tool!;
      expect(row.verb, '终端');
      expect(row.memberRows, isNull);
      expect(vm.countsLabel, contains('终端 1'));
    });

    test('连续非白名单 shell ≥2 → 终端组「N 个命令」+ 成员行', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"npm test"}',
                output: 'ok',
                id: 't1',
              ),
            ),
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"flutter analyze"}',
                output: '0 issues',
                id: 't2',
              ),
            ),
          ]),
        ],
        busy: false,
      );

      final row = vm.parts.single.tool!;
      expect(row.verb, '终端');
      expect(row.target, '· 2 个命令');
      expect(row.memberRows, hasLength(2));
      expect(row.memberRows![0].verb, '终端');
      expect(row.memberRows![0].target, 'npm test');
      // 终端组单发/成组同标签：计数恒为 终端 1
      expect(vm.countsLabel, contains('终端 1'));
    });

    test('终端组被 text 断组 → 落单行（相邻性规则）', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('Bash', input: '{"command":"npm test"}', id: 't1'),
            ),
            const ChatProcessPart.text('中间说明'),
            ChatProcessPart.tool(
              _call('Bash', input: '{"command":"flutter analyze"}', id: 't2'),
            ),
          ]),
        ],
        busy: false,
      );

      final toolParts =
          vm.parts.where((p) => p.kind == TurnPartKind.tool).toList();
      expect(toolParts, hasLength(2));
      expect(toolParts[0].tool!.verb, '终端');
      expect(toolParts[0].tool!.memberRows, isNull);
      expect(toolParts[1].tool!.memberRows, isNull);
    });

    test('空参数 shell 相邻两条：两边都不进组 → 两条单行终端', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(_call('Bash', input: '', id: 'e1')),
            ChatProcessPart.tool(_call('Bash', id: 'e2')),
          ]),
        ],
        busy: false,
      );

      expect(vm.parts, hasLength(2));
      expect((vm.parts[0].tool!).verb, '终端');
      expect((vm.parts[0].tool!).target, '');
      expect((vm.parts[1].tool!).verb, '终端');
    });

    test('写入重定向 shell → 终端组资格（不进查阅）', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('Bash', input: '{"command":"echo a > out.txt"}', id: 'r1'),
            ),
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"echo b >> out.txt"}',
                id: 'r2',
              ),
            ),
          ]),
        ],
        busy: false,
      );

      final row = vm.parts.single.tool!;
      expect(row.verb, '终端');
      expect(row.target, '· 2 个命令');
    });

    test('混合 read + 白名单 bash ≥2 → 查阅组，shell 计入搜索桶', () {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"grep -n foo lib/a.dart"}',
                id: 'm1',
              ),
            ),
            ChatProcessPart.tool(
              _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'm2'),
            ),
          ]),
        ],
        busy: false,
      );

      final row = vm.parts.single.tool!;
      expect(row.verb, '查阅');
      expect(row.target, '· 1 搜索, 1 文件');
      expect(row.memberRows![0].verb, '终端');
      expect(row.memberRows![1].verb, '读取');
    });

    test('SendMessage 输入（to+message）→ 消息卡，标题=摘要', () {
      const input = '{"to":"agent_8d4a","summary":"边界已确认",'
          '"message":"请输出最终清单"}';
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('SendMessage', input: input, output: '已送达', id: 'sm1'),
            ),
          ]),
        ],
        busy: false,
      );

      expect(vm.parts.single.kind, TurnPartKind.message);
      final msg = vm.parts.single.message!;
      expect(msg.to, 'agent_8d4a');
      expect(msg.summary, '边界已确认');
      expect(msg.body, '请输出最终清单');
      expect(msg.running, isFalse);
      expect(vm.countsLabel, contains('消息 1'));
    });

    test('Glob：与 Read 相邻进查阅组文件桶；单发挂工具名', () {
      final grouped = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('Glob', input: '{"pattern":"lib/**.dart"}', id: 'gl1'),
            ),
            ChatProcessPart.tool(
              _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'gl2'),
            ),
          ]),
        ],
        busy: false,
      );
      expect(grouped.parts.single.tool!.verb, '查阅');
      expect(grouped.parts.single.tool!.target, '· 2 文件');

      final single = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call('Glob', input: '{"pattern":"lib/**.dart"}', id: 'gl3'),
            ),
          ]),
        ],
        busy: false,
      );
      expect(single.parts.single.tool!.verb, 'Glob');
    });
  });

  group('走马灯与零圈圈（官方状态呈现）', () {
    testWidgets('运行中工具行动词挂渐变；完成行无 ✓ 无转圈', (tester) async {
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'Bash',
                status: ToolCallStatus.running,
                input: '{"command":"npm test"}',
                id: 'run1',
              ),
            ),
            ChatProcessPart.tool(
              _call(
                'Bash',
                input: '{"command":"npm run build"}',
                output: 'built',
                id: 'done1',
              ),
            ),
          ]),
        ],
        busy: true,
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
      await tester.pump();

      // 运行中：组行动画在 target 位（· 正在执行 <命令>）
      expect(find.byType(AnimatedGradientText), findsOneWidget);
      expect(find.textContaining('正在执行'), findsOneWidget);
      // 行内零转圈
      expect(find.byType(CircularProgressIndicator), findsNothing);
      // 完成行无 ✓ 图标
      expect(find.byIcon(Icons.check), findsNothing);
    });

    testWidgets('被工具接续的思考段停表；回合头纯文字无图标', (tester) async {
      final vm = buildTurnVM(
        [
          _assistant(
            [
              const ChatProcessPart.reasoning('正在核对协议字段'),
              ChatProcessPart.tool(
                _call(
                  'Read',
                  status: ToolCallStatus.running,
                  input: '{"file_path":"/a.dart"}',
                  id: 'rr1',
                ),
              ),
            ],
            isStreaming: true,
          ),
        ],
        busy: true,
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
      await tester.pump();

      // 思考段被工具打断已停表 → 灰字「思考」；无转圈
      expect(find.text('思考'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      // 回合头纯文字（工作中…），无完成勾
      expect(find.textContaining('工作中'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_outline), findsNothing);
    });

    testWidgets('运行中思考段：正在思考渐变可见', (tester) async {
      final vm = buildTurnVM(
        [
          _assistant(
            [const ChatProcessPart.reasoning('想想')],
            isStreaming: true,
          ),
        ],
        busy: true,
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
      await tester.pump();

      expect(find.text('正在思考'), findsOneWidget);
      expect(find.byType(AnimatedGradientText), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('消息卡：运行中「正在发送消息」渐变，展开见 dl 三行',
        (tester) async {
      const input = '{"to":"agent_8d4a","summary":"边界已确认",'
          '"message":"请输出最终清单"}';
      final vm = buildTurnVM(
        [
          _assistant([
            ChatProcessPart.tool(
              _call(
                'SendMessage',
                input: input,
                status: ToolCallStatus.running,
                id: 'sm-run',
              ),
            ),
          ]),
        ],
        busy: true,
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
      await tester.pump();

      expect(find.text('正在发送消息'), findsOneWidget);
      expect(find.text('边界已确认'), findsOneWidget);

      await tester.tap(find.text('正在发送消息'));
      // 渐变是无限动画，pumpAndSettle 永不静默——用显式拍帧
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // dl 行是 SelectableText.rich，需 findRichText 才能匹配 span
      expect(find.textContaining('目标子智能体', findRichText: true), findsOneWidget);
      // to/消息 同时出现在 dl 行与输入 JSON 详情里 → 至少一个即可
      expect(find.textContaining('agent_8d4a', findRichText: true), findsWidgets);
      expect(find.textContaining('请输出最终清单', findRichText: true), findsWidgets);
    });
  });
}
