// ============================================================
// qr_scanner_page — 全屏扫码页（公共组件）
//
// 从 settings_page 抽出：多配对后 landing「添加桌面」与设置页
// 共用同一扫码入口。支持相机扫码 + 相册选图识别 + 手电筒。
// 返回值 = 二维码原文（Navigator.pop<String>）。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../config/app_colors.dart';

/// 全屏二维码扫描页；扫码成功 pop 返回二维码字符串
class QrScannerPage extends StatefulWidget {
  const QrScannerPage({super.key});

  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  final ImagePicker _imagePicker = ImagePicker();
  bool _torchOn = false;
  bool _scanned = false;
  bool _pickingFromGallery = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 从相册选图识别二维码（mobile_scanner analyzeImage）。
  /// analyzeImage 不经过相机流的 onDetect，直接取返回值并按同一出口出页。
  Future<void> _pickFromGallery() async {
    if (_pickingFromGallery) return;
    _pickingFromGallery = true;
    try {
      final XFile? image = await _imagePicker.pickImage(
        source: ImageSource.gallery,
      );
      if (image == null) return;
      final capture = await _controller.analyzeImage(image.path);
      final value = capture?.barcodes
          .firstWhere((b) => b.rawValue != null, orElse: () => const Barcode())
          .rawValue;
      if (!mounted) return;
      if (value == null || value.isEmpty) {
        _showToast('未在图片中识别到二维码');
        return;
      }
      Navigator.pop(context, value);
    } catch (_) {
      if (mounted) _showToast('相册识别失败');
    } finally {
      _pickingFromGallery = false;
    }
  }

  void _showToast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final size = MediaQuery.of(context).size;
    final scanSize = size.width * 0.7;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描二维码'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
        actions: [
          IconButton(
            icon: Icon(Icons.photo_library_outlined, color: colors.textSecondary),
            onPressed: _pickFromGallery,
            tooltip: '从相册选择',
          ),
          IconButton(
            icon: Icon(_torchOn ? Icons.flash_on : Icons.flash_off,
                color: colors.textSecondary,),
            onPressed: () {
              setState(() => _torchOn = !_torchOn);
              _controller.toggleTorch();
            },
            tooltip: '手电筒',
          ),
        ],
      ),
      body: Stack(
        children: [
          // 粘贴兜底（web 无相机；桌面/手机同样可用）：读取剪贴板中的
          // 配对链接直接返回，与扫码同一处理管线
          Positioned(
            left: 0,
            right: 0,
            bottom: 24,
            child: Center(
              child: FilledButton.tonalIcon(
                onPressed: () async {
                  // lint 穿不透异步间隙的 mounted 流分析：context 触达
                  // 全部前置捕获
                  final messenger = ScaffoldMessenger.of(context);
                  final navigator = Navigator.of(context);
                  final data = await Clipboard.getData(Clipboard.kTextPlain);
                  final text = data?.text?.trim() ?? '';
                  if (!mounted) return;
                  if (text.isEmpty) {
                    messenger.showSnackBar(const SnackBar(content: Text('剪贴板为空')));
                    return;
                  }
                  _scanned = true;
                  _controller.stop();
                  navigator.pop(text);
                },
                icon: const Icon(Icons.content_paste, size: 18),
                label: const Text('粘贴配对链接'),
              ),
            ),
          ),
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              if (_scanned) return;
              if (capture.barcodes.isEmpty) return;
              final barcode = capture.barcodes.first;
              if (barcode.rawValue != null) {
                _scanned = true;
                _controller.stop();
                Navigator.pop(context, barcode.rawValue);
              }
            },
          ),
          // Dimmed overlay with transparent scan window
          ColorFiltered(
            colorFilter: ColorFilter.mode(
                Colors.black.withValues(alpha: 0.5), BlendMode.srcOut,),
            child: Stack(
              children: [
                Container(
                  decoration: const BoxDecoration(
                    color: Colors.black,
                    backgroundBlendMode: BlendMode.dstOut,
                  ),
                ),
                Center(
                  child: Container(
                    width: scanSize,
                    height: scanSize,
                    decoration: BoxDecoration(
                      color: Colors.red,
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ],
            ),
          ),
          // Scan frame corners
          Center(
            child: SizedBox(
              width: scanSize,
              height: scanSize,
              child: CustomPaint(
                  painter: _ScanFramePainter(color: colors.accent),),
            ),
          ),
          // Hint text
          Positioned(
            left: 0,
            right: 0,
            bottom: size.height * 0.2,
            child: Text(
              '将二维码放入框内自动扫描',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }
}

/// Paints four corner brackets for the scan frame.
class _ScanFramePainter extends CustomPainter {
  final Color color;
  const _ScanFramePainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    const cornerLen = 24.0;
    const strokeWidth = 3.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // Top-left
    canvas.drawLine(const Offset(0, cornerLen), Offset.zero, paint);
    canvas.drawLine(Offset.zero, const Offset(cornerLen, 0), paint);
    // Top-right
    canvas.drawLine(
        Offset(size.width - cornerLen, 0), Offset(size.width, 0), paint,);
    canvas.drawLine(
        Offset(size.width, 0), Offset(size.width, cornerLen), paint,);
    // Bottom-left
    canvas.drawLine(
        Offset(0, size.height), Offset(0, size.height - cornerLen), paint,);
    canvas.drawLine(
        Offset(0, size.height), Offset(cornerLen, size.height), paint,);
    // Bottom-right
    canvas.drawLine(Offset(size.width, size.height - cornerLen),
        Offset(size.width, size.height), paint,);
    canvas.drawLine(Offset(size.width - cornerLen, size.height),
        Offset(size.width, size.height), paint,);
  }

  @override
  bool shouldRepaint(covariant _ScanFramePainter oldDelegate) =>
      color != oldDelegate.color;
}
