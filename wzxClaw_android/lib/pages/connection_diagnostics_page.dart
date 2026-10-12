import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/app_colors.dart';
import '../zcode/connection_diagnostics.dart';

/// 连接诊断页：连接事件列表（新→旧）+ 路径体检 + 一键复制上报。
/// 「静默丢弃 = 缺陷」的连接层配套——无需 adb 即可现场取证据。
class ConnectionDiagnosticsPage extends StatefulWidget {
  const ConnectionDiagnosticsPage({super.key});

  @override
  State<ConnectionDiagnosticsPage> createState() =>
      _ConnectionDiagnosticsPageState();
}

class _ConnectionDiagnosticsPageState extends State<ConnectionDiagnosticsPage> {
  bool _checking = false;
  List<PathCheckResult> _checkResults = const [];

  Future<void> _runPathCheck() async {
    final host = ConnectionDiagnostics.instance.targetHost;
    if (host == null || host.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('还没有连接目标：先在首页触发一次连接'),
          duration: Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    setState(() => _checking = true);
    try {
      final results = await ConnectionDiagnostics.instance.runPathChecks(host);
      if (!mounted) return;
      setState(() => _checkResults = results);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  void _copyReport() {
    final text = ConnectionDiagnostics.instance.export();
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('诊断报告已复制，可粘贴发给维护者'),
        duration: Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final events = ConnectionDiagnostics.instance.events;
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: colors.bgPrimary,
        foregroundColor: colors.textPrimary,
        title: const Text('连接诊断', style: TextStyle(fontSize: 17)),
        actions: [
          IconButton(
            tooltip: '复制诊断报告',
            onPressed: events.isEmpty ? null : _copyReport,
            icon: const Icon(Icons.copy_outlined, size: 20),
          ),
          IconButton(
            tooltip: '清空事件',
            onPressed: events.isEmpty
                ? null
                : () => setState(ConnectionDiagnostics.instance.clear),
            icon: const Icon(Icons.delete_outline, size: 20),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: [
          // -- 路径体检 --
          Row(
            children: [
              Text(
                '网络路径体检',
                style: TextStyle(color: colors.textSecondary, fontSize: 14),
              ),
              const Spacer(),
              FilledButton.tonal(
                onPressed: _checking ? null : _runPathCheck,
                style: FilledButton.styleFrom(
                  backgroundColor: colors.bgSecondary,
                  foregroundColor: colors.accent,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: _checking
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('开始体检', style: TextStyle(fontSize: 13)),
              ),
            ],
          ),
          if (_checkResults.isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              decoration: BoxDecoration(
                color: colors.bgSecondary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  for (final r in _checkResults)
                    ListTile(
                      dense: true,
                      leading: Icon(
                        r.ok ? Icons.check_circle : Icons.cancel,
                        size: 18,
                        color: r.ok ? colors.success : colors.error,
                      ),
                      title: Text(
                        r.label,
                        style:
                            TextStyle(color: colors.textPrimary, fontSize: 13),
                      ),
                      subtitle: Text(
                        r.detail,
                        style:
                            TextStyle(color: colors.textMuted, fontSize: 11.5),
                      ),
                    ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 20),
          // -- 事件列表 --
          Text(
            '最近连接事件（新→旧，${events.length} 条）',
            style: TextStyle(color: colors.textSecondary, fontSize: 14),
          ),
          const SizedBox(height: 8),
          if (events.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Text(
                '暂无事件。回到首页让 App 尝试连接后，这里会出现每次尝试与失败原因。',
                style: TextStyle(color: colors.textMuted, fontSize: 13),
              ),
            )
          else
            Container(
              decoration: BoxDecoration(
                color: colors.bgSecondary,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  for (final e in events)
                    Container(
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                      decoration: BoxDecoration(
                        border: Border(
                          bottom: BorderSide(
                            color: colors.border.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              _EventTag(tag: e.tag),
                              const Spacer(),
                              Text(
                                _formatTime(e.time),
                                style: TextStyle(
                                  color: colors.textMuted,
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 3),
                          Text(
                            e.detail,
                            style: TextStyle(
                              color: colors.textPrimary,
                              fontSize: 12.5,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _formatTime(DateTime t) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }
}

class _EventTag extends StatelessWidget {
  const _EventTag({required this.tag});

  final String tag;

  Color _color(AppColors colors) {
    switch (tag) {
      case '配对':
        return colors.success;
      case 'relay拒绝':
      case '建连失败':
        return colors.error;
      case '断开':
        return colors.accent;
      default:
        return colors.textMuted;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        border: Border.all(color: _color(colors)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        tag,
        style: TextStyle(color: _color(colors), fontSize: 10.5),
      ),
    );
  }
}
