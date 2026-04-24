import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/themes/vs2015.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:highlight/highlight.dart' show highlight;

import '../config/app_colors.dart';
import '../services/file_sync_service.dart';

/// Full-screen file viewer with type-based dispatch:
/// - HTML → WebView
/// - Markdown → rendered markdown
/// - Images → Image.memory
/// - Code/Text → syntax highlighting
class FileViewerPage extends StatefulWidget {
  final String filePath;
  final String fileName;

  const FileViewerPage({
    super.key,
    required this.filePath,
    required this.fileName,
  });

  @override
  State<FileViewerPage> createState() => _FileViewerPageState();
}

class _FileViewerPageState extends State<FileViewerPage> {
  FileContent? _content;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadFile();
  }

  Future<void> _loadFile() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      print('[FileViewer] loading: ${widget.filePath}');
      final content = await FileSyncService.instance.readFile(widget.filePath);
      print('[FileViewer] result: ${content != null ? "got content (${content.size} bytes)" : "null"}');
      if (mounted) {
        setState(() {
          _content = content;
          _loading = false;
          if (content == null) _error = '无法读取文件';
        });
      }
    } catch (e) {
      print('[FileViewer] error: $e');
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  void _copyContent() {
    if (_content == null) return;
    Clipboard.setData(ClipboardData(text: _content!.content));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('已复制文件内容'),
        duration: Duration(seconds: 1),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  bool get _isHtml {
    final ext = _fileExtension;
    return ext == 'html' || ext == 'htm';
  }

  bool get _isMarkdown {
    return _fileExtension == 'md';
  }

  bool get _isImage {
    final ext = _fileExtension;
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].contains(ext);
  }

  String get _fileExtension {
    final parts = widget.fileName.split('.');
    return parts.length > 1 ? parts.last.toLowerCase() : '';
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Scaffold(
      backgroundColor: colors.bgPrimary,
      appBar: AppBar(
        backgroundColor: colors.bgSecondary,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.fileName,
              style: TextStyle(color: colors.textPrimary, fontSize: 14),
            ),
            if (_content != null)
              Text(
                '${_content!.language} · ${_formatSize(_content!.size)}',
                style: TextStyle(color: colors.textMuted, fontSize: 11),
              ),
          ],
        ),
        iconTheme: IconThemeData(color: colors.textPrimary),
        actions: [
          if (!_isHtml)
            IconButton(
              icon: const Icon(Icons.copy),
              tooltip: '复制全文',
              onPressed: _copyContent,
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadFile,
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
            ElevatedButton(onPressed: _loadFile, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_content == null) return const SizedBox.shrink();

    // Dispatch by file type
    if (_isHtml) return _buildHtmlView(colors);
    if (_isMarkdown) return _buildMarkdownView(colors);
    if (_isImage) return _buildImageView(colors);
    return _buildCodeView(colors);
  }

  Widget _buildHtmlView(AppColors colors) {
    return InAppWebView(
      initialData: InAppWebViewInitialData(data: _content!.content),
      initialSettings: InAppWebViewSettings(
        useHybridComposition: true,
        transparentBackground: true,
      ),
    );
  }

  Widget _buildMarkdownView(AppColors colors) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(12),
      child: MarkdownBody(
        data: _content!.content,
        selectable: true,
        styleSheet: MarkdownStyleSheet(
          p: TextStyle(color: colors.textPrimary, fontSize: 14, height: 1.6),
          h1: TextStyle(color: colors.textPrimary, fontSize: 22, fontWeight: FontWeight.bold),
          h2: TextStyle(color: colors.textPrimary, fontSize: 18, fontWeight: FontWeight.bold),
          h3: TextStyle(color: colors.textPrimary, fontSize: 16, fontWeight: FontWeight.w600),
          code: TextStyle(
            fontFamily: 'monospace',
            fontSize: 12,
            backgroundColor: colors.bgTertiary,
            color: colors.accent,
          ),
          codeblockDecoration: BoxDecoration(
            color: colors.bgTertiary,
            borderRadius: BorderRadius.circular(8),
          ),
        ),
      ),
    );
  }

  Widget _buildImageView(AppColors colors) {
    try {
      final bytes = base64Decode(_content!.content);
      return Center(
        child: Image.memory(
          bytes,
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => _buildUnsupportedImage(colors),
        ),
      );
    } catch (_) {
      // If not base64, try treating content as text (SVG path etc.)
      return _buildUnsupportedImage(colors);
    }
  }

  Widget _buildUnsupportedImage(AppColors colors) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.image_not_supported, size: 48, color: colors.textMuted),
          const SizedBox(height: 8),
          Text('无法预览此图片格式', style: TextStyle(color: colors.textSecondary)),
        ],
      ),
    );
  }

  Widget _buildCodeView(AppColors colors) {
    List<TextSpan> spans;
    try {
      final result = _content!.language.isNotEmpty
          ? highlight.parse(_content!.content, language: _content!.language)
          : highlight.parse(_content!.content, autoDetection: true);
      spans = _convertNodes(result.nodes ?? []);
    } catch (_) {
      spans = [TextSpan(text: _content!.content)];
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      child: SingleChildScrollView(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SelectableText.rich(
            TextSpan(
              children: spans,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                height: 1.5,
                color: colors.textPrimary,
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<TextSpan> _convertNodes(List<dynamic> nodes) {
    final spans = <TextSpan>[];
    for (final node in nodes) {
      if (node is String) {
        spans.add(TextSpan(text: node));
      } else if (node.className != null) {
        final style = vs2015Theme[node.className] ?? const TextStyle();
        final children = node.children != null
            ? _convertNodes(node.children!)
            : [TextSpan(text: node.value ?? '')];
        spans.add(TextSpan(style: style, children: children));
      } else {
        if (node.children != null) {
          spans.addAll(_convertNodes(node.children!));
        } else {
          spans.add(TextSpan(text: node.value ?? ''));
        }
      }
    }
    return spans;
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}
