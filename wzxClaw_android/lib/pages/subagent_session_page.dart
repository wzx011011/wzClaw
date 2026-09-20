import 'dart:async';

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/connection_manager.dart';
import '../widgets/turn_block.dart';

/// 子智能体会话面板（官方远控页「点 Explore 行进子会话」对齐，v1）：
/// 数据源 = session/subagents 按父回合 toolCallId 关联（probe-subagents-map
/// 钉死的形状）。
/// - 运行中：定时拉取子会话 session/messages 渲染时间线（思考/正文/工具行）
/// - 已结束：标题/状态/耗时/结果摘要卡；转录经 session/messages 实测
///   -32004（Session is not active）——引擎将已结束子会话归档，不硬猜。
class SubagentSessionPage extends StatefulWidget {
  const SubagentSessionPage({
    super.key,
    required this.parentSessionId,
    required this.toolCallId,
    required this.agentType,
    required this.fallbackTitle,
  });

  final String parentSessionId;
  final String toolCallId;
  final String agentType;
  final String fallbackTitle;

  /// 测试注入口（绕开 ConnectionManager 真连接）
  @visibleForTesting
  static Future<dynamic> Function(String method, [Map<String, dynamic>? p])?
      debugRequester;

  @override
  State<SubagentSessionPage> createState() => _SubagentSessionPageState();
}

class _SubagentSessionPageState extends State<SubagentSessionPage> {
  Future<dynamic> _request(String method, [Map<String, dynamic>? params]) {
    final requester = SubagentSessionPage.debugRequester;
    if (requester != null) return requester(method, params);
    return ConnectionManager.instance.zcodeRequest(method, params);
  }

  Map<String, dynamic>? _detail;
  bool _loading = true;
  String? _error;
  List<_SubTimelineRow> _timeline = const [];
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  bool get _isRunning => _detail?['phase'] == 'running';

  Future<void> _load() async {
    final detail = await _fetchDetail();
    if (!mounted) return;
    setState(() {
      _detail = detail;
      _loading = false;
      _error = detail == null ? '未在 session/subagents 中找到该子任务' : null;
    });
    if (_isRunning) {
      await _loadTimeline();
      _pollTimer ??= Timer.periodic(const Duration(seconds: 3), (_) {
        if (mounted) _loadTimeline();
      });
    }
  }

  Future<Map<String, dynamic>?> _fetchDetail() async {
    try {
      final result = await _request('session/subagents', {
        'sessionId': widget.parentSessionId,
      });
      if (result is! Map) return null;
      for (final entry in {
        'running': result['running'],
        'ended': (result['ended'] is Map) ? (result['ended'] as Map)['items'] : null,
      }.entries) {
        final items = entry.value;
        if (items is! List) continue;
        for (final item in items) {
          if (item is Map && item['toolCallId'] == widget.toolCallId) {
            return {...item.cast<String, dynamic>(), 'phase': entry.key};
          }
        }
      }
      return null;
    } catch (e) {
      _error = '加载失败：$e';
      return null;
    }
  }

  Future<void> _loadTimeline() async {
    final childSid = _detail?['childSessionId']?.toString();
    if (childSid == null || childSid.isEmpty) return;
    try {
      final msgs = await _request('session/messages', {
        'sessionId': childSid,
        'limit': 200,
      });
      if (!mounted) return;
      if (msgs is! Map || msgs['result'] is! Map) return; // -32004 等：静默保留旧时间线
      final rows = <_SubTimelineRow>[];
      for (final m in (msgs['result']['messages'] as List?) ?? []) {
        if (m is! Map) continue;
        final role = m['info'] is Map ? (m['info'] as Map)['role']?.toString() : null;
        for (final p in (m['parts'] as List?) ?? []) {
          if (p is! Map) continue;
          final type = p['type']?.toString();
          if (type == 'text' && (p['text'] as String?)?.trim().isNotEmpty == true) {
            rows.add(_SubTimelineRow(kind: role == 'user' ? 'user' : 'text', text: p['text'].toString()));
          } else if (type == 'reasoning') {
            rows.add(_SubTimelineRow(kind: 'thinking', text: (p['text'] ?? '').toString()));
          } else if (type == 'tool') {
            final state = p['state'] is Map ? p['state'] as Map : const {};
            rows.add(_SubTimelineRow(kind: 'tool', text: (p['tool'] ?? '').toString(), detail: _toolBrief(state)));
          }
        }
      }
      setState(() => _timeline = rows);
    } catch (_) {
      // 轮询失败静默保留旧时间线（下一拍重试）
    }
  }

