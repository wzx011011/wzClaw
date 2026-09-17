import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/widgets/turn_block.dart';

ChatMessage _assistantWithTools(
  List<ToolCallInfo> calls, {
  String content = '',
}) =>
    ChatMessage(
      role: MessageRole.assistant,
      content: content,
      createdAt: DateTime(2026, 9, 18),
      toolCalls: calls,
    );

ToolCallInfo _call(
  String name, {
  ToolCallStatus status = ToolCallStatus.done,
  String? input,
  String? output,
  String id = '',
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
    );

void main() {
  test('直连栈形态：assistant.toolCalls 生成工具行（R3 后唯一来源）', () {
    final vm = buildTurnVM(
      [
        _assistantWithTools([
          _call(
            'Bash',
            input: '{"command":"npm test"}',
            output: 'ok',
            id: 'c1',
          ),
        ]),
        ChatMessage(
          role: MessageRole.assistant,
          content: '测试通过。',
          createdAt: DateTime(2026, 9, 18),
        ),
      ],
      busy: false,
    );

    expect(vm.parts, hasLength(1));
    final row = vm.parts.first.tool!;
    expect(row.verb, '执行');
    expect(row.target, 'npm test'); // Bash 提取命令本体而非路径末段
    expect(row.details, isNotEmpty); // 二级展开详情已接通
    expect(vm.answerMarkdown, '测试通过。');
    expect(vm.countsLabel, contains('执行 1'));
  });

  test('读取类聚合：连续 Read 合并计数且展开逐文件', () {
    final vm = buildTurnVM(
      [
        _assistantWithTools([
          _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'r1'),
          _call('Read', input: '{"file_path":"/a/two.dart"}', id: 'r2'),
          _call('Read', input: '{"file_path":"/a/three.dart"}', id: 'r3'),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts, hasLength(1));
    final row = vm.parts.first.tool!;
    expect(row.verb, '读取');
    expect(row.count, 3);
    expect(row.target, '· 3 文件'); // off-by-one 回归钉：首次聚合即为 3
    expect(row.details, hasLength(3)); // 逐文件展开
    expect(row.details.map((d) => d.text), contains('· three.dart'));
  });

  test('叙述打断聚合：两段 Read 被文本隔开后不再合并', () {
    final vm = buildTurnVM(
      [
        _assistantWithTools([
          _call('Read', input: '{"file_path":"/a/one.dart"}', id: 'r1'),
        ]),
        ChatMessage(
          role: MessageRole.assistant,
          content: '中间说明',
          createdAt: DateTime(2026, 9, 18),
        ),
        _assistantWithTools([
          _call('Read', input: '{"file_path":"/a/two.dart"}', id: 'r2'),
        ]),
        ChatMessage(
          role: MessageRole.assistant,
          content: '最终答复',
          createdAt: DateTime(2026, 9, 18),
        ),
      ],
      busy: false,
    );

    // 工具行 ×2 + 中间叙述 ×1；正文只有最终答复（不重复进叙述）
    expect(vm.parts.where((p) => p.kind == TurnPartKind.tool), hasLength(2));
    expect(
      vm.parts.where((p) => p.kind == TurnPartKind.narration),
      hasLength(1),
    );
    expect(vm.answerMarkdown, '最终答复');
  });

  test('Edit 行数增减：old/new 去公共前后缀后计算 +N -M', () {
    const input = '{"file_path":"/a/x.dart","old_string":"a\\nb\\nc",'
        '"new_string":"a\\nX\\nY\\nc"}';
    final vm = buildTurnVM(
      [
        _assistantWithTools([_call('Edit', input: input, id: 'e1')]),
      ],
      busy: false,
    );

    final row = vm.parts.first.tool!;
    expect(row.verb, contains('编辑'));
    expect(row.add, 2); // X、Y 新增
    expect(row.del, 1); // b 删除
  });

  test('重试恢复：同 callID 先 error 后 done → 单行「已重试恢复」非假状态', () {
    final vm = buildTurnVM(
      [
        _assistantWithTools([
          _call(
            'Bash',
            status: ToolCallStatus.error,
            input: '{"command":"x"}',
            id: 'c9',
          ),
          _call('Bash', input: '{"command":"x"}', output: 'ok', id: 'c9'),
        ]),
      ],
      busy: false,
    );

    expect(vm.parts, hasLength(1));
    final row = vm.parts.first.tool!;
    expect(row.failed, isFalse);
    expect(row.recovered, isTrue);
  });

  test('纯失败无重试：只显示执行失败，不显示恢复标', () {
    final vm = buildTurnVM(
      [
        _assistantWithTools([
          _call(
            'Bash',
            status: ToolCallStatus.error,
            input: '{"command":"x"}',
            id: 'c8',
          ),
        ]),
      ],
      busy: false,
    );

    final row = vm.parts.first.tool!;
    expect(row.failed, isTrue);
    expect(row.recovered, isFalse);
  });
}
