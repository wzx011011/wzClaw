// 调用轨迹页（阶段 3b，对齐官方侧栏「调用轨迹」标签）：
// session/debug 的 rounds 是**引擎进程内**的模型请求轨迹（每次模型请求一条：
// requestIndex/usage 五 token 字段/hitRate/generationDurationMs/tokensPerSecond，
// 0.16.9 实测钉死）。引擎重启后旧轨迹不可回放——空态如实说明，不做假数据。
import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../zcode/zcode_chat_store.dart';

class TracePage extends StatefulWidget {
  const TracePage({super.key});

  @override
  State<TracePage> createState() => _TracePageState();
}

class _TracePageState extends State<TracePage> {
  List<Map<String, dynamic>>? _rounds;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final sessionId = ZcodeChatStore.instance.activeSessionId;
    if (sessionId == null) {
      setState(() {
        _error = '未打开会话';
        _rounds = null;
      });
      return;
    }
    setState(() => _loading = true);
    try {
      final rounds =
          await ZcodeChatStore.instance.debugRounds(sessionId);
      if (!mounted) return;
      setState(() {
        _rounds = rounds;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '轨迹获取失败：$e';
        _rounds = null;
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        title: Text(
          '调用轨迹',
          style: TextStyle(color: colors.textPrimary, fontSize: 16),
        ),
        iconTheme: IconThemeData(color: colors.textPrimary),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: _buildBody(colors),
    );
  }

  Widget _buildBody(AppColors colors) {
    if (_loading && _rounds == null) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error!,
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.textSecondary, fontSize: 13),
          ),
        ),
      );
    }
    final rounds = _rounds ?? const [];
    if (rounds.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '当前引擎进程内没有该会话的调用轨迹。\n\n'
            '轨迹是引擎进程内快照（session/debug）：仅在当前进程执行的模型请求'
            '可见，引擎重启后历史轨迹不可回放。发送一条消息即可看到实时轨迹。',
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.textMuted, fontSize: 12.5, height: 1.6),
          ),
        ),
      );
    }
    // 官方轨迹面板口径：头部总 token/总调用数，每请求一条（序号/IN/OUT/耗时/命中率）
    final totalIn = rounds.fold<int>(
      0,
      (n, r) => n + ((r['usage'] as Map?)?['inputTokens'] as num? ?? 0).toInt(),
    );
    final totalOut = rounds.fold<int>(
      0,
      (n, r) => n + ((r['usage'] as Map?)?['outputTokens'] as num? ?? 0).toInt(),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          color: colors.bgSecondary,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Text(
                '${rounds.length} 次调用',
                style: TextStyle(
                  color: colors.textPrimary,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                'IN $totalIn · OUT $totalOut',
                style: TextStyle(color: colors.textSecondary, fontSize: 12),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: rounds.length,
            itemBuilder: (context, index) {
              final r = rounds[rounds.length - 1 - index]; // 最新在上
              return _RoundTile(
                round: r,
                index: ((r['requestIndex'] as num?)?.toInt() ?? index + 1),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _RoundTile extends StatelessWidget {
  const _RoundTile({required this.round, required this.index});

  final Map<String, dynamic> round;
  final int index;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final usage = round['usage'] as Map? ?? const {};
    final inTok = (usage['inputTokens'] as num?)?.toInt() ?? 0;
    final outTok = (usage['outputTokens'] as num?)?.toInt() ?? 0;
    final cached = (usage['cachedInputTokens'] as num?)?.toInt() ?? 0;
    final hitRate = round['hitRate'] as num?;
    final durationMs = (round['generationDurationMs'] as num?)?.toInt() ?? 0;
    final tps = round['tokensPerSecond'] as num?;
    final recordedAt = (round['recordedAt'] as num?)?.toInt();
    final timeText = recordedAt != null
        ? DateTime.fromMillisecondsSinceEpoch(recordedAt)
            .toIso8601String()
            .substring(11, 19)
        : '';

    return ExpansionTile(
      tilePadding: const EdgeInsets.symmetric(horizontal: 16),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      leading: Text(
        '$index'.padLeft(2, '0'),
        style: TextStyle(
          color: colors.textMuted,
          fontSize: 13,
          fontFamily: 'monospace',
        ),
      ),
      title: Text(
        'IN ${_fmt(inTok)} · OUT ${_fmt(outTok)}',
        style: TextStyle(color: colors.textPrimary, fontSize: 13),
      ),
      subtitle: Text(
        '$timeText · ${_fmtDuration(durationMs)}'
        '${tps != null ? ' · ${tps.toStringAsFixed(0)} tok/s' : ''}',
        style: TextStyle(color: colors.textSecondary, fontSize: 11.5),
      ),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Text(
            '缓存命中：${hitRate != null ? '${(hitRate * 100).toStringAsFixed(1)}%' : '—'}'
            '${cached > 0 ? '（缓存输入 ${_fmt(cached)} tok）' : ''}\n'
            '推理 token：${_fmt((usage['reasoningTokens'] as num?)?.toInt() ?? 0)}\n'
            'requestId：${round['requestId'] ?? '—'}',
            style: TextStyle(color: colors.textSecondary, fontSize: 11.5, height: 1.6),
          ),
        ),
      ],
    );
  }

  static String _fmt(int n) =>
      n >= 10000 ? '${(n / 10000).toStringAsFixed(1)}万' : '$n';

  static String _fmtDuration(int ms) {
    if (ms >= 60000) return '${(ms / 60000).toStringAsFixed(1)}分';
    if (ms >= 1000) return '${(ms / 1000).toStringAsFixed(1)}s';
    return '${ms}ms';
  }
}
