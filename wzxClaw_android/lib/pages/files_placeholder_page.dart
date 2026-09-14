// ============================================================
// files_placeholder_page — 文件浏览占位页
//
// zcode app-server 协议暂无文件树/读文件 API（v3 非目标，见
// .planning/PLAN-zcode-remote-v2.md）。旧 FileBrowser/FileViewer
// 退役后，该路由保留为占位：防旧安装的 last_route 深链落空。
// ============================================================

import 'package:flutter/material.dart';

import '../config/app_colors.dart';

class FilesPlaceholderPage extends StatelessWidget {
  const FilesPlaceholderPage({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
        title: Text('浏览文件', style: TextStyle(color: colors.textPrimary)),
      ),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.folder_open,
              size: 56,
              color: colors.textMuted.withValues(alpha: 0.7),
            ),
            const SizedBox(height: 16),
            Text(
              '等待 v3 workspace 支持',
              style: TextStyle(
                color: colors.textSecondary,
                fontSize: 15,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'ZCode 远程链路暂未提供文件浏览能力',
              style: TextStyle(color: colors.textMuted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}
