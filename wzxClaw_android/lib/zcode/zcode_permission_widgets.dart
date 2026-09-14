// ============================================================
// zcode_permission_widgets — ZCode 权限确认 / AskUser 正式组件
//
// 从 zcode_page.dart 的私有组件 _ZcodePermissionBar / _ZcodeAskUserBar
// 提升而来（计划 P0.2）：
// - ZcodePermissionBar：权限确认卡。带计时（入参含截止时间字段时
//   显示剩余秒数，否则显示已等待秒数，每秒刷新）与工具 method 名 +
//   入参紧凑摘要（默认 1-2 行，可展开完整 JSON）。
// - ZcodeAskUserBar：AskUser 反向请求问答卡（选项 + 补充回答）。
//
// 两个组件都通过回调参数化应答动作（原 widgets/permission_bar.dart
// 硬编码 ChatStore.instance，ZCode 模式不能复用），由页面转发到
// ZcodeChatStore.respondToPermission / respondToAskUser。
//
// 注意：调用方应传 key: ValueKey(request.toolCallId) 之类区分请求，
// 换请求重建组件即重置计时；组件内 didUpdateWidget 只是兜底。
// ============================================================

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import 'zcode_reverse_models.dart';

/// 入参里可能携带截止时间的字段名（绝对 epoch 时间戳语义）。
///
/// 刻意不扫描 timeout/ttl 等时长字段：PermissionRequest.input 是工具
/// 自身的执行入参（如 Bash 的 timeout 是命令执行超时），拿它算权限
/// 倒计时会编造出错误的「剩余/已超时」。
const List<String> _kDeadlineKeys = [
  'expiresAt',
  'expires_at',
  'expiry',
  'deadline',
  'expires',
];

/// 入参紧凑摘要的最大长度（约 1-2 行）
const int _kInputSummaryMaxChars = 120;

/// companion 对反向请求（权限/AskUser）的应答看护窗口：
/// 超过该时长未应答，桌面端会以 -32022 自动拒绝且不通知手机。
/// 能弹到 UI 的请求（permission / interaction / askUser）全部落在
/// companion 的权限类档位 permissionRequestTimeoutMs（默认 120s，
/// 见 relay/zcode/companion.js isPermissionLikeMethod）；
/// 非权限类反向请求在 store 层即被默认拒绝，不会显示本卡。
/// 到点后本卡禁用按钮并提示，避免「点了批准其实已被拒」的假象。
const Duration _kCompanionWatchdog = Duration(seconds: 120);

/// 宽松数值解析（int/num/数字字符串）
int? _toInt(dynamic v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v.trim());
  return null;
}

/// 从权限请求入参解析截止时间：
/// 只认绝对时间戳字段（expiresAt/deadline 等，按数量级区分毫秒/秒），
/// 且必须是未来时间——过去的值多半是工具入参里的业务时间，不当截止用。
/// 解析不到返回 null（UI 退化为显示已等待秒数）。
DateTime? parsePermissionDeadline(
  Map<String, dynamic> input,
  DateTime receivedAt,
) {
  for (final key in _kDeadlineKeys) {
    final v = _toInt(input[key]);
    if (v == null || v <= 0) continue;
    // epoch 毫秒 ~1.7e12、秒 ~1.7e9，按数量级区分单位
    final int ms;
    if (v >= 1000000000000) {
      ms = v;
    } else if (v >= 1000000000) {
      ms = v * 1000;
    } else {
      continue; // 数量级不合理，跳过
    }
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    if (dt.isAfter(receivedAt)) return dt;
  }
  return null;
}

/// 工具入参紧凑摘要：压成单行 JSON 后截断，供权限卡 1-2 行展示
String compactPermissionInputSummary(Map<String, dynamic> input) {
  if (input.isEmpty) return '';
  String encoded;
  try {
    encoded = jsonEncode(input); // jsonEncode 本身无空白，即为紧凑形态
  } catch (_) {
    encoded = input.toString();
  }
  return encoded.length > _kInputSummaryMaxChars
      ? '${encoded.substring(0, _kInputSummaryMaxChars)}…'
      : encoded;
}

