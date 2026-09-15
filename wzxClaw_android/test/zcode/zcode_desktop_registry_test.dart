// ============================================================
// zcode_desktop_registry_test — 多桌面注册表单元测试
//
// 覆盖：临时实例兜底、添加/去重/切换/删除、持久化 roundtrip、
// 旧版单配对迁移、instance 指针跟随活动桌面。
// store 一律经 storeFactory 注入 FakeZcodeRelayClient，不触网。
// ============================================================

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_desktop_registry.dart';

import 'zcode_test_fakes.dart';

String _hash() => base64.encode(List<int>.filled(32, 0xAB));

String _pairUrl(String sid, {String? name}) {
  final nameParam = name == null ? '' : '&name=${Uri.encodeComponent(name)}';
  return 'https://zcode.5945.top/pair?sid=$sid&hash=${_hash()}$nameParam';
}

ZcodeChatStore _fakeStore() =>
    pairedStore(FakeZcodeRelayClient());

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    ZcodeDesktopRegistry.instance
      ..resetForTest()
      ..storeFactory = (_) => _fakeStore();
  });

  group('ZcodeDesktopRegistry', () {
    test('无桌面时 activeStore 为临时实例（页面配对门可渲染）', () {
      final registry = ZcodeDesktopRegistry.instance;
      expect(registry.entries, isEmpty);
      expect(registry.activeStore.desktopId, '__provisional__');
      expect(identical(ZcodeChatStore.instance, registry.activeStore), isTrue);
    });

    test('addFromPairingUrl：创建条目、置活动、默认名取 URL name 参数', () async {
      final registry = ZcodeDesktopRegistry.instance;
      final ok =
          await registry.addFromPairingUrl(_pairUrl('sid-A', name: 'MY-PC'));
      expect(ok, isTrue);
      expect(registry.entries.length, 1);
      expect(registry.activeId, 'sid-A');
      expect(registry.activeStore.desktopName, 'MY-PC');
      expect(registry.activeStore.desktopId, 'sid-A');
      // 临时实例让位：instance 不再指向临时
      expect(registry.activeStore.desktopId, isNot('__provisional__'));
    });

    test('同 sid 重复添加视为同一桌面（替换不重复）', () async {
      final registry = ZcodeDesktopRegistry.instance;
      await registry.addFromPairingUrl(_pairUrl('sid-A'));
      await registry.addFromPairingUrl(_pairUrl('sid-A', name: '改名'));
      expect(registry.entries.length, 1);
      expect(registry.activeStore.desktopName, '改名');
    });

    test('多桌面切换与持久化 roundtrip', () async {
      final registry = ZcodeDesktopRegistry.instance;
      await registry.addFromPairingUrl(_pairUrl('sid-A', name: 'A'));
      await registry.addFromPairingUrl(_pairUrl('sid-B', name: 'B'));
      expect(registry.entries.length, 2);
      expect(registry.activeId, 'sid-B'); // 后添加者成为活动

      registry.setActive('sid-A');
      expect(registry.activeStore.desktopName, 'A');

      // 持久化已写入：模拟冷启动（清内存态 + 重新 restore）
      final raw = (await SharedPreferences.getInstance())
          .getString('wzxclaw-zcode-desktops');
      expect(raw, isNotNull);
      final saved = jsonDecode(raw!) as List;
      expect(saved.length, 2);
      expect(
        (await SharedPreferences.getInstance())
            .getString('wzxclaw-zcode-active'),
        'sid-A',
      );

      registry.resetForTest();
      await registry.restore();
      expect(registry.entries.length, 2);
      expect(registry.activeId, 'sid-A');
      expect(registry.activeStore.desktopName, 'A');
    });

    test('remove：删除活动桌面自动落到剩余第一个；清空回到临时实例', () async {
      final registry = ZcodeDesktopRegistry.instance;
      await registry.addFromPairingUrl(_pairUrl('sid-A', name: 'A'));
      await registry.addFromPairingUrl(_pairUrl('sid-B', name: 'B'));
      registry.setActive('sid-A');

      await registry.remove('sid-A');
      expect(registry.entries.length, 1);
      expect(registry.activeId, 'sid-B');

      await registry.remove('sid-B');
      expect(registry.entries, isEmpty);
      expect(registry.activeStore.desktopId, '__provisional__');
    });

    test('旧版单配对迁移：legacy 键导入为第一个桌面', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'wzxclaw-zcode-pairing': jsonEncode({
          'relayWsUrl': 'wss://zcode.5945.top/ws',
          'sid': 'legacy-sid',
          'hash': _hash(),
        }),
      });
      final registry = ZcodeDesktopRegistry.instance;
      registry.resetForTest();
      await registry.restore();
      expect(registry.entries.length, 1);
      expect(registry.activeId, 'legacy-sid');
      expect(registry.activeStore.desktopName, '桌面');
      // 配对 URL 重组后可再次解析出同一 sid
      expect(
        registry.entries.first.pairingUrl.contains('sid=legacy-sid'),
        isTrue,
      );
    });

    test('无效配对 URL 拒绝添加', () async {
      final registry = ZcodeDesktopRegistry.instance;
      expect(
        await registry.addFromPairingUrl('https://example.com/x'),
        isFalse,
      );
      expect(registry.entries, isEmpty);
    });
  });
}
