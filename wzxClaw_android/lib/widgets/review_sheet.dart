// 审查 sheet（阶段 3c，对齐官方侧栏「审查」标签）：
// 未暂存/已暂存 segmented 切换 → 文件列表（±行数）→ 点文件看 diff。
// 撤销更改 = x/git/restore，危险操作双确认（先 sheet 内确认弹层）。
// 数据源：GitService.changedFiles/fileDiff/restore（companion x/git 扩展）。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/app_colors.dart';
import '../services/git_service.dart';

class ReviewSheetData {
  const ReviewSheetData({required this.workspacePath});

  final String workspacePath;
}

/// 返回 true 表示发生了 restore（宿主需刷新 git 状态）
Future<bool> showReviewSheet(BuildContext context, String workspacePath) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _ReviewSheet(workspacePath: workspacePath),
  ).then((v) => v ?? false);
}

class _ReviewSheet extends StatefulWidget {
  const _ReviewSheet({required this.workspacePath});

  final String workspacePath;

  @override
  State<_ReviewSheet> createState() => _ReviewSheetState();
}

class _ReviewSheetState extends State<_ReviewSheet> {
  bool _staged = false;
  List<GitChangedFile>? _files;
  String? _error;
  GitFileDiff? _openDiff;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final files = await GitService.instance
          .changedFiles(widget.workspacePath, staged: _staged);
      if (!mounted) return;
      setState(() {
        _files = files;
        _openDiff = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _files = null;
      });
    }
  }

  Future<void> _openFileDiff(GitChangedFile file) async {
    try {
      final diff = await GitService.instance
          .fileDiff(widget.workspacePath, file.path, staged: _staged);
      if (!mounted) return;
      setState(() => _openDiff = diff);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('diff 获取失败：$e'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  Future<void> _restoreFile(GitChangedFile file) async {
    final colors = AppColors.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: colors.bgSecondary,
        title: Text(
          '撤销更改？',
          style: TextStyle(color: colors.textPrimary, fontSize: 16),
        ),
        content: Text(
          '将丢弃「${file.path}」的全部未提交修改（${_staged ? '含暂存区' : '工作区'}），'
          '此操作不可恢复。',
          style: TextStyle(
            color: colors.textSecondary,
            fontSize: 13,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text('取消', style: TextStyle(color: colors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('撤销', style: TextStyle(color: Color(0xFFEF4444))),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await GitService.instance
          .restore(widget.workspacePath, file.path, staged: _staged);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已撤销：${file.path}'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
      Navigator.pop(context, true); // 关 sheet 并通知宿主刷新
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('撤销失败：$e'),
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 12, 0),
              child: Row(
                children: [
                  Text(
                    '审查 · 更改',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  // staged/unstaged segmented（对齐官方审查面板筛选）
                  ToggleButtons(
                    isSelected: [!_staged, _staged],
                    borderRadius: BorderRadius.circular(8),
                    selectedColor: colors.textPrimary,
                    color: colors.textMuted,
                    fillColor: colors.bgTertiary,
                    borderColor: colors.border,
                    selectedBorderColor: colors.border,
                    constraints: const BoxConstraints(minHeight: 28, minWidth: 64),
                    textStyle: const TextStyle(fontSize: 12),
                    onPressed: (i) {
                      if ((i == 1) == _staged) return;
                      setState(() => _staged = i == 1);
                      _load();
                    },
                    children: const [Text('未暂存'), Text('已暂存')],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Flexible(
              child: _buildBody(colors),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(AppColors colors) {
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
        child: Text(
          '变更获取失败（非 git 仓库或离线）：$_error',
          style: TextStyle(color: colors.textMuted, fontSize: 12.5),
        ),
      );
    }
    final files = _files;
    if (files == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (files.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Center(
          child: Text(
            _staged ? '暂存区没有更改' : '工作区没有未暂存更改',
            style: TextStyle(color: colors.textMuted, fontSize: 12.5),
          ),
        ),
      );
    }
    // 展开某文件的 diff 视图
    final diff = _openDiff;
    if (diff != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 12, 4),
            child: Row(
              children: [
                InkWell(
                  onTap: () => setState(() => _openDiff = null),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(
                      Icons.arrow_back,
                      size: 16,
                      color: colors.textSecondary,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    diff.file,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: colors.textPrimary, fontSize: 12.5),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: '复制 diff',
                  icon: Icon(
                    Icons.copy_outlined,
                    size: 16,
                    color: colors.textSecondary,
                  ),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: _openDiff!.patch));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('diff 已复制'),
                        duration: Duration(seconds: 2),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              child: SelectableText(
                diff.truncated ? '${diff.patch}\n…（diff 已截断）' : diff.patch,
                style: TextStyle(
                  color: colors.textPrimary,
                  fontSize: 11.5,
                  fontFamily: 'monospace',
                  height: 1.5,
                ),
              ),
            ),
          ),
        ],
      );
    }
    // 文件列表
    return ListView.builder(
      shrinkWrap: true,
      itemCount: files.length,
      itemBuilder: (context, i) {
        final f = files[i];
        return ListTile(
          dense: true,
          leading: Icon(
            f.isBinary ? Icons.image_outlined : Icons.description_outlined,
            size: 18,
            color: colors.textSecondary,
          ),
          title: Text(
            f.path,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: colors.textPrimary, fontSize: 13),
          ),
          subtitle: f.isBinary
              ? Text('二进制', style: TextStyle(color: colors.textMuted, fontSize: 11))
              : null,
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!f.isBinary) ...[
                Text(
                  '+${f.added}',
                  style: const TextStyle(color: Color(0xFF10B981), fontSize: 11.5),
                ),
                const SizedBox(width: 6),
                Text(
                  '-${f.removed}',
                  style: const TextStyle(color: Color(0xFFEF4444), fontSize: 11.5),
                ),
                const SizedBox(width: 8),
              ],
              // 撤销（危险：双确认）
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: '撤销更改',
                icon: Icon(
                  Icons.undo_outlined,
                  size: 16,
                  color: colors.textSecondary,
                ),
                onPressed: () => _restoreFile(f),
              ),
            ],
          ),
          onTap: () => _openFileDiff(f),
        );
      },
    );
  }
}
