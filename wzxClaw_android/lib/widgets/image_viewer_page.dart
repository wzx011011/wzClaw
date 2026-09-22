import 'package:flutter/material.dart';

import 'local_image.dart';

/// 全屏图片预览：黑底 + 双指缩放/平移，双击在 1x/2.5x 间切换，
/// 点背景或右上角关闭。数据源是手机本地文件路径（附件选图缓存/
/// 已下载文件），不承担节点下载——远程文件先落本地再进预览。
class ImageViewerPage extends StatefulWidget {
  const ImageViewerPage({super.key, required this.filePath, this.title});

  final String filePath;

  /// 顶部浮层标题（通常是文件名；空则不显示）
  final String? title;

  @override
  State<ImageViewerPage> createState() => _ImageViewerPageState();
}

class _ImageViewerPageState extends State<ImageViewerPage> {
  final TransformationController _controller = TransformationController();
  TapDownDetails? _doubleTapDown;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 双击缩放：以点击点为焦点在原尺寸与 2.5x 间切换
  void _onDoubleTap() {
    final position = _doubleTapDown?.localPosition;
    if (_controller.value.isIdentity()) {
      if (position == null) {
        _controller.value = Matrix4.identity()..scaleByDouble(2.5, 2.5, 1, 1);
        return;
      }
      const scale = 2.5;
      final x = -position.dx * (scale - 1);
      final y = -position.dy * (scale - 1);
      _controller.value = Matrix4.identity()
        ..translateByDouble(x, y, 0, 1)
        ..scaleByDouble(scale, scale, 1, 1);
    } else {
      _controller.value = Matrix4.identity();
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.title?.trim() ?? '';
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              // 缩放/拖动由 InteractiveViewer 消费；单击空白关闭
              onTap: () => Navigator.of(context).pop(),
              onDoubleTapDown: (details) => _doubleTapDown = details,
              onDoubleTap: _onDoubleTap,
              child: InteractiveViewer(
                transformationController: _controller,
                maxScale: 8,
                minScale: 1,
                child: Center(
                  child: buildLocalImage(
                    widget.filePath,
                    fit: BoxFit.contain,
                    errorWidget: const Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.broken_image_outlined,
                          size: 48,
                          color: Colors.white38,
                        ),
                        SizedBox(height: 8),
                        Text(
                          '图片无法加载：文件可能已被清理',
                          style: TextStyle(color: Colors.white54, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.topLeft,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: '关闭',
                      style: IconButton.styleFrom(
                        backgroundColor: Colors.black45,
                      ),
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(
                        Icons.close,
                        color: Colors.white,
                        size: 22,
                      ),
                    ),
                    if (title.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      Flexible(
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 6,
                          ),
                          decoration: BoxDecoration(
                            color: Colors.black45,
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Colors.white70,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
