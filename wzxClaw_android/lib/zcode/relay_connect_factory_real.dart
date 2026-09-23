// dart:io 平台真实现：relay 建连「IPv6 优先 + IPv4 回退」。
//
// 为什么需要（2026-09-23 手机连不上实证）：手机移动数据有可用的 IPv6 路径
// （浏览器能打开仅 v6 可达的 NAS 页面，NAS 侧 wss 经 IPv6 握手 101 正常），
// 但 Dart 的 InternetAddress.lookup 走系统聚合解析（AF_UNSPEC），Android 在
// 无 v6 默认路由等场景会把 AAAA 从聚合结果里过滤掉——App 只拿到 A 记录，
// WebSocketChannel.connect 直撞被阿里云边缘拦截的 IPv4 443（备案 SNI 过滤
// RST）。显式按 family 查询（AF_INET6 hints）可绕开这层过滤拿到 AAAA；
// v6 建连失败再按序回退 v4。
//
// TLS 责任边界：HttpClient.connectionFactory 一旦设置，SDK 完全跳过自身的
// SecureSocket.startConnect（见 flutter sdk http_impl.dart 连接路径），wss 的
// TLS 必须由本工厂完成。SNI 与证书校验域名取自 lookup 结果保留的
// InternetAddress.host（原域名），默认严格校验，不设 onBadCertificate。
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'connection_diagnostics.dart';

/// 单地址建连超时：超时即放弃该地址换下一个。v4 被边缘拦截时 RST 数十毫秒
/// 即失败，超时只兜住「静默丢包」型地址（如 v6 路由残缺时的悬挂 SYN）。
const Duration _kPerAttemptTimeout = Duration(seconds: 4);

/// family 解析超时：getaddrinfo 在坏网络上可能长期悬挂，封顶防止首连卡死。
const Duration _kLookupTimeout = Duration(seconds: 3);

/// relay WebSocket 建连入口（ZcodeRelayClient 默认工厂）。
WebSocketChannel connectRelay(Uri url) {
  final client = HttpClient()
    ..connectionFactory = (Uri uri, String? proxyHost, int? proxyPort) =>
        connectDualStack(uri);
  // customClient 的生命周期与 SDK 内部默认 HttpClient 一致：建连后不 close
  // （websocket_impl 对自建 client 同样不回收；WS 长连接脱离连接池语义）。
  return IOWebSocketChannel.connect(url, customClient: client);
}

/// 连接工厂核心：显式双栈解析 → IPv6 优先逐地址尝试 → 返回先建成的那个
/// ConnectionTask（SDK 原生任务，无法外部构造，故用「等到建成再返回」的
/// 顺序回退实现 Happy Eyeballs 语义）。公开以便契约测试直接驱动真实 loopback。
@visibleForTesting
Future<ConnectionTask<Socket>> connectDualStack(Uri uri) async {
  final useTls = uri.scheme == 'wss' || uri.scheme == 'https';
  // Dart 的 Uri.port 对未写显式端口的 wss/ws 返回 0（不回落默认值），
  // 直接建连即「连 0 端口」必败（2026-09-23 手机 1.2.54 实证）——统一归一化
  final port = effectivePort(uri);
  final candidates = await resolveCandidates(uri.host);
  if (candidates.isEmpty) {
    ConnectionDiagnostics.instance
        .record('建连失败', '双栈解析无候选地址: ${uri.host}');
    throw SocketException('relay 建连失败：无候选地址 (${uri.host})');
  }
  Object? lastError;
  for (final addr in candidates) {
    final family = addr.type == InternetAddressType.IPv6 ? 'IPv6' : 'IPv4';
    final watch = Stopwatch()..start();
    final ConnectionTask<Socket> task;
    try {
      task = await (useTls
          ? SecureSocket.startConnect(addr, port)
          : Socket.startConnect(addr, port));
    } catch (e) {
      ConnectionDiagnostics.instance
          .record('建连失败', '$family ${addr.address}: startConnect 异常: $e');
      lastError = e;
      continue;
    }
    try {
      await task.socket.timeout(_kPerAttemptTimeout);
      watch.stop();
      ConnectionDiagnostics.instance.record(
        '已连接',
        '$family ${addr.address}:$port (${watch.elapsedMilliseconds}ms)',
      );
      return task;
    } catch (e) {
      task.cancel();
      watch.stop();
      ConnectionDiagnostics.instance.record(
        '建连失败',
        '$family ${addr.address}:$port (${watch.elapsedMilliseconds}ms): $e',
      );
      lastError = e;
    }
  }
  throw SocketException(
    'relay 建连失败：全部候选地址失败 (${uri.host}:$port) lastError=$lastError',
  );
}

/// 按 family 显式解析候选地址（v6 在前）。
///
/// 两族查询相互独立：任一族抛错/超时/为空都不阻断另一族——本函数的存在
/// 意义就是修复「聚合解析只回 IPv4」的缺陷，聚合查询不再使用。
Future<List<InternetAddress>> resolveCandidates(String host) async {
  final v6 = _lookupFamily(host, InternetAddressType.IPv6);
  final v4 = _lookupFamily(host, InternetAddressType.IPv4);
  final results = await Future.wait([v6, v4]);
  return orderCandidates([...results[0], ...results[1]]);
}

Future<List<InternetAddress>> _lookupFamily(
  String host,
  InternetAddressType type,
) async {
  try {
    return await InternetAddress.lookup(host, type: type)
        .timeout(_kLookupTimeout, onTimeout: () => const []);
  } catch (_) {
    // 解析失败按「该族无候选」处理，由另一族兜底；诊断留痕交给调用方
    return const [];
  }
}

/// 候选地址排序（纯函数）：IPv6 优先、同族保持相对顺序、按地址串去重。
@visibleForTesting
List<InternetAddress> orderCandidates(Iterable<InternetAddress> addresses) {
  final seen = <String>{};
  final v6 = <InternetAddress>[];
  final v4 = <InternetAddress>[];
  for (final addr in addresses) {
    if (!seen.add(addr.address)) continue;
    (addr.type == InternetAddressType.IPv6 ? v6 : v4).add(addr);
  }
  return [...v6, ...v4];
}
