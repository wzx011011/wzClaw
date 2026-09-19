import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/node_catalog_service.dart';

void main() {
  tearDown(() {
    NodeCatalogService.debugRequester = null;
  });

  test('importedWorkspaces 解析、去空白并去重', () async {
    NodeCatalogService.debugRequester = (method, [params]) async {
      expect(method, 'x/workspaces/list');
      expect(params, isNull);
      return {
        'workspaces': [' C:/work/a ', 'C:/work/a', '', 7, 'D:/work/b'],
        'importedAt': '2026-09-17T00:00:00.000Z',
      };
    };

    expect(
      await NodeCatalogService.instance.importedWorkspaces(),
      ['C:/work/a', 'D:/work/b'],
    );
  });

  test('importedWorkspaces 对异常响应显式失败', () async {
    NodeCatalogService.debugRequester = (method, [params]) async => 'bad';

    expect(
      NodeCatalogService.instance.importedWorkspaces(),
      throwsA(isA<StateError>()),
    );
  });
}