/// 完整入参（缩进 JSON），展开时展示——审批决定往往依赖被截断的后半段
String fullPermissionInputJson(Map<String, dynamic> input) {
  if (input.isEmpty) return '';
  try {
    return const JsonEncoder.withIndent('  ').convert(input);
  } catch (_) {
    return input.toString();
  }
}

// ── 权限确认条（复刻 widgets/permission_bar.dart 的视觉布局） ────────

/// 权限确认卡：
/// - 计时：入参带截止时间 → 剩余秒数倒计时；否则 → 已等待秒数；
///   超过 companion 看护窗口 → 提示可能已被桌面端自动拒绝并禁用按钮
/// - 摘要：工具 method 名 + 入参紧凑 JSON（默认 1-2 行，可展开全文）
class ZcodePermissionBar extends StatefulWidget {
  const ZcodePermissionBar({
    super.key,
    required this.request,
    required this.onRespond,
  });

  final PermissionRequest request;

  /// approved=true 批准 / false 拒绝
  final void Function(bool approved) onRespond;

  @override
  State<ZcodePermissionBar> createState() => _ZcodePermissionBarState();
}

class _ZcodePermissionBarState extends State<ZcodePermissionBar> {
  Timer? _ticker;

  /// 请求到达时间（计时基准；比真实到达晚一帧以内，可忽略）
  late DateTime _receivedAt;

  /// 从入参解析出的截止时间；null 表示没有（退化为已等待秒数）
  DateTime? _deadline;

  /// 计时秒计数器：每秒 +1，只驱动计时文本局部重建（不整卡 setState）
  final ValueNotifier<int> _clock = ValueNotifier<int>(0);

  /// 紧凑摘要 / 完整 JSON 只算一次，避免每秒重建重复 jsonEncode
  late final String _compactSummary;
  late final String _fullJson;

