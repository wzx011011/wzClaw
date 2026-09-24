// ============================================================
// relay_connect_factory 契约测试 — 真实 loopback socket，无 mock
//
// 背景（2026-09-23 手机连不上）：手机浏览器有可用 IPv6 路径，但 Dart 聚合
// 解析在部分网络下丢失 AAAA，App 只拿 IPv4 撞被阿里云边缘拦截的 443。
// 契约锚点：
//   1) 双栈可达 → IPv6 优先；
//   2) 仅 IPv4 可达 → v6 尝试失败后回退成功且数据可通（复现本 bug 的锚点；
//      回退路径经诊断事件断言，同时钉住「尝试失败必须留痕」的可观测契约）；
//   3) 全部候选失败 → SocketException（交给既有重连链路）；
//   4) 排序纯函数：v6 优先、去重、族内保序；
//   5) 解析全失败被吸收为空候选（不抛）。
// ConnectionTask 无法外部构造，测试直接驱动 connectDualStack + 真实端口。
// ============================================================

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/connection_diagnostics.dart';
import 'package:wzxclaw_android/zcode/relay_connect_factory_real.dart';

/// 单测兜底超时：任何一步卡住都快速失败，避免拖死整个套件
Future<T> guard<T>(Future<T> future) =>
    future.timeout(const Duration(seconds: 10));

void main() {
  setUp(ConnectionDiagnostics.instance.clear);

  test('双栈可达：优先选中 IPv6', () async {
    final v6Server = await ServerSocket.bind(
      InternetAddress.loopbackIPv6,
      0,
      v6Only: true,
    );
    final v4Server =
        await ServerSocket.bind(InternetAddress.loopbackIPv4, v6Server.port);
    addTearDown(v6Server.close);
    addTearDown(v4Server.close);

    final uri = Uri.parse('ws://localhost:${v6Server.port}');
    final task = await guard(connectDualStack(uri));
    final socket = await guard(task.socket);
    addTearDown(socket.destroy);

    expect(socket.remoteAddress.type, InternetAddressType.IPv6);
    expect(socket.remoteAddress.address, InternetAddress.loopbackIPv6.address);
    // 成功留痕：双栈场景记录的是 v6 地址上的已连接事件
    expect(
      ConnectionDiagnostics.instance.events.any(
        (e) =>
            e.tag == '已连接' &&
            e.detail.startsWith('IPv6 ${InternetAddress.loopbackIPv6.address}'),
      ),
      isTrue,
    );
  });

  test('仅 IPv4 可达：v6 尝试失败后回退成功且数据可通', () async {
    // 契约前提：本机 hosts 下 localhost 解析得出 v6 候选（::1）。无 v6 解析的
    // 环境会退化成 v4 直连，此时回退语义由「双栈可达优先 v6」用例锚定。
    final v6Addrs = await InternetAddress.lookup(
      'localhost',
      type: InternetAddressType.IPv6,
    );
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    // 服务端向首个接入的客户端回写一字节，验证回退建连后数据链路可用
    server.listen((client) {
      client.add([0xAB]);
    });

    final uri = Uri.parse('ws://localhost:${server.port}');
    final task = await guard(connectDualStack(uri));
    final socket = await guard(task.socket);
    addTearDown(socket.destroy);

    expect(socket.remoteAddress.type, InternetAddressType.IPv4);
    expect(await guard(socket.first), [0xAB]);

    // 回退留痕：候选里有 v6 时，必须先有 v6 建连失败事件、再有 v4 成功事件
    final events = ConnectionDiagnostics.instance.events;
    final v6Failed = events.any(
      (e) => e.tag == '建连失败' && e.detail.startsWith('IPv6 '),
    );
    final v4Connected = events.any(
      (e) => e.tag == '已连接' && e.detail.startsWith('IPv4 '),
    );
    expect(v4Connected, isTrue);
    if (v6Addrs.isNotEmpty) {
      expect(v6Failed, isTrue, reason: '候选含 v6 时必须先试 v6 并留失败痕迹');
    }
  });

  test('全部候选失败：抛 SocketException 交给既有重连链路', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = server.port;
    await server.close(); // 立即释放：建连会快速被拒
    expect(
      guard(connectDualStack(Uri.parse('ws://localhost:$port'))),
      throwsA(isA<SocketException>()),
    );
  });

  test('排序纯函数：v6 优先、去重、族内保序', () {
    final v4a = InternetAddress('127.0.0.1', type: InternetAddressType.IPv4);
    final v4b = InternetAddress('127.0.0.2', type: InternetAddressType.IPv4);
    final v6a = InternetAddress('::1', type: InternetAddressType.IPv6);
    final v6b = InternetAddress('fe80::1', type: InternetAddressType.IPv6);

    expect(orderCandidates([v4a, v6a, v4a, v6b, v4b]), [v6a, v6b, v4a, v4b]);
    expect(orderCandidates(const <InternetAddress>[]), isEmpty);
  });

  test('解析全失败：吸收为空候选而不抛（另一族兜底由调用方处理）', () async {
    // .invalid 是保留 TLD，正常网络必然解析失败
    final candidates = await guard(resolveCandidates('nonexistent.invalid'));
    expect(candidates, isEmpty);
  });
}
