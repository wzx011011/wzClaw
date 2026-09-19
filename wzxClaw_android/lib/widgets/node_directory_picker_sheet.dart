// ============================================================
// node_directory_picker_sheet — 节点目录选择器（新建会话自选工作区）
//
// 层级浏览桌面节点目录：根模式列盘符 + 主目录快捷入口；逐级下钻、
// 返回上级；底部「选择当前目录」把绝对路径交给调用方。数据源
// NodeFsService（companion x/fs/dirs），错误显性提示可重试。
// ============================================================

import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/node_fs_service.dart';

/// 返回所选目录绝对路径；取消/关闭返回 null
Future<String?> showNodeDirectoryPicker(BuildContext context) {
  final colors = AppColors.of(context);
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: colors.bgSecondary,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => const _PickerBody(),
  );
}

class _PickerBody extends StatefulWidget {
  const _PickerBody();

  @override
  State<_PickerBody> createState() => _PickerBodyState();
}

class _PickerBodyState extends State<_PickerBody> {
  NodeDirListing? _listing;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load(null);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final listing = await NodeFsService.instance.listDirs(path: path);
      if (!mounted) return;
      setState(() {
        _listing = listing;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  String get _currentDisplay {
    final p = _listing?.path ?? '';
    return p.isEmpty ? '本机磁盘' : p;
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final canPick = _listing != null && !_listing!.isRoot;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.72,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Row(
                children: [
                  Text(
                    '选择节点目录',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  Text(
                    _currentDisplay,
                    style: TextStyle(color: colors.textMuted, fontSize: 11),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '选中的文件夹将作为新会话的工作区',
                  style: TextStyle(color: colors.textMuted, fontSize: 11.5),
                ),
              ),
            ),
            const SizedBox(height: 4),
            Expanded(child: _buildList(colors)),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  icon: const Icon(Icons.check, size: 18),
                  label: const Text('选择当前目录'),
                  onPressed: canPick
                      ? () => Navigator.pop(context, _listing!.path)
                      : null,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList(AppColors colors) {
    if (_loading) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(strokeWidth: 2),
              const SizedBox(height: 10),
              Text(
                '正在读取节点目录…',
                style: TextStyle(color: colors.textMuted, fontSize: 12.5),
              ),
            ],
          ),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.folder_off_outlined,
                size: 30,
                color: colors.textMuted,
              ),
              const SizedBox(height: 10),
              Text(
                '无法读取节点目录',
                style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
              ),
              const SizedBox(height: 6),
              Text(
                _error!,
                style: TextStyle(color: colors.textMuted, fontSize: 11),
                textAlign: TextAlign.center,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('重试'),
                onPressed: () =>
                    _load(_listing?.isRoot == false ? _listing!.path : null),
              ),
            ],
          ),
        ),
      );
    }
    final listing = _listing!;
    final rows = <Widget>[];
    // 返回上级（根模式没有上级）
    if (listing.parent != null) {
      rows.add(
        ListTile(
          dense: true,
          leading: Icon(Icons.arrow_upward, size: 18, color: colors.textMuted),
          title: Text(
            '返回上级',
            style: TextStyle(color: colors.textSecondary, fontSize: 13.5),
          ),
          onTap: () => _load(listing.parent),
        ),
      );
    }
    // 主目录快捷入口（当前不在主目录时显示）
    if (listing.home.isNotEmpty &&
        listing.path != listing.home &&
        !listing.isRoot) {
      rows.add(
        ListTile(
          dense: true,
          leading: Icon(Icons.home_outlined, size: 18, color: colors.accent),
          title: Text(
            '主目录',
            style: TextStyle(color: colors.textSecondary, fontSize: 13.5),
          ),
          onTap: () => _load(listing.home),
        ),
      );
    }
    if (listing.dirs.isEmpty) {
      rows.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
          child: Center(
            child: Text(
              listing.isRoot ? '未发现可用磁盘' : '此目录下没有子目录',
              style: TextStyle(color: colors.textMuted, fontSize: 12.5),
            ),
          ),
        ),
      );
    }
    for (final dir in listing.dirs) {
      rows.add(
        ListTile(
          dense: true,
          leading: Icon(
            Icons.folder_outlined,
            size: 18,
            color: colors.accent,
          ),
          title: Text(
            dir.name,
            style: TextStyle(color: colors.textPrimary, fontSize: 13.5),
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: listing.isRoot
              ? null
              : Text(
                  dir.path,
                  style: TextStyle(color: colors.textMuted, fontSize: 10.5),
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                ),
          onTap: () => _load(dir.path),
        ),
      );
    }
    return ListView(children: rows);
  }
}