  /// 是否展开完整入参
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _receivedAt = DateTime.now();
    _deadline = parsePermissionDeadline(widget.request.input, _receivedAt);
    _compactSummary = compactPermissionInputSummary(widget.request.input);
    _fullJson = fullPermissionInputJson(widget.request.input);
    _startTicker();
  }

  @override
  void didUpdateWidget(covariant ZcodePermissionBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 请求换了对象（调用方未加 key 的兜底）：重置计时基准并重新走表
    // （旧请求可能已因看护到期停表，不重启的话新计时不会刷新）
    if (oldWidget.request.toolCallId != widget.request.toolCallId) {
      _receivedAt = DateTime.now();
      _deadline = parsePermissionDeadline(widget.request.input, _receivedAt);
      _startTicker();
    }
  }

  @override
  void dispose() {
    _ticker?.cancel(); // Timer 清理，避免泄漏与回调打到已卸载组件
    _clock.dispose();
    super.dispose();
  }

  /// 每秒驱动一次：看护窗口内只累加计数器（局部刷新计时文本）；
  /// 到达看护窗口后停表并整卡重建一次（禁用按钮 + 显示超时提示）。
  void _startTicker() {
    _ticker?.cancel();
    _clock.value = 0;
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final watchdogPassed =
          DateTime.now().difference(_receivedAt) >= _kCompanionWatchdog;
      if (watchdogPassed) {
        _ticker?.cancel();
        setState(() {}); // 一次性整卡重建：按钮禁用 + 超时提示
        return;
      }
      _clock.value++;
    });
  }

  /// 是否已过 companion 看护窗口（此时应答必然无效）
  bool get _watchdogExpired =>
      DateTime.now().difference(_receivedAt) >= _kCompanionWatchdog;

  /// 计时文案：看护到期 → 应答超时；有截止 → 剩余/已超时；否则 → 已等待
  String _timeLabel() {
    final now = DateTime.now();
    if (now.difference(_receivedAt) >= _kCompanionWatchdog) return '应答超时';
    final deadline = _deadline;
    if (deadline == null) {
      return '已等待 ${now.difference(_receivedAt).inSeconds}s';
    }
    final remain = deadline.difference(now).inSeconds;
    return remain > 0 ? '剩余 ${remain}s' : '已超时';
  }

  /// 计时颜色：看护到期/已超时用错误色，临期用警示色，普通用次级色
  Color _timeColor(AppColors colors) {
    final now = DateTime.now();
    if (now.difference(_receivedAt) >= _kCompanionWatchdog) {
      return colors.error;
    }
    final deadline = _deadline;
    if (deadline == null) return colors.textMuted;
    final remain = deadline.difference(now).inSeconds;
    if (remain <= 0) return colors.error;
    if (remain <= 10) return colors.warning;
    return colors.textSecondary;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final expired = _watchdogExpired;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.bgPrimary,
        border: Border.all(color: colors.toolRunning),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.security, size: 16, color: colors.toolRunning),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Permission Request',
                  style: TextStyle(
                    color: colors.toolRunning,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              // 倒计时 / 已等待计时（ValueNotifier 局部刷新，每秒一次）
              ValueListenableBuilder<int>(
                valueListenable: _clock,
                builder: (context, _, __) => Text(
                  _timeLabel(),
                  style: TextStyle(
                    color: _timeColor(colors),
                    fontSize: 11,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${widget.request.toolName} wants to execute:',
            style: TextStyle(color: colors.textSecondary, fontSize: 12),
          ),
          // 工具入参摘要：默认紧凑 1-2 行，点击展开完整 JSON
          // （审批常依赖被截断的后半段，不能只给前 120 字符）
          if (_compactSummary.isNotEmpty) ...[
            const SizedBox(height: 6),
            GestureDetector(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: colors.bgSecondary,
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _expanded ? _fullJson : _compactSummary,
                      maxLines: _expanded ? null : 2,
                      overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _expanded ? '收起' : '展开全部入参',
                      style: TextStyle(color: colors.accent, fontSize: 10),
                    ),
                  ],
                ),
              ),
            ),
          ],
          // 看护到期提示：桌面端可能已自动拒绝，应答不再有效
          if (expired) ...[
            const SizedBox(height: 6),
            Text(
              '已超过桌面端应答窗口（约 ${_kCompanionWatchdog.inSeconds}s），'
              '本次请求可能已被自动拒绝',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.error, fontSize: 11, height: 1.4),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                // 看护到期后应答无效：禁用，避免「点了拒绝/批准其实没生效」
                onPressed: expired ? null : () => widget.onRespond(false),
                style: TextButton.styleFrom(
                  foregroundColor: colors.error,
                  disabledForegroundColor: colors.textMuted,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(
                      color: expired ? colors.border : colors.error,
                    ),
                  ),
                ),
                child: const Text('Deny', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: expired ? null : () => widget.onRespond(true),
                style: TextButton.styleFrom(
                  foregroundColor: colors.success,
                  disabledForegroundColor: colors.textMuted,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(
                      color: expired ? colors.border : colors.success,
                    ),
                  ),
                ),
                child: const Text('Approve', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ── 问答条（复刻 widgets/ask_user_bar.dart 的视觉布局） ──────────────

/// AskUser 问答卡：选项（单选/多选）+ 补充回答
class ZcodeAskUserBar extends StatefulWidget {
  const ZcodeAskUserBar({
    super.key,
    required this.question,
    required this.onRespond,
  });

  final AskUserQuestion question;

  /// 提交答案：answers 为选项 label 列表；customText 为「补充回答」文本
  final void Function(List<String> answers, {String? customText}) onRespond;

  @override
  State<ZcodeAskUserBar> createState() => _ZcodeAskUserBarState();
}

class _ZcodeAskUserBarState extends State<ZcodeAskUserBar> {
  final Set<String> _selected = {};
  bool _showOther = false;
  final _otherController = TextEditingController();

  @override
  void dispose() {
    _otherController.dispose();
    super.dispose();
  }

  void _submitSelection() {
    widget.onRespond(_selected.toList());
  }

  void _submitOther() {
    final text = _otherController.text.trim();
    if (text.isEmpty) return;
    widget.onRespond([], customText: text);
  }

  void _onSingleSelect(String label) {
    widget.onRespond([label]);
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final q = widget.question;
    final hasOptions = q.options.isNotEmpty;

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
              Expanded(
                child: Text(
                  '需要你的确认',
                  style: TextStyle(
                    color: colors.accent,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (q.multiSelect)
                Text(
                  '可多选',
                  style: TextStyle(color: colors.textMuted, fontSize: 12),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            q.question,
            style: TextStyle(color: colors.textPrimary, fontSize: 13, height: 1.4),
          ),
          if (hasOptions) ...[
            const SizedBox(height: 10),
            ...q.options.map((opt) {
              final label = opt['label'] ?? '';
              final description = opt['description'] ?? '';
              final isSelected = _selected.contains(label);
              if (q.multiSelect) {
                return _buildMultiSelectOption(colors, label, description, isSelected);
              } else {
                return _buildSingleSelectOption(colors, label, description);
              }
            }),
          ],
          const SizedBox(height: 8),
          if (!_showOther)
            GestureDetector(
              onTap: () => setState(() => _showOther = true),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: colors.bgSecondary,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: colors.border),
                ),
                child: Row(
                  children: [
                    Icon(Icons.edit, size: 14, color: colors.textMuted),
                    const SizedBox(width: 8),
                    Text(
                      '补充回答...',
                      style: TextStyle(color: colors.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ),
          if (_showOther) ...[
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _otherController,
                    autofocus: true,
                    style: TextStyle(color: colors.textPrimary, fontSize: 13),
                    decoration: InputDecoration(
                      hintText: '输入补充回答...',
                      hintStyle: TextStyle(color: colors.textMuted),
                      filled: true,
                      fillColor: colors.bgInput,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(6),
                        borderSide: BorderSide.none,
                      ),
                      contentPadding:
                          const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    ),
                    onSubmitted: (_) => _submitOther(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: _submitOther,
                  icon: Icon(Icons.send, color: colors.accent, size: 20),
                  tooltip: '提交回答',
                ),
                IconButton(
                  onPressed: () => setState(() => _showOther = false),
                  icon: Icon(Icons.close, color: colors.textMuted, size: 20),
                  tooltip: '取消',
                ),
              ],
            ),
          ],
          if (q.multiSelect && _selected.isNotEmpty && !_showOther) ...[
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: _submitSelection,
                style: TextButton.styleFrom(
                  foregroundColor: Colors.white,
                  backgroundColor: colors.accent,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                child: Text(
                  '提交 (${_selected.length})',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildSingleSelectOption(AppColors colors, String label, String description) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: GestureDetector(
        onTap: () => _onSingleSelect(label),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: colors.bgSecondary,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: colors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  color: colors.accent,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
              if (description.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  description,
                  style: TextStyle(color: colors.textSecondary, fontSize: 12),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMultiSelectOption(
      AppColors colors, String label, String description, bool isSelected,) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: GestureDetector(
        onTap: () {
          setState(() {
            if (isSelected) {
              _selected.remove(label);
            } else {
              _selected.add(label);
            }
          });
        },
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: isSelected ? colors.accent.withValues(alpha: 0.15) : colors.bgSecondary,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: isSelected ? colors.accent : colors.border),
          ),
          child: Row(
            children: [
              Icon(
                isSelected ? Icons.check_box : Icons.check_box_outline_blank,
                size: 18,
                color: isSelected ? colors.accent : colors.textMuted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        color: isSelected ? colors.accent : colors.textPrimary,
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    if (description.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        description,
                        style: TextStyle(color: colors.textSecondary, fontSize: 12),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
