import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../services/file_sync_service.dart';
import 'file_viewer_page.dart';

/// Full-screen file browser for browsing the desktop workspace.
class FileBrowserPage extends StatefulWidget {
  const FileBrowserPage({super.key});

  @override
  State<FileBrowserPage> createState() => _FileBrowserPageState();
}

class _FileBrowserPageState extends State<FileBrowserPage> {
  List<FileTreeNode> _tree = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadTree();
  }

  Future<void> _loadTree() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final nodes = await FileSyncService.instance.fetchTree(depth: 3);
      if (mounted) {
        setState(() {
          _tree = nodes;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _expandDirectory(FileTreeNode node) async {
    if (!node.isDirectory) return;
    if (node.isExpanded) {
      setState(() => node.isExpanded = false);
      return;
    }
    // Lazy-load children if empty
    if (node.children.isEmpty) {
      final children = await FileSyncService.instance.fetchTree(
        dirPath: node.path,
        depth: 2,
      );
      node.children.clear();
      node.children.addAll(children);
    }
    setState(() => node.isExpanded = true);
  }

  void _openFile(FileTreeNode node) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) =>
            FileViewerPage(filePath: node.path, fileName: node.name),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        title: Text('文件浏览', style: TextStyle(color: colors.textPrimary)),
        iconTheme: IconThemeData(color: colors.textPrimary),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadTree,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    final colors = AppColors.of(context);
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: colors.error, size: 48),
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: colors.textSecondary)),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _loadTree, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_tree.isEmpty) {
      return Center(
        child: Text('空目录', style: TextStyle(color: colors.textMuted)),
      );
    }
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children:
          _tree.map((n) => _buildNode(n, 0, colors)).expand((w) => w).toList(),
    );
  }

  List<Widget> _buildNode(FileTreeNode node, int depth, AppColors colors) {
    final widgets = <Widget>[];
    widgets.add(
      InkWell(
        onTap: () {
          if (node.isDirectory) {
            _expandDirectory(node);
          } else {
            _openFile(node);
          }
        },
        child: Padding(
          padding: EdgeInsets.only(
            left: 16.0 + depth * 16,
            right: 16,
            top: 6,
            bottom: 6,
          ),
          child: Row(
            children: [
              Icon(
                node.isDirectory
                    ? (node.isExpanded ? Icons.folder_open : Icons.folder)
                    : _getFileIcon(node.name),
                size: 18,
                color: node.isDirectory
                    ? const Color(0xFFE8A838)
                    : colors.textSecondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  node.name,
                  style: TextStyle(color: colors.textPrimary, fontSize: 13),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (node.isDirectory)
                Icon(
                  node.isExpanded
                      ? Icons.keyboard_arrow_down
                      : Icons.keyboard_arrow_right,
                  size: 16,
                  color: colors.textMuted,
                ),
            ],
          ),
        ),
      ),
    );
    if (node.isDirectory && node.isExpanded) {
      for (final child in node.children) {
        widgets.addAll(_buildNode(child, depth + 1, colors));
      }
    }
    return widgets;
  }

  IconData _getFileIcon(String name) {
    final ext = name.split('.').last.toLowerCase();
    switch (ext) {
      case 'dart':
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
      case 'py':
      case 'rs':
      case 'go':
      case 'java':
      case 'kt':
        return Icons.code;
      case 'json':
      case 'yaml':
      case 'yml':
      case 'toml':
        return Icons.data_object;
      case 'md':
        return Icons.article;
      case 'css':
      case 'scss':
        return Icons.style;
      case 'html':
        return Icons.web;
      case 'png':
      case 'jpg':
      case 'gif':
      case 'svg':
        return Icons.image;
      default:
        return Icons.insert_drive_file;
    }
  }
}
