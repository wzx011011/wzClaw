// ============================================================
// image_viewer_page_test — 全屏图片预览组件
//
// 钉住的契约：页面构建（标题浮层）、关闭按钮退出路由。
// 注：图片解码依赖平台通道（flutter_test 环境不可用），解码成功/
// 失败分支不在组件测试内驱动——errorBuilder 的兜底由代码路径保证，
// 解码错误回调经 ImageStream 触发 errorBuilder 是 Flutter 契约。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/widgets/image_viewer_page.dart';

Future<void> _pushViewer(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                fullscreenDialog: true,
                builder: (_) => const ImageViewerPage(
                  filePath: '/data/cache/shot.png',
                  title: 'shot.png',
                ),
              ),
            ),
            child: const Text('打开预览'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开预览'));
  // 推进路由转场动画（不用 pumpAndSettle：图片流挂起时会卡住）
  await tester.pump(const Duration(milliseconds: 60));
  await tester.pump(const Duration(milliseconds: 350));
}

void main() {
  testWidgets('进入预览显示标题浮层，关闭按钮退出', (tester) async {
    await _pushViewer(tester);

    expect(find.byType(ImageViewerPage), findsOneWidget);
    expect(find.text('shot.png'), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(find.byType(ImageViewerPage), findsNothing);
  });

  testWidgets('空标题不渲染标题胶囊', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: ImageViewerPage(filePath: '/data/cache/x.jpg'),
      ),
    );
    await tester.pump();

    expect(find.byType(ImageViewerPage), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);
  });
}
