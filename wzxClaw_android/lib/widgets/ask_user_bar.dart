import 'package:flutter/material.dart';
import '../config/app_colors.dart';
import '../zcode/zcode_reverse_models.dart';
import '../zcode/zcode_chat_store.dart';

/// AskUser 条：官方 interaction/requestUserInput 的手机端 UI。
///
/// - 支持一次多题（官方 questions[]），按序展示、一次提交；
/// - 单选点选即记录，多选勾选；选项提交 value（显示 label）；
/// - 每题带可选自由文本（无选项的题 = 纯自由文本题）；
/// - 答案按官方归一化组装：{题目原文: 答案}，多选 ", " 连接；
/// - 提交 = {action:"accept", content:{answers}}；关闭 = cancel。
class AskUserBar extends StatefulWidget {
  final AskUserQuestion question;
  const AskUserBar({super.key, required this.question});

  @override
  State<AskUserBar> createState() => _AskUserBarState();
}

class _AskUserBarState extends State<AskUserBar> {
  /// 每题的选中 value 集合（多选）或单值（单选）
  final Map<int, Set<String>> _selected = {};

  /// 每题的自由文本（有输入时优先于选项）
  final Map<int, TextEditingController> _freeText = {};

  @override
  void didUpdateWidget(covariant AskUserBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 换题即清态（2026-09-19 评审 P2 同源）：上一请求的已选/自由文本
    // 绝不带入下一请求
    if (oldWidget.question.requestId != widget.question.requestId) {
      _resetFor(widget.question);
    }
  }

  @override
  void dispose() {
    for (final c in _freeText.values) {
      c.dispose();
    }
    super.dispose();
  }

  // 换题即清态（与旧实现一致）：上一请求的作答绝不带入下一请求
  void _resetFor(AskUserQuestion next) {
    for (final c in _freeText.values) {
      c.dispose();
    }
    _freeText.clear();
    _selected.clear();
  }

  /// 登记自由文本 controller 并监听：打字必须触发重建，否则 build 里按
  /// 「是否有作答」计算的提交按钮可用性永不刷新（自由文本题 = 官方
  /// prompt 模式的唯一作答通道，二轮评审 P1 回归锚）
  TextEditingController _controllerFor(int qi) {
    return _freeText.putIfAbsent(qi, () {
      final c = TextEditingController();
      c.addListener(() {
        if (mounted) setState(() {});
      });
      return c;
    });
  }

  void _toggle(int qi, AskUserQuestionItem q, String value) {
    setState(() {
      final set = _selected.putIfAbsent(qi, () => <String>{});
      if (q.multiSelect) {
        set.contains(value) ? set.remove(value) : set.add(value);
      } else {
        set
          ..clear()
          ..add(value);
      }
    });
  }

  /// 组装单题答案：自由文本优先，其次选中 value（多选 ", " 连接——官方
  /// interaction-broker 归一化语义）。均无 → null（该题无作答）。
  String? _answerFor(int qi, AskUserQuestionItem q) {
    final free = _freeText[qi]?.text.trim();
    if (free != null && free.isNotEmpty) return free;
    final set = _selected[qi];
    if (set == null || set.isEmpty) return null;
    return set.join(', ');
  }

