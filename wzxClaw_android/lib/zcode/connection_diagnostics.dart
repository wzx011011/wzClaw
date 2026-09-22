import 'package:flutter/foundation.dart';

import '../platform_io.dart';

/// 连接事件（连接层可观测性的最小单元）
class ConnectionEvent {
  ConnectionEvent(this.tag, this.detail) : time = DateTime.now();

  final DateTime time;

  /// 事件类别：尝试/已连接/建连失败/配对/relay拒绝/断开/重连/体检
  final String tag;
  final String detail;
}

/// 路径体检单项结果
class PathCheckResult {
  const PathCheckResult(this.label, this.ok, this.detail);
  final String label;
  final bool ok;
  final String detail;
}

/// 连接诊断：进程内环形事件缓冲 + 网络路径体检。
/// 「静默丢弃 = 缺陷」原则的连接层配套——用户在 App 内即可查看
/// 连接尝试/失败原因并一键复制上报，无需 adb。
class ConnectionDiagnostics {
  ConnectionDiagnostics._();

  static final ConnectionDiagnostics instance = ConnectionDiagnostics._();

  static const int _maxEvents = 200;
  final List<ConnectionEvent> _events = <ConnectionEvent>[];
  String? _targetHost;
  int? _targetPort;

  /// 最近一次连接目标（relay 客户端 connect 时登记；体检默认用它）
  String? get targetHost => _targetHost;
  int? get targetPort => _targetPort;

  void noteTarget(Uri url) {
    _targetHost = url.host;
    // Dart 的 Uri.port 对 wss/ws 等非 http 系 scheme 且未写显式端口时返回 0，
    // 按约定归一化（体检与展示都用真实端口）
    final p = url.port;
    _targetPort = p != 0
        ? p
        : ((url.scheme == 'ws' || url.scheme == 'http') ? 80 : 443);
  }

  /// 记录一条事件（新事件插队首，超出容量裁掉最旧的）
  void record(String tag, String detail) {
    _events.insert(0, ConnectionEvent(tag, detail));
    if (_events.length > _maxEvents) {
      _events.removeRange(_maxEvents, _events.length);
    }
  }

  /// 事件快照（新→旧）
  List<ConnectionEvent> get events => List.unmodifiable(_events);

  void clear() => _events.clear();

  /// 导出为可复制的故障报告文本（新→旧）
  String export() {
    final buf = StringBuffer()
      ..writeln('wzxClaw 连接诊断')
      ..writeln('目标: ${_targetHost ?? '未知'}:${_targetPort ?? '?'}')
      ..writeln('导出时间: ${DateTime.now()}')
      ..writeln('最近事件（新→旧，共 ${_events.length} 条）:');
    for (final e in _events) {
      final t = e.time.toIso8601String().substring(11, 23);
      buf.writeln('$t [${e.tag}] ${e.detail}');
    }
    return buf.toString();
  }

  /// 网络路径体检：DNS 解析 → 分 IPv4/IPv6 各做一次 TCP+TLS 握手。
  /// 证书校验放行（体检只测可达性，不做身份验证）。
  Future<List<PathCheckResult>> runPathChecks(String host,
      {int port = 443,}) async {
    final results = <PathCheckResult>[];
    // web 无原始套接字/DNS API（flutter web 支持，2026-09-22）：显式降级，
    // 诊断面标注不可用而非崩溃
    if (kIsWeb) {
      results.add(const PathCheckResult('链路探测', false, 'web 端不支持 DNS/TLS 探测'));
      for (final r in results) {
        record('体检', '${r.label}: ${r.detail}');
      }
      return results;
    }
    List<InternetAddress> addrs;
    try {
      addrs = await InternetAddress.lookup(host);
    } catch (e) {
      results.add(PathCheckResult('DNS', false, '解析失败: $e'));
      for (final r in results) {
        record('体检', '${r.label}: ${r.detail}');
      }
      return results;
    }
    results.add(PathCheckResult('DNS', true, '解析到 ${addrs.length} 个地址'));
    final v4 = addrs.where((a) => a.type == InternetAddressType.IPv4).toList();
    final v6 = addrs.where((a) => a.type == InternetAddressType.IPv6).toList();
    if (v4.isEmpty) {
      results.add(const PathCheckResult('IPv4', false, '解析结果无 IPv4 地址'));
    }
    if (v6.isEmpty) {
      results.add(
        const PathCheckResult('IPv6', false, '解析结果无 IPv6 地址（当前网络未提供）'),
      );
    }
    for (final addr in [...v4.take(1), ...v6.take(1)]) {
      final label = addr.type == InternetAddressType.IPv4 ? 'IPv4' : 'IPv6';
      final watch = Stopwatch()..start();
      try {
        final socket = await SecureSocket.connect(
          addr,
          port,
          timeout: const Duration(seconds: 6),
          onBadCertificate: (_) => true, // 只测可达性
        );
        watch.stop();
        socket.destroy();
        results.add(
          PathCheckResult(
              label, true, '握手成功（${watch.elapsedMilliseconds}ms → $addr）',),
        );
      } catch (e) {
        watch.stop();
        results.add(
          PathCheckResult(
              label, false, '连接失败（${watch.elapsedMilliseconds}ms）: $e',),
        );
      }
    }
    for (final r in results) {
      record('体检', '${r.label}: ${r.detail}');
    }
    return results;
  }
}
