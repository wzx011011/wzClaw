// 传输限速器契约（架构审查 P2-5）：窗口配额超额必须产生可恢复等待，
// 而不是放行到 relay 硬限（10s/16MiB 超额断连）。
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/transfer_rate_limiter.dart';

void main() {
  test('窗口内配额不等待', () async {
    final limiter = TransferRateLimiter(budgetBytes: 1000, window: const Duration(seconds: 10));
    final sw = DateTime.now();
    await limiter.acquire(400);
    await limiter.acquire(400);
    expect(DateTime.now().difference(sw).inMilliseconds, lessThan(500));
  });

  test('超额等待窗口重置（可恢复背压，不抛错）', () async {
    final limiter = TransferRateLimiter(budgetBytes: 100, window: const Duration(milliseconds: 120));
    final sw = DateTime.now();
    await limiter.acquire(80);
    await limiter.acquire(80); // 超出 100B 配额 → 等到窗口重置
    final waited = DateTime.now().difference(sw).inMilliseconds;
    expect(waited, greaterThanOrEqualTo(80), reason: '超额必须等待窗口重置');
    // 等待后窗口已重置：再次记账不再等待
    final sw2 = DateTime.now();
    await limiter.acquire(10);
    expect(DateTime.now().difference(sw2).inMilliseconds, lessThan(80));
  });
}
