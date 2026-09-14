// ============================================================
// zcode_pair_scanner — ZCode 配对二维码扫描页（公开共享版）
//
// 从 lib/pages/zcode_page.dart 的私有实现（_ZcodePairScannerPage /
// _ScanFramePainter）复制而来，供 LandingPage 配对门等页面复用。
// zcode_page.dart 中的私有副本暂共存（该文件后续批次整体退役删除）。
//
// 交互约定：扫描命中后 Navigator.pop(context, rawValue) 返回二维码
// 原始字符串，由调用方负责解析（parsePairingUrl）与配对。
// 支持相机实时扫描与「从相册选择」（识别已保存的二维码图片，
// 典型场景：配对码 PNG 从 NAS/聊天工具传到手机后直接选图）。
// ============================================================

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../config/app_colors.dart';

/// 配对二维码扫描页（识别成功即 pop 返回二维码原文）
class ZcodePairScannerPage extends StatefulWidget {
  const ZcodePairScannerPage({super.key});

  @override
  State<ZcodePairScannerPage> createState() => _ZcodePairScannerPageState();
}

class _ZcodePairScannerPageState extends State<ZcodePairScannerPage> {
  final MobileScannerController _controller = MobileScannerController();
  final ImagePicker _picker = ImagePicker();
  bool _torchOn = false;
  bool _scanned = false;
  bool _picking = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _complete(String rawValue) {
    if (_scanned) return;
    _scanned = true;
    _controller.stop();
    Navigator.pop(context, rawValue);
  }

  /// 从相册选图并离线识别二维码（不占相机；失败给提示可重试）
  Future<void> _pickFromGallery() async {
    if (_picking || _scanned) return;
    setState(() => _picking = true);
    try {
      final picked = await _picker.pickImage(source: ImageSource.gallery);
      if (picked == null) return; // 用户取消
      final controller = MobileScannerController(autoStart: false);
      try {
        final capture = await controller.analyzeImage(picked.path);
        final rawValue = capture?.barcodes
            .firstWhere((b) => b.rawValue != null, orElse: () => const Barcode())
            .rawValue;
        if (!mounted) return;
        if (rawValue != null && rawValue.isNotEmpty) {
          _complete(rawValue);
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('未在所选图片中识别到二维码')),
          );
        }
      } finally {
        await controller.dispose();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('识别失败：$e')),
        );
      }
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final size = MediaQuery.of(context).size;
    final scanSize = size.width * 0.7;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描配对二维码'),
        backgroundColor: colors.bgSecondary,
        foregroundColor: colors.textPrimary,
        actions: [
          // 从相册选择：识别已保存到手机的配对码图片
          IconButton(
            icon: _picking
                ? SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: colors.textSecondary,
                    ),
                  )
                : Icon(
                    Icons.photo_library_outlined,
                    color: colors.textSecondary,
                  ),
            onPressed: _pickFromGallery,
            tooltip: '从相册选择',
          ),
          IconButton(
            icon: Icon(
              _torchOn ? Icons.flash_on : Icons.flash_off,
              color: colors.textSecondary,
            ),
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
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              if (_scanned) return;
              if (capture.barcodes.isEmpty) return;
              final barcode = capture.barcodes.first;
              if (barcode.rawValue != null) {
                _complete(barcode.rawValue!);
              }
            },
          ),
          // 半透明遮罩 + 中央透明扫描窗
          ColorFiltered(
            colorFilter: ColorFilter.mode(
              Colors.black.withValues(alpha: 0.5),
              BlendMode.srcOut,
            ),
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
          // 扫描框四角
          Center(
            child: SizedBox(
              width: scanSize,
              height: scanSize,
              child: CustomPaint(
                painter: ScanFramePainter(color: colors.accent),
              ),
            ),
          ),
          // 提示文案
          Positioned(
            left: 0,
            right: 0,
            bottom: size.height * 0.2,
            child: Text(
              '对准二维码自动扫描；已保存到手机可点右上角从相册选择',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}

/// 绘制扫描框四角括号
class ScanFramePainter extends CustomPainter {
  final Color color;
  const ScanFramePainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    const cornerLen = 24.0;
    const strokeWidth = 3.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // 左上
    canvas.drawLine(const Offset(0, cornerLen), Offset.zero, paint);
    canvas.drawLine(Offset.zero, const Offset(cornerLen, 0), paint);
    // 右上
    canvas.drawLine(
      Offset(size.width - cornerLen, 0),
      Offset(size.width, 0),
      paint,
    );
    canvas.drawLine(
      Offset(size.width, 0),
      Offset(size.width, cornerLen),
      paint,
    );
    // 左下
    canvas.drawLine(
      Offset(0, size.height),
      Offset(0, size.height - cornerLen),
      paint,
    );
    canvas.drawLine(
      Offset(0, size.height),
      Offset(cornerLen, size.height),
      paint,
    );
    // 右下
    canvas.drawLine(
      Offset(size.width, size.height - cornerLen),
      Offset(size.width, size.height),
      paint,
    );
    canvas.drawLine(
      Offset(size.width - cornerLen, size.height),
      Offset(size.width, size.height),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant ScanFramePainter oldDelegate) =>
      color != oldDelegate.color;
}
