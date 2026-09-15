// ============================================================
// git_service 单元测试 — x/* 扩展请求的参数、解析与降级
//
// 背景：git 分支/工作区新鲜度走 companion 本地扩展协议 x/*
// （见 relay/zcode/APP-SERVER.md），此处钉住请求参数形状、
// 响应解析与失败降级（分支未知 → null，不假报）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/services/git_service.dart';

void main() {
  // ConnectionManager 单例构造依赖 WidgetsBinding
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    GitService.debugRequester = null;
    GitService.instance.currentBranch.value = null;
  });

  test('x/git/status 请求参数与解析：branch 写入 currentBranch', () async {
    String? capturedMethod;
    Map<String, dynamic>? capturedParams;
    GitService.debugRequester = (method, [params]) async {
      capturedMethod = method;
      capturedParams = params;
      return {'branch': 'feat/zcode-remote-integration', 'dirty': 3};
    };

    await GitService.instance.refreshBranch('E:/ai/wzxClaw');

    expect(capturedMethod, 'x/git/status');
    expect(capturedParams, {'path': 'E:/ai/wzxClaw'});
    expect(GitService.instance.currentBranch.value,
        'feat/zcode-remote-integration',);
  });

  test('拉取失败/空 branch → currentBranch 降级为 null，不抛出', () async {
    GitService.debugRequester = (method, [params]) async =>
        throw StateError('未连接桌面');
    await GitService.instance.refreshBranch('/some/path');
    expect(GitService.instance.currentBranch.value, isNull);

    // 非 git 仓库：companion 回空 branch，同样降级为 null
    GitService.debugRequester = (method, [params]) async => {'branch': '', 'dirty': 0};
    await GitService.instance.refreshBranch('/some/path');
    expect(GitService.instance.currentBranch.value, isNull);

    // 空路径直接短路，不发请求
    var called = false;
    GitService.debugRequester = (method, [params]) async {
      called = true;
      return {'branch': 'x', 'dirty': 0};
    };
    await GitService.instance.refreshBranch(null);
    expect(called, isFalse);
    expect(GitService.instance.currentBranch.value, isNull);
  });

  test('x/git/branches 解析 branches 列表；checkout 传 create 仅在新建时', () async {
    final methods = <String>[];
    final paramsList = <Map<String, dynamic>?>[];
    GitService.debugRequester = (method, [params]) async {
      methods.add(method);
      paramsList.add(params);
      if (method == 'x/git/branches') {
        return {'branches': [
          {'name': 'main', 'current': true},
          {'name': 'dev', 'current': false},
        ],};
      }
      return {'ok': true, 'branch': 'dev'};
    };

    final list = await GitService.instance.branches('/repo');
    expect(list.map((b) => b.name), ['main', 'dev']);
    expect(list.first.current, isTrue);
    expect(list.last.current, isFalse);

    await GitService.instance.checkout('/repo', 'dev');
    await GitService.instance.checkout('/repo', 'feat/x', create: true);

    expect(methods, ['x/git/branches', 'x/git/checkout', 'x/git/checkout']);
    expect(paramsList[0], {'path': '/repo'});
    expect(paramsList[1], {'path': '/repo', 'branch': 'dev'});
    expect(paramsList[2], {'path': '/repo', 'branch': 'feat/x', 'create': true});
  });

  test('ConnectionManager.zcodeRequest 未连接时抛 StateError', () async {
    // 生产单例在本测试进程中未建立连接
    expect(
      () => ConnectionManager.instance.zcodeRequest('x/git/status'),
      throwsA(isA<StateError>()),
    );
  });
}
