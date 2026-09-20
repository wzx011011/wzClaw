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

  test('modelCatalog 解析 reasoning 档位（实测形状 {levels:[{value,label}]}）',
      () async {
    NodeCatalogService.debugRequester = (method, [params]) async {
      expect(method, 'x/model/catalog');
      return {
        'models': [
          {
            'providerId': 'imported:codex:abc',
            'modelId': 'gpt-5.6-sol',
            'available': true,
            'source': 'engine',
            'label': 'GPT-5.6 Sol',
            'vision': true,
            'reasoning': {
              'levels': [
                {'value': 'low', 'label': 'low'},
                {'value': 'high', 'label': 'high'},
              ],
              'defaultLevel': 'high',
            },
          },
          {
            'providerId': 'builtin:p1',
            'modelId': 'glm-mini',
            'available': true,
            'source': 'engine',
          },
          {
            // 容错：字符串项直取、对象项取 value；defaultLevel 不在档位
            // 表时回退首个
            'providerId': 'builtin:p1',
            'modelId': 'glm-mixed',
            'available': true,
            'source': 'engine',
            'reasoning': {
              'levels': ['low', {'value': 'max', 'label': 'max'}],
              'defaultLevel': 'nope',
            },
          },
        ],
        'default': null,
        'degraded': false,
      };
    };

    final catalog = await NodeCatalogService.instance.modelCatalog();
    final sol = catalog.models[0];
    expect(sol.reasoningLevels, ['low', 'high']);
    expect(sol.reasoningDefaultLevel, 'high');
    expect(sol.reasoningLevelForRequest, 'high');
    expect(sol.vision, isTrue);

    final mini = catalog.models[1];
    expect(mini.reasoningLevels, isEmpty);
    expect(mini.reasoningLevelForRequest, isNull);

    final mixed = catalog.models[2];
    expect(mixed.reasoningLevels, ['low', 'max']);
    expect(mixed.reasoningLevelForRequest, 'low');
  });

  test('configureDefault 透传 reasoningLevel（imported 模型 setModel 必填）',
      () async {
    Map<String, dynamic>? captured;
    NodeCatalogService.debugRequester = (method, [params]) async {
      expect(method, 'x/model/configure');
      captured = params;
      return {'ok': true, 'appliedToActive': false};
    };

    await NodeCatalogService.instance.configureDefault(
      providerId: 'imported:codex:abc',
      modelId: 'gpt-5.6-sol',
      reasoningLevel: 'high',
    );
    expect(captured, {
      'providerId': 'imported:codex:abc',
      'modelId': 'gpt-5.6-sol',
      'reasoningLevel': 'high',
    });
  });
}
