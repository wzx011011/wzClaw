// ============================================================
// zcode_pair_scanner — ZCode 配对二维码扫描页（公开共享版）
//
// 从 lib/pages/zcode_page.dart 的私有实现（_ZcodePairScannerPage /
// _ScanFramePainter）复制而来，供 LandingPage 配对门等页面复用。
// zcode_page.dart 中的私有副本暂共存（该文件后续批次整体退役删除）。
//
// 交互约定：扫描命中后 Navigator.pop(context, rawValue) 返回二维码
// 原始字符串，由调用方负责解析（parsePairingUrl）与配对。
// ============================================================

import 'package:flutter/material.dart';
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
  bool _torchOn = false;
  bool _scanned = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
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
                _scanned = true;
                _controller.stop();
                Navigator.pop(context, barcode.rawValue);
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
              '将桌面端配对二维码放入框内自动扫描',
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.textSecondary, fontSize: 14),
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
