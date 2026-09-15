import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/services/pairing_store.dart';
import 'package:wzxclaw_android/zcode/zcode_pairing.dart';

const _hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 43A+'='

ZcodePairingInfo _info(String sid, {String? name, String hash = _hash}) =>
    ZcodePairingInfo(
      relayWsUrl: 'wss://zcode.5945.top/ws',
      sid: sid,
      hash: hash,
      desktopName: name,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    PairingStore.resetForTest();
  });

  group('PairingStore', () {
    test('空数据：loadAll 返回空列表，activeSid 为 null', () async {
      final list = await PairingStore.instance.loadAll();
      expect(list, isEmpty);
      expect(await PairingStore.instance.activeSid(), isNull);
    });

    test('旧数据迁移：server_url 配对链接 → 列表首条 + 活动位', () async {
      SharedPreferences.setMockInitialValues({
        'server_url':
            'https://zcode.5945.top/pair?sid=legacy-sid&hash=$_hash&name=PC-1',
      });
      PairingStore.resetForTest();

      final list = await PairingStore.instance.loadAll();
      expect(list.length, 1);
      expect(list.first.info.sid, 'legacy-sid');
      expect(list.first.info.hash, _hash);
      expect(list.first.info.desktopName, 'PC-1');
      expect(list.first.info.relayWsUrl, 'wss://zcode.5945.top/ws');
      expect(await PairingStore.instance.activeSid(), 'legacy-sid');
    });

    test('upsert 新增：首条自动设为活动桌面', () async {
      await PairingStore.instance.upsert(_info('sid-a', name: '桌面 A'));
      final list = await PairingStore.instance.loadAll();
      expect(list.length, 1);
      expect(list.first.info.desktopName, '桌面 A');
      expect(await PairingStore.instance.activeSid(), 'sid-a');
    });

    test('upsert 按 sid 去重：重扫刷新 hash/名称，保留原 addedAt，不产生重复', () async {
      await PairingStore.instance.upsert(_info('sid-a', name: '旧名'));
      final first = (await PairingStore.instance.loadAll()).first;

      final hashB = 'B' * 43 + '=';
      await PairingStore.instance
          .upsert(_info('sid-a', name: '新名', hash: hashB));
      final list = await PairingStore.instance.loadAll();
      expect(list.length, 1);
      expect(list.first.info.desktopName, '新名');
      expect(list.first.addedAt, first.addedAt);
      expect(list.first.info.hash, startsWith('B'));
    });

    test('upsert 不带名称时保留已存名称', () async {
      await PairingStore.instance.upsert(_info('sid-a', name: '原名'));
      await PairingStore.instance.upsert(_info('sid-a'));
      final list = await PairingStore.instance.loadAll();
      expect(list.first.info.desktopName, '原名');
    });

    test('删除活动桌面：活动位与 server_url 一并清除', () async {
      await PairingStore.instance.upsert(_info('sid-a'));
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('server_url'), isNotNull);

      await PairingStore.instance.remove('sid-a');
      expect(await PairingStore.instance.loadAll(), isEmpty);
      expect(await PairingStore.instance.activeSid(), isNull);
      expect(prefs.getString('server_url'), isNull);
    });

    test('删除非活动桌面：活动位不动', () async {
      await PairingStore.instance.upsert(_info('sid-a'));
      await PairingStore.instance.upsert(_info('sid-b'));
      expect(await PairingStore.instance.activeSid(), 'sid-a');

      await PairingStore.instance.remove('sid-b');
      final list = await PairingStore.instance.loadAll();
      expect(list.length, 1);
      expect(list.first.info.sid, 'sid-a');
      expect(await PairingStore.instance.activeSid(), 'sid-a');
    });

    test('setActiveSid：切换活动位并同步 server_url（含 name 参数）', () async {
      await PairingStore.instance.upsert(_info('sid-a', name: '桌面 A'));
      await PairingStore.instance.upsert(_info('sid-b', name: '桌面 B'));

      await PairingStore.instance.setActiveSid('sid-b');
      expect(await PairingStore.instance.activeSid(), 'sid-b');

      final prefs = await SharedPreferences.getInstance();
      final url = prefs.getString('server_url')!;
      expect(url, contains('sid=sid-b'));
      expect(url, contains('name='));
    });

    test('损坏的列表 JSON：忽略不抛错（无 server_url 时不迁移）', () async {
      SharedPreferences.setMockInitialValues({'pairing_list_v1': '{broken'});
      PairingStore.resetForTest();
      final list = await PairingStore.instance.loadAll();
      expect(list, isEmpty);
    });

    test('列表里 hash 格式非法的条目被丢弃', () async {
      SharedPreferences.setMockInitialValues({
        'pairing_list_v1':
            '[{"info":{"relayWsUrl":"wss://h/ws","sid":"s1","hash":"short"},'
            '"addedAt":1},'
            '{"info":{"relayWsUrl":"wss://h/ws","sid":"s2","hash":"$_hash"},'
            '"addedAt":2}]',
      });
      PairingStore.resetForTest();
      final list = await PairingStore.instance.loadAll();
      expect(list.length, 1);
      expect(list.first.info.sid, 's2');
    });
  });
}
