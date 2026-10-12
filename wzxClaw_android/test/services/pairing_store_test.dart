import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/services/pairing_store.dart';
import 'package:wzxclaw_android/zcode/zcode_pairing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  setUp(() {
    PairingStore.resetForTest();
  });

  test('server_url 有效值只迁移一次并删除旧键', () async {
    SharedPreferences.setMockInitialValues({
      'server_url':
          'https://zcode.5945.top/pair?sid=legacy&hash=$hash&name=旧电脑',
    });

    final stored = await PairingStore.instance.loadAll();
    final prefs = await SharedPreferences.getInstance();

    expect(stored, hasLength(1));
    expect(stored.single.info.sid, 'legacy');
    expect(stored.single.info.desktopName, '旧电脑');
    expect(prefs.containsKey('server_url'), isFalse);
    expect(await PairingStore.instance.activeSid(), 'legacy');
  });

  test('server_url 无效值也删除且不反复迁移', () async {
    SharedPreferences.setMockInitialValues(
      {'server_url': 'not-a-pairing-link'},
    );

    expect(await PairingStore.instance.loadAll(), isEmpty);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.containsKey('server_url'), isFalse);

    PairingStore.resetForTest();
    expect(await PairingStore.instance.loadAll(), isEmpty);
  });

  test('设置活动配对不再回写 server_url', () async {
    SharedPreferences.setMockInitialValues({});
    await PairingStore.instance.upsert(
      const ZcodePairingInfo(
        relayWsUrl: 'wss://zcode.5945.top/ws',
        sid: 'desktop-1',
        hash: hash,
        desktopName: '电脑 1',
      ),
    );
    await PairingStore.instance.setActiveSid('desktop-1');

    final prefs = await SharedPreferences.getInstance();
    expect(await PairingStore.instance.activeSid(), 'desktop-1');
    expect(prefs.containsKey('server_url'), isFalse);
  });
}
