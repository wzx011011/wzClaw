// ============================================================
// connection_manager_bound_test — 多步操作绑定入口契约
//
// 2026-09-19 架构审查 P1-2 的回归锚定：
// 多步操作（附件分块/下载分块/git 两步查询）在开始时绑定请求入口，
// 连接换代（切节点/重连）后旧入口必须终止，绝不允许动态借用新连接。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';

import '../zcode/zcode_test_fakes.dart';

void main() {
  test('boundRequester：代次漂移后旧入口终止，新入口正常', () async {
    final cm = ConnectionManager.createForTest();
    final first = FakeZcodeRelayClient();
    cm.debugAttachClient(first); // 第一代

    final boundOld = cm.boundRequester();
    if (boundOld == null) fail('已连接时必须返回绑定入口');
    expect(cm.connectionGeneration, 1);

    // 换代 = 新连接新实例（重连/切节点），旧实例被关闭
    final second = FakeZcodeRelayClient();
    cm.debugAttachClient(second);
    expect(cm.connectionGeneration, 2);
    expect(first.closed, isTrue, reason: '换代必须关闭旧 client');
    await expectLater(
      boundOld('x/git/status', {'path': '/a'}),
      throwsStateError,
      reason: '旧代次入口必须终止，不得把请求发往新连接',
    );

    second.handlers['ping'] = (_) => 'pong';
    final boundNew = cm.boundRequester();
    if (boundNew == null) fail('新代次必须返回绑定入口');
    expect(await boundNew('ping'), 'pong');
    second.closed = true;
    await expectLater(boundNew('ping'), throwsStateError);
  });

  test('boundRequester：连接断开后入口终止', () async {
    final cm = ConnectionManager.createForTest();
    final fake = FakeZcodeRelayClient();
    cm.debugAttachClient(fake);
    final bound = cm.boundRequester();
    if (bound == null) fail('已连接时必须返回绑定入口');

    fake.closed = true; // 链路断开（paired 变 false）
    await expectLater(bound('ping'), throwsStateError);
  });

  test('boundRequester：未连接返回 null', () {
    final cm = ConnectionManager.createForTest();
    expect(cm.boundRequester(), isNull);
  });
}
