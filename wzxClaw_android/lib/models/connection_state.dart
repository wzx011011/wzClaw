/// WebSocket connection state enum.
///
/// Represents the lifecycle states of the WebSocket connection.
enum WsConnectionState {
  /// No active connection.
  disconnected,

  /// WebSocket connect in progress.
  connecting,

  /// Active, heartbeat-verified connection.
  connected,

  /// Reconnecting after disconnect (with backoff).
  reconnecting,
}

/// Extension providing Chinese labels for connection states.
extension ConnectionStateX on WsConnectionState {
  /// Human-readable Chinese label for the connection state.
  String get label {
    switch (this) {
      case WsConnectionState.disconnected:
        return '已断开';
      case WsConnectionState.connecting:
        return '连接中';
      case WsConnectionState.connected:
        return '已连接';
      case WsConnectionState.reconnecting:
        return '重连中';
    }
  }
}
