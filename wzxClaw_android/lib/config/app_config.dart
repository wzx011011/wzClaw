/// Application configuration constants for wzxClaw Android.
///
/// These values control WebSocket connection behavior:
/// heartbeat timing, reconnection backoff, and send queue limits.
class AppConfig {
  AppConfig._();

  // -- Heartbeat --
  /// Client sends application-level ping every 15 seconds.
  static const Duration heartbeatInterval = Duration(seconds: 15);

  /// If no pong arrives within 8 seconds of sending a ping,
  /// the connection is considered dead.
  static const Duration heartbeatTimeout = Duration(seconds: 8);

  // -- Idle monitor --
  /// If no message of any kind is received for 60 seconds,
  /// force a reconnect (secondary guard against silent stalls).
  static const Duration maxIdleTime = Duration(seconds: 60);

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