  void _submit() {
    final answers = <String, String>{};
    for (var i = 0; i < widget.question.questions.length; i++) {
      final q = widget.question.questions[i];
      final answer = _answerFor(i, q);
      if (answer != null) answers[q.question] = answer;
    }
    ZcodeChatStore.instance
        .respondToAskUser(widget.question.requestId, answers: answers);
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final q = widget.question;
    // 来源标注（2026-09-19 评审 P1）：请求不属于当前视口会话时，用户必须
    // 先看到它来自哪个会话再作答
    final sourceLabel = ZcodeChatStore.instance.reverseSourceLabel(q.sessionId);
    final multiQuestion = q.questions.length > 1;
    // 全部题目均无作答时禁用提交：空 accept 会被引擎当「已回答」消费掉
    // （多题场景某题漏答尤其无声）——多确认优于假成功（评审 P2-7）
    final hasAnyAnswer = q.questions.asMap().entries.any(
          (e) => _answerFor(e.key, e.value) != null,
        );
    // 自由文本 controller 先行登记（带监听触发重建——打字必须能刷新
    // 「是否有作答」进而解锁提交按钮；自由文本题是官方 prompt 模式的
    // 唯一作答通道，二轮评审 P1）
    for (var i = 0; i < q.questions.length; i++) {
      _controllerFor(i);
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.accent),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.help_outline, size: 16, color: colors.accent),
              const SizedBox(width: 6),
              Text(
                multiQuestion ? '需要你的回答（${q.questions.length} 题）' : '需要你的确认',
                style: TextStyle(
                  color: colors.accent,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          if (sourceLabel != null) ...[
            const SizedBox(height: 4),
            Text(
              sourceLabel,
              style: TextStyle(color: colors.textMuted, fontSize: 12),
            ),
          ],
          const SizedBox(height: 8),
          for (var i = 0; i < q.questions.length; i++) ...[
            _QuestionEditor(
              key: ValueKey('q$i'),
              index: i,
              item: q.questions[i],
              selected: _selected,
              freeText: _freeText,
              onToggle: _toggle,
            ),
            if (i < q.questions.length - 1) const SizedBox(height: 10),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => ZcodeChatStore.instance.respondToAskUser(
                  q.requestId,
                  answers: const {},
                  cancel: true,
                ),
                style: TextButton.styleFrom(
                  foregroundColor: colors.textMuted,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: colors.textMuted),
                  ),
                ),
                child: const Text('取消', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: hasAnyAnswer ? _submit : null,
                style: TextButton.styleFrom(
                  foregroundColor: Colors.white,
                  backgroundColor:
                      hasAnyAnswer ? colors.accent : colors.textMuted,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                child: const Text('提交', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 单题编辑区：题干 + 选项（单选/多选）+ 可选自由文本。
/// 无选项的题渲染为纯文本输入（官方 prompt 模式）。
class _QuestionEditor extends StatelessWidget {
  final int index;
  final AskUserQuestionItem item;
  final Map<int, Set<String>> selected;
  final Map<int, TextEditingController> freeText;
  final void Function(int, AskUserQuestionItem, String) onToggle;

  const _QuestionEditor({
    super.key,
    required this.index,
    required this.item,
    required this.selected,
    required this.freeText,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final set = selected[index];
    final hasOptions = item.options.isNotEmpty;
    // controller 由父级 _controllerFor 登记并挂监听（build 循环先行执行）
    final controller = freeText[index]!;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (item.header.isNotEmpty)
            Text(
              item.header,
              style: TextStyle(
                color: colors.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          if (item.header.isNotEmpty && item.question != item.header)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                item.question,
                style: TextStyle(color: colors.textSecondary, fontSize: 12),
              ),
            ),
          if (!hasOptions) ...[
            const SizedBox(height: 8),
            TextField(
              controller: controller,
              minLines: 1,
              maxLines: 3,
              style: TextStyle(color: colors.textPrimary, fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                hintText: '输入回答…',
                hintStyle: TextStyle(color: colors.textMuted),
                filled: true,
                fillColor: colors.bgInput,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ] else ...[
            const SizedBox(height: 8),
            for (final option in item.options)
              _OptionRow(
                option: option,
                multiSelect: item.multiSelect,
                selected: set?.contains(option.value) ?? false,
                onToggle: () => onToggle(index, item, option.value),
              ),
          ],
        ],
      ),
    );
  }
}

class _OptionRow extends StatelessWidget {
  final AskUserOption option;
  final bool multiSelect;
  final bool selected;
  final VoidCallback onToggle;

  const _OptionRow({
    required this.option,
    required this.multiSelect,
    required this.selected,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: onToggle,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 2),
        child: Row(
          children: [
            Icon(
              multiSelect
                  ? (selected ? Icons.check_box : Icons.check_box_outline_blank)
                  : (selected
                      ? Icons.radio_button_checked
                      : Icons.radio_button_off),
              size: 18,
              color: selected ? colors.accent : colors.textMuted,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.label,
                    style: TextStyle(
                      color: selected ? colors.accent : colors.textPrimary,
                      fontSize: 13,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                  if (option.description != null &&
                      option.description!.isNotEmpty)
                    Text(
                      option.description!,
                      style: TextStyle(color: colors.textMuted, fontSize: 11),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
