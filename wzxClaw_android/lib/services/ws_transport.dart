import 'dart:async';

import '../models/connection_state.dart';
import '../models/ws_message.dart';

/// 抽象的 WebSocket 传输层，用于解耦 [ChatStore] / [SessionSyncService]
/// 与具体的 [ConnectionManager] 实现，方便单元测试注入 fake 传输。
///
/// 生产代码使用 [ConnectionManagerTransport] 包装 [ConnectionManager.instance]；
/// 测试代码使用 `FakeWsTransport`（参见 test/harness/sync_harness.dart）。
abstract class WsTransport {
  /// 入站消息流（已解析为 [WsMessage]）。多订阅者安全（broadcast）。
  Stream<WsMessage> get incoming;

  /// 连接状态流。
  Stream<WsConnectionState> get stateStream;

  /// 当前连接状态（同步）。
  WsConnectionState get state;

  /// 当前选中的桌面端 ID（多桌面路由场景下使用，可能为 null）。
  String? get selectedDesktopId;

  /// 选中桌面变化的流。
  Stream<String?> get selectedDesktopIdStream;

  /// 发送一条 WS 消息。[priority] 越大越优先（用于断线时排队）。
  void send(WsMessage message, {int priority = 0});
}
