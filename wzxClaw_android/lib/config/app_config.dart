/// Application configuration constants for wzxClaw Android.
///
/// These values control WebSocket connection behavior:
/// heartbeat timing, reconnection backoff, and send queue limits.
class AppConfig {
  AppConfig._();

  // -- Heartbeat --
  /// Client sends application-level ping every 30 seconds.
  /// Aligned with the relay server's own WS-level health check interval (30s)
  /// to reduce send-queue blocking frequency.
  static const Duration heartbeatInterval = Duration(seconds: 30);

  /// If no pong arrives within 20 seconds of sending a ping,
  /// the connection is considered dead.
  /// Generous timeout for mobile networks (4G/5G + home NAS upstream latency).
  static const Duration heartbeatTimeout = Duration(seconds: 20);

  // -- Idle monitor --
  /// If no message of any kind is received for 90 seconds,
  /// force a reconnect (secondary guard against silent stalls).
  /// 90s provides a 3-heartbeat-cycle buffer (3 × 30s) before triggering.
  static const Duration maxIdleTime = Duration(seconds: 90);

  // -- Reconnection backoff --
  /// Exponential backoff starts at 1 second.
  static const Duration reconnectBaseDelay = Duration(seconds: 1);

  /// Exponential backoff caps at 30 seconds.
  static const Duration reconnectMaxDelay = Duration(seconds: 30);

  /// Random jitter 0-500ms added to backoff delay.
  static const int jitterMaxMs = 500;

  // -- Send queue --
  /// Maximum messages held in the send queue during disconnection.
  static const int maxQueueSize = 200;
}