  String _toolBrief(Map state) {
    final input = state['input'];
    if (input is Map) {
      for (final key in ['command', 'file_path', 'pattern', 'query', 'url']) {
        final v = input[key];
        if (v is String && v.trim().isNotEmpty) return v.trim();
      }
    }
    return (state['title'] ?? '').toString();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final title = (_detail?['title'] ?? _detail?['summary'])?.toString();
    final startedAt = _detail?['startedAt'];
    final duration = startedAt is int
        ? Duration(milliseconds: DateTime.now().millisecondsSinceEpoch - startedAt)
        : null;
    String durationText = '';
    if (duration != null) {
      final m = duration.inMinutes;
      final s = duration.inSeconds % 60;
      durationText = m >= 1 ? '$m 分 $s 秒' : '$s 秒';
    }
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.agentType,
              style: TextStyle(color: colors.textPrimary, fontSize: 15),
            ),
            if (durationText.isNotEmpty)
              Text(
                _isRunning ? '工作中 $durationText' : '已工作 $durationText',
                style: TextStyle(color: colors.textMuted, fontSize: 11),
              ),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _detail == null
              ? Center(
                  child: Text(
                    _error ?? '未找到子任务详情',
                    style: TextStyle(color: colors.textMuted, fontSize: 13),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (title != null && title.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(
                          title,
                          style: TextStyle(
                            color: colors.textPrimary,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    if (_isRunning)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 8),
                        child: AnimatedGradientText(
                          '正在工作',
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    if (_detail?['phase'] == 'ended') ...[
                      _statusCard(context),
                      const SizedBox(height: 8),
                      _summaryCard(context),
                    ],
                    for (final row in _timeline) _timelineRow(context, row),
                  ],
                ),
    );
  }

  Widget _statusCard(BuildContext context) {
    final colors = AppColors.of(context);
    final status = _detail?['status']?.toString() ?? '';
    final ok = status == 'success';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            ok ? Icons.check_circle_outline : Icons.error_outline,
            size: 15,
            color: ok ? colors.success : colors.error,
          ),
          const SizedBox(width: 6),
          Text(
            ok ? '已完成' : '状态：$status',
            style: TextStyle(color: colors.textSecondary, fontSize: 12.5),
          ),
        ],
      ),
    );
  }

  Widget _summaryCard(BuildContext context) {
    final colors = AppColors.of(context);
    final summary = _detail?['summary']?.toString() ?? '';
    if (summary.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: SelectableText(
        summary,
        style: TextStyle(color: colors.textPrimary, fontSize: 12.5, height: 1.5),
      ),
    );
  }

  Widget _timelineRow(BuildContext context, _SubTimelineRow row) {
    final colors = AppColors.of(context);
    final label = switch (row.kind) {
      'thinking' => '思考',
      'tool' => '工具',
      'user' => '派发',
      _ => null,
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (label != null)
            Text(
              label,
              style: TextStyle(color: colors.textMuted, fontSize: 11),
            ),
          Text(
            row.text,
            style: TextStyle(
              color: row.kind == 'user' ? colors.textSecondary : colors.textPrimary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
          if (row.detail != null)
            Text(
              row.detail!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: colors.textMuted, fontSize: 11.5),
            ),
        ],
      ),
    );
  }
}

class _SubTimelineRow {
  const _SubTimelineRow({required this.kind, required this.text, this.detail});
  final String kind;
  final String text;
  final String? detail;
}
