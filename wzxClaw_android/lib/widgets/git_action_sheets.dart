// ============================================================
// git_action_sheets — 状态面板「提交或推送」一步式 bottom sheet
//
// 官方实况对齐（2026-09-19 浏览器实测 v3.12.3 移动视口）：
// 点「提交或推送」直接弹出底部 sheet，内联全部内容——
// 顶部分支选择行 + 千分位 +N -M；提交信息输入；「包含未暂存的更改」
// 勾选行 + 变更文件计数；动作列表 提交 / 提交并推送 / 推送（禁用态）。
// 官方的 ✨ AI 生成提交消息需要模型直连端点，暂缺（placeholder 同步
// 为「提交信息」，不留死按钮）。所有失败显性展示，成功后回调刷新。
// ============================================================

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/git_service.dart';

/// 千分位：10760 → 10,760（官方 +10,760 -3,809 同款）
String formatThousands(int n) {
  final neg = n < 0;
  final digits = n.abs().toString();
  final buf = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    buf.write(digits[i]);
    final remain = digits.length - 1 - i;
    if (remain > 0 && remain % 3 == 0) buf.write(',');
  }
  return neg ? '-${buf.toString()}' : buf.toString();
}

/// 「提交或推送」一步式弹层
Future<void> showGitActionSheet(
  BuildContext context, {
  required String workspacePath,
  required VoidCallback onDone,
}) {
  final colors = AppColors.of(context);
  return showModalBottomSheet(
    context: context,
    backgroundColor: colors.bgSecondary,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (sheetCtx) => SafeArea(
      child: FutureBuilder<List<Object?>>(
        future: Future.wait([
          GitService.instance.repoStatus(workspacePath),
          GitService.instance.pushInfo(workspacePath),
        ]),
        builder: (ctx, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Padding(
              padding: EdgeInsets.symmetric(vertical: 56),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            );
          }
          if (snap.hasError) {
            return Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                '读取 git 状态失败：${snap.error}',
                style: TextStyle(color: colors.textMuted, fontSize: 12.5),
              ),
            );
          }
          final status = snap.data![0] as GitRepoStatus;
          final info = snap.data![1] as GitPushInfo;
          return _GitActionSheetBody(
            workspacePath: workspacePath,
            status: status,
            info: info,
            onDone: onDone,
          );
        },
      ),
    ),
  );
}

class _GitActionSheetBody extends StatefulWidget {
  final String workspacePath;
  final GitRepoStatus status;
  final GitPushInfo info;
  final VoidCallback onDone;

  const _GitActionSheetBody({
    required this.workspacePath,
    required this.status,
    required this.info,
    required this.onDone,
  });

  @override
  State<_GitActionSheetBody> createState() => _GitActionSheetBodyState();
}

class _GitActionSheetBodyState extends State<_GitActionSheetBody> {
  final _messageCtrl = TextEditingController();
  bool _includeUnstaged = true;
  bool _busy = false;

  /// 无 upstream = 首次推送（发布分支并建 upstream），不受 ahead 限制；
  /// 有 upstream 时无待推提交则禁用（官方「没有需要推送的提交」语义）
  bool get _canPush => widget.info.hasUpstream ? widget.info.ahead > 0 : true;

  Future<void> _run(Future<void> Function() action, String successMsg) async {
    setState(() => _busy = true);
    try {
      await action();
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(successMsg, style: const TextStyle(fontSize: 13)),
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 3),
          ),
        );
        widget.onDone();
      }
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('失败：$e', style: const TextStyle(fontSize: 13)),
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 4),
          ),
        );
      }
    }
  }

  Future<void> _commit({required bool andPush}) async {
    final message = _messageCtrl.text.trim();
    if (message.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('请先输入提交消息', style: TextStyle(fontSize: 13)),
          behavior: SnackBarBehavior.floating,
          duration: Duration(seconds: 2),
        ),
      );
      return;
    }
    await _run(
      () async {
        await GitService.instance.commit(
          widget.workspacePath,
          message,
          includeUnstaged: _includeUnstaged,
        );
        if (andPush) {
          await GitService.instance.push(
            widget.workspacePath,
            setUpstream: !widget.info.hasUpstream,
          );
        }
      },
      andPush ? '已提交并推送当前更改' : '已提交当前更改',
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 12,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── 顶部行：分支 + 千分位增删 ──────────────────────────
          Row(
            children: [
              Icon(
                Icons.account_tree_outlined,
                size: 15,
                color: colors.textMuted,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  widget.status.branch.isEmpty
                      ? '（detached HEAD）'
                      : widget.status.branch,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: colors.textPrimary, fontSize: 13),
                ),
              ),
              const SizedBox(width: 4),
              Icon(
                Icons.keyboard_arrow_down,
                size: 16,
                color: colors.textMuted,
              ),
              const Spacer(),
              Text(
                '+${formatThousands(widget.status.added)}',
                style: TextStyle(
                  color: widget.status.added > 0
                      ? colors.success
                      : colors.textMuted,
                  fontSize: 13,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '-${formatThousands(widget.status.removed)}',
                style: TextStyle(
                  color: widget.status.removed > 0
                      ? colors.error
                      : colors.textMuted,
                  fontSize: 13,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // ── 提交信息 ─────────────────────────────────────────
          TextField(
            controller: _messageCtrl,
            maxLines: 3,
            minLines: 1,
            enabled: !_busy,
            style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
            decoration: InputDecoration(
              hintText: '提交信息',
              hintStyle: TextStyle(color: colors.textMuted, fontSize: 13),
              filled: true,
              fillColor: colors.bgTertiary,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide(color: colors.border),
              ),
            ),
          ),
          const SizedBox(height: 8),
          // ── 包含未暂存 + 文件计数 ────────────────────────────
          Row(
            children: [
              SizedBox(
                height: 24,
                width: 24,
                child: Checkbox(
                  value: _includeUnstaged,
                  onChanged: _busy
                      ? null
                      : (v) => setState(() => _includeUnstaged = v ?? true),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '包含未暂存的更改',
                  style: TextStyle(color: colors.textPrimary, fontSize: 13),
                ),
              ),
              Text(
                '${widget.status.dirty} 个文件',
                style: TextStyle(
                  color: colors.textMuted,
                  fontSize: 12,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          // ── 动作列表：提交 / 提交并推送 / 推送 ────────────────
          _actionRow(
            colors,
            icon: Icons.commit_outlined,
            label: '提交',
            enabled: !_busy,
            onTap: () => _commit(andPush: false),
            highlighted: true,
          ),
          _actionRow(
            colors,
            icon: Icons.commit_outlined,
            label: '提交并推送',
            enabled: !_busy,
            onTap: () => _commit(andPush: true),
          ),
          _actionRow(
            colors,
            icon: Icons.cloud_upload_outlined,
            label: !widget.info.hasUpstream ? '推送（首次将建立 upstream）' : '推送',
            enabled: !_busy && _canPush,
            onTap: () => _run(
              () => GitService.instance.push(
                widget.workspacePath,
                setUpstream: !widget.info.hasUpstream,
              ),
              '已推送 ${widget.info.branch}',
            ),
          ),
          const SizedBox(height: 4),
        ],
      ),
    );
  }

  Widget _actionRow(
    AppColors colors, {
    required IconData icon,
    required String label,
    required bool enabled,
    required VoidCallback onTap,
    bool highlighted = false,
  }) {
    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(8),
      child: Opacity(
        opacity: enabled ? 1 : 0.45,
        child: Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 2),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          decoration: BoxDecoration(
            color: highlighted ? colors.bgTertiary : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(icon, size: 15, color: colors.textPrimary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
