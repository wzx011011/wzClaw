// ============================================================
// ConnectionManager 建连竞态回归测试
//
// 背景（2026-09-16 线上事故）：connectFromSavedConfiguration 在 await
// 配对存储的窗口内，并发触发（回前台双触发、点按桌面切换）会双双通过
// 入口守卫，后完成者把先完成者刚建的 client 无 close 覆盖——泄漏的旧
// 连接把同一份推送流重复投进消息流（会话正文交错重复渲染），且其
// socket 持续占用 relay 的 probe 槽（默认 3 个），重连风暴下打满即
// 触发 CAPACITY 拒绝（手机端报「中继拒绝（CAPACITY）：Request rejected」）。
// ============================================================

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
// stream_channel 是 web_socket_channel 的传递依赖；测试 fake 需要
// 其中的 StreamChannelMixin / StreamChannel 类型，故显式忽略依赖引用 lint
// ignore: depend_on_referenced_packages
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/services/pairing_store.dart';
import 'package:wzxclaw_android/zcode/zcode_pairing.dart';

/// 最小测试通道：工厂即时建连成功；记录客户端是否关闭过 sink
class FakeChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamChannelController<dynamic> _controller =
      StreamChannelController<dynamic>(sync: true, allowForeignErrors: false);

  final Completer<void> _ready = Completer<void>()..complete();

  bool clientClosedSink = false;

  /// 服务端视角的通道（本测试不扮演服务端，仅暴露给需要时观测）
  StreamChannel<dynamic> get serverSide => _controller.foreign;

  @override
  Stream<dynamic> get stream => _controller.local.stream;

  @override
  WebSocketSink get sink => _CountingSink(_controller.local.sink,
      () => clientClosedSink = true,);

  @override
  Future<void> get ready => _ready.future;

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;
}

class _CountingSink implements WebSocketSink {
  _CountingSink(this._inner, this._onClose);
  final StreamSink<dynamic> _inner;
  final void Function() _onClose;

  @override
  void add(dynamic event) => _inner.add(event);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _inner.addError(error, stackTrace);

  @override
  Future addStream(Stream<dynamic> stream) => _inner.addStream(stream);

  @override
  Future close([int? closeCode, String? closeReason]) {
    _onClose();
    return _inner.close();
  }

  @override
  Future get done => _inner.done;
}

const _pairingA = ZcodePairingInfo(
  relayWsUrl: 'wss://zcode.5945.top/ws',
  sid: 'sid-A',
  hash: 'hash-A',
);
const _pairingB = ZcodePairingInfo(
  relayWsUrl: 'wss://zcode.5945.top/ws',
  sid: 'sid-B',
  hash: 'hash-A',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    PairingStore.resetForTest();
  });

  tearDown(() {
    ConnectionManager.debugSocketFactory = null;
  });

  Future<List<FakeChannel>> installFactory() async {
    final channels = <FakeChannel>[];
    ConnectionManager.debugSocketFactory = (uri) {
      final channel = FakeChannel();
      channels.add(channel);
      return channel;
    };
    return channels;
  }

  test('并发两次 connectFromSavedConfiguration 只建一条连接（竞态不再泄漏 client）', () async {
    await PairingStore.instance.upsert(_pairingA);
    final channels = await installFactory();
    final cm = ConnectionManager.createForTest();

    await Future.wait([
      cm.connectFromSavedConfiguration(),
      cm.connectFromSavedConfiguration(),
    ]);

    expect(channels, hasLength(1));
  });

  test('点按切换覆盖旧连接：旧 client 被防御性关闭，不再无覆盖泄漏', () async {
    await PairingStore.instance.upsert(_pairingA);
    await PairingStore.instance.upsert(_pairingB);
    final channels = await installFactory();
    final cm = ConnectionManager.createForTest();

    await cm.connectFromSavedConfiguration(); // 连上活动配对 sid-A
    expect(channels, hasLength(1));

    final switched = await cm.connectToStored('sid-B'); // 用户点按另一台桌面
    expect(switched, isTrue);
    expect(channels, hasLength(2));
    expect(channels.first.clientClosedSink, isTrue); // 旧 client 已被关闭
  });
}
