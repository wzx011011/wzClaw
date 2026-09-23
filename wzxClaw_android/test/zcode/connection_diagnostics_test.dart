import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/connection_diagnostics.dart';

void main() {
  test('环形缓冲：新事件在队首，超出容量裁掉最旧的', () {
    final d = ConnectionDiagnostics.instance..clear();
    for (var i = 0; i < 250; i++) {
      d.record('尝试', '事件 $i');
    }
    final events = d.events;
    expect(events.length, 200); // 容量封顶
    expect(events.first.detail, '事件 249'); // 最新在队首
    expect(events.last.detail, '事件 50'); // 最旧的 50 条被裁掉
  });

  test('导出报告：含目标、时间与逐条事件（新→旧）', () {
    final d = ConnectionDiagnostics.instance
      ..clear()
      ..noteTarget(Uri.parse('wss://zcode.5945.top/ws'));
    d.record('尝试', '连接 zcode.5945.top:443');
    d.record('relay拒绝', 'CAPACITY 房间已满');
    final text = d.export();
    expect(text, contains('wzxClaw 连接诊断'));
    expect(text, contains('zcode.5945.top'));
    expect(text, contains('[relay拒绝] CAPACITY 房间已满'));
    expect(text, contains('[尝试] 连接 zcode.5945.top:443'));
    // 新→旧：拒绝事件出现在尝试事件之前
    expect(text.indexOf('[relay拒绝]'), lessThan(text.indexOf('[尝试]')));
    d.clear();
    expect(d.events, isEmpty);
  });

  test('目标登记：host/port 供路径体检默认使用', () {
    // 单例全局状态：不假设初始为空（其他测试/真实连接可能已登记），
    // 只验证 noteTarget 覆盖登记生效
    final d = ConnectionDiagnostics.instance;
    d.noteTarget(Uri.parse('wss://zcode.5945.top/ws'));
    expect(d.targetHost, 'zcode.5945.top');
    expect(d.targetPort, 443);
    d.noteTarget(Uri.parse('wss://other.example.com:8443/ws'));
    expect(d.targetHost, 'other.example.com');
    expect(d.targetPort, 8443);
  });

  test('路径体检：显式 AAAA 行区分「聚合过滤掉 AAAA」与「真无记录」', () async {
    // 绑定后立即释放端口：后续 TLS 建连快速被拒，体检不拖时
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = server.port;
    await server.close();
    addTearDown(ConnectionDiagnostics.instance.clear);

    final results =
        await ConnectionDiagnostics.instance.runPathChecks('localhost', port: port);
    final rows = results.where((r) => r.label == 'IPv6(DNS)').toList();
    // 行必须存在（2026-09-23 双栈工厂配套观测：聚合解析与显式族查询对照）
    expect(rows, hasLength(1));
    // 本机 hosts 下 localhost 必有 AAAA（::1）：显式族查询应给出命中详情
    expect(rows.single.ok, isTrue);
    expect(rows.single.detail, contains('显式 AAAA 查询到'));
  });
}
