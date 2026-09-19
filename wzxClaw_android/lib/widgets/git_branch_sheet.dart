import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/git_service.dart';

/// git 分支选择底部弹层（对齐官方 ZCode 输入区的分支入口）。
///
/// 数据来自 companion x/* 扩展（桌面本机真实 git），不是 app-server 协议。
/// 返回检出后的分支名（未切换返回 null）。Git 图谱无协议数据源，不做假入口。
Future<String?> showGitBranchSheet(
  BuildContext context, {
  required String workspacePath,
}) async {
  final colors = AppColors.of(context);
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: colors.bgSecondary,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => _BranchSheetBody(workspacePath: workspacePath),
  );
}

class _BranchSheetBody extends StatefulWidget {
  final String workspacePath;
  const _BranchSheetBody({required this.workspacePath});

  @override
  State<_BranchSheetBody> createState() => _BranchSheetBodyState();
}

class _BranchSheetBodyState extends State<_BranchSheetBody> {
  late Future<List<GitBranchInfo>> _future;
  String? _switching; // 正在检出的分支名（防重复点击）

  @override
  void initState() {
    super.initState();
    _future = GitService.instance.branches(widget.workspacePath);
  }

  Future<void> _checkout(String branch, {bool create = false}) async {
    if (_switching != null) return;
    setState(() => _switching = branch);
    try {
      await GitService.instance.checkout(
        widget.workspacePath,
        branch,
        create: create,
      );
      if (mounted) Navigator.pop(context, branch);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('检出失败: $e'),
          backgroundColor: Colors.red.shade700,
        ),);
      }
    } finally {
      if (mounted) setState(() => _switching = null);
    }
  }

  Future<void> _createAndCheckout() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AppColors.of(dialogCtx).bgSecondary,
        title: Text(
          '创建并检出新分支',
          style: TextStyle(
              color: AppColors.of(dialogCtx).textPrimary, fontSize: 16,),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: TextStyle(color: AppColors.of(dialogCtx).textPrimary),
          decoration: InputDecoration(
            hintText: '分支名，如 feat/my-feature',
            hintStyle: TextStyle(color: AppColors.of(dialogCtx).textMuted),
            enabledBorder: OutlineInputBorder(
              borderSide: BorderSide(color: AppColors.of(dialogCtx).border),
            ),
            focusedBorder: OutlineInputBorder(
              borderSide: BorderSide(color: AppColors.of(dialogCtx).accent),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx),
            child: Text('取消', style: TextStyle(color: AppColors.of(dialogCtx).textSecondary),),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogCtx, controller.text.trim()),
            child: Text('创建', style: TextStyle(color: AppColors.of(dialogCtx).accent),),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    // 与 companion 侧白名单一致的预校验，提前给反馈（服务端仍会再校验）
    final valid = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$').hasMatch(name) &&
        !name.contains('..') &&
        !name.endsWith('.lock');
    if (!valid) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('分支名只能含字母/数字/._-/，且不以 - 开头'),
        ),);
      }
      return;
    }
    await _checkout(name, create: true);
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(
              children: [
                Text(
                  '分支',
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => Navigator.pop(context),
                  child: Text(
                    '关闭',
                    style: TextStyle(color: colors.textMuted, fontSize: 13),
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Flexible(
            child: FutureBuilder<List<GitBranchInfo>>(
              future: _future,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 28),
                    child: CircularProgressIndicator(strokeWidth: 2),
                  );
                }
                if (snap.hasError || (snap.data?.isEmpty ?? true)) {
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 28),
                    child: Text(
                      snap.hasError ? '分支列表获取失败' : '该工作区没有本地分支',
                      style: TextStyle(color: colors.textMuted, fontSize: 14),
                    ),
                  );
                }
                final branches = snap.data!;
                // 当前分支置顶，其余按名称排序
                branches.sort((a, b) {
                  if (a.current != b.current) return a.current ? -1 : 1;
                  return a.name.compareTo(b.name);
                });
                return ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: MediaQuery.of(context).size.height * 0.5,
                  ),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: branches.length,
                    itemBuilder: (ctx, i) {
                      final b = branches[i];
                      final switching = _switching == b.name;
                      return InkWell(
                        onTap: b.current ? null : () => _checkout(b.name),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 20, vertical: 12,),
                          child: Row(
                            children: [
                              Icon(
                                Icons.call_split,
                                size: 18,
                                color: b.current ? colors.accent : colors.textSecondary,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  b.name,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: b.current
                                        ? colors.accent
                                        : colors.textPrimary,
                                    fontSize: 14,
                                    fontWeight: b.current
                                        ? FontWeight.w600
                                        : FontWeight.normal,
                                  ),
                                ),
                              ),
                              if (switching)
                                const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child:
                                      CircularProgressIndicator(strokeWidth: 2),
                                )
                              else if (b.current)
                                Icon(Icons.check,
                                    size: 18, color: colors.accent,),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                );
              },
            ),
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.add, color: colors.textSecondary),
            title: Text(
              '创建并检出新分支...',
              style: TextStyle(color: colors.textPrimary, fontSize: 14),
            ),
            onTap: _createAndCheckout,
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
