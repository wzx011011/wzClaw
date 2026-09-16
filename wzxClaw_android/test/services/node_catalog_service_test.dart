// ============================================================
// node_catalog_service — x/model/* 扩展客户端契约
//
// 钉住 companion 侧（relay/zcode/companion.js handleXMethod）实现：
// - catalog：models/default/degraded 解析；非法条目过滤；异常形状抛错
// - configure：参数透传 + ok/appliedToActive 解析；失败抛错
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/node_catalog_service.dart';

void main() {
  tearDown(() => NodeCatalogService.debugRequester = null);

  group('NodeCatalogService.modelCatalog', () {
    test('解析引擎+快照合并目录与默认模型', () async {
      NodeCatalogService.debugRequester = (method, [params]) async {
        expect(method, 'x/model/catalog');
        return {
          'models': [
            {'providerId': 'builtin:p1', 'modelId': 'glm-x', 'available': true, 'source': 'engine'},
            {'providerId': 'builtin:p1', 'modelId': 'snap-only', 'available': false, 'source': 'imported'},
            // 非法条目：缺 id / 非对象 → 必须被过滤
            {'providerId': '', 'modelId': 'x', 'available': true, 'source': 'engine'},
            'garbage',
          ],
          'default': {'providerId': 'builtin:p1', 'modelId': 'glm-x'},
          'degraded': false,
        };
      };
      final c = await NodeCatalogService.instance.modelCatalog();
      expect(c.models.length, 2);
      expect(c.models[0].available, isTrue);
      expect(c.models[0].source, 'engine');
      expect(c.models[1].source, 'imported');
      expect(c.defaultModel!.key, 'builtin:p1/glm-x');
      expect(c.degraded, isFalse);
    });

    test('无默认模型 / degraded 目录', () async {
      NodeCatalogService.debugRequester = (_, [__]) async => {
            'models': [],
            'default': null,
            'degraded': true,
          };
      final c = await NodeCatalogService.instance.modelCatalog();
      expect(c.defaultModel, isNull);
      expect(c.degraded, isTrue);
    });

    test('响应形状异常必须抛错（不做假成功）', () async {
      NodeCatalogService.debugRequester = (_, [__]) async => 'not-a-map';
      expect(() => NodeCatalogService.instance.modelCatalog(),
          throwsStateError,);
    });
  });

  group('NodeCatalogService.configureDefault', () {
    test('参数透传 + 结果解析', () async {
      Map<String, dynamic>? captured;
      NodeCatalogService.debugRequester = (method, [params]) async {
        expect(method, 'x/model/configure');
        captured = params;
        return {
          'ok': true,
          'appliedToActive': true,
          'default': {'providerId': 'p', 'modelId': 'm'},
        };
      };
      final r = await NodeCatalogService.instance
          .configureDefault(providerId: 'p', modelId: 'm');
      expect(r.appliedToActive, isTrue);
      expect(captured, {'providerId': 'p', 'modelId': 'm'});
    });

    test('ok!=true 或异常形状必须抛错', () async {
      NodeCatalogService.debugRequester = (_, [__]) async => {'ok': false};
      expect(
          () => NodeCatalogService.instance
              .configureDefault(providerId: 'p', modelId: 'm'),
          throwsStateError,);
    });
  });
}
