import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/app_config.dart';
import '../models/connection_state.dart';
import '../models/desktop_info.dart';
import '../models/ws_message.dart';

/// Singleton WebSocket connection manager for wzxClaw Android.
///
/// Manages a single WebSocket connection to the wzxClaw desktop IDE with:
/// - Connection state machine (disconnected/connecting/connected/reconnecting)
/// - Application-level heartbeat (ping/pong) with timeout detection
/// - Idle monitor (force-reconnect after 60s of no messages)
/// - Exponential backoff reconnection with jitter
/// - Send queue that buffers messages during disconnection
/// - App lifecycle handling (pause stops heartbeat, resume force-reconnects)
/// - Connection sequence guard to prevent stale callback processing
///
/// This is the sole owner of the WebSocket connection. All pages subscribe
/// to [stateStream] and [messageStream] but never create connections directly.
class ConnectionManager with WidgetsBindingObserver {
  // -- Singleton --
  static final ConnectionManager _instance = ConnectionManager._();
  static ConnectionManager get instance => _instance;
  ConnectionManager._() {
    WidgetsBinding.instance.addObserver(this);
  }

  // -- Public state streams --
  final StreamController<WsConnectionState> _stateController =
      StreamController<WsConnectionState>.broadcast();
  Stream<WsConnectionState> get stateStream => _stateController.stream;

  final StreamController<WsMessage> _messageController =
      StreamController<WsMessage>.broadcast();
  Stream<WsMessage> get messageStream => _messageController.stream;

  // -- Last error stream --
  String? _lastError;
  String? get lastError => _lastError;
  final StreamController<String?> _errorController =
      StreamController<String?>.broadcast();
  Stream<String?> get errorStream => _errorController.stream;

  // -- Desktop list (multi-desktop support) --
  final List<DesktopInfo> _desktops = [];
  List<DesktopInfo> get desktops => List.unmodifiable(_desktops);
  final StreamController<List<DesktopInfo>> _desktopsController =
      StreamController<List<DesktopInfo>>.broadcast();
  Stream<List<DesktopInfo>> get desktopsStream => _desktopsController.stream;

  // -- Selected desktop for routing --
  String? _selectedDesktopId;
  String? get selectedDesktopId => _selectedDesktopId;
  final StreamController<String?> _selectedDesktopIdController =
      StreamController<String?>.broadcast();
  Stream<String?> get selectedDesktopIdStream => _selectedDesktopIdController.stream;

  // -- Backward-compatible convenience getters --
  bool get desktopOnline => _desktops.isNotEmpty;
  Stream<bool> get desktopOnlineStream =>
      _desktopsController.stream.map((list) => list.isNotEmpty);
  String? get desktopIdentity {
    if (_selectedDesktopId != null) {
      final match = _desktops.where((d) => d.desktopId == _selectedDesktopId);
      if (match.isNotEmpty) return match.first.displayLabel;
    }
    return _desktops.isNotEmpty ? _desktops.first.displayLabel : null;
  }
  Stream<String?> get desktopIdentityStream =>
      _desktopsController.stream.map((_) => desktopIdentity);

  // -- Internal state --
  WsConnectionState _state = WsConnectionState.disconnected;
  WsConnectionState get state => _state;

  WebSocketChannel? _channel;
  String? _url;
  int _reconnectAttempt = 0;

  // Timers
  Timer? _heartbeatTimer;
  Timer? _heartbeatTimeoutTimer;
  Timer? _idleTimer;
  Timer? _reconnectTimer;

  DateTime? _lastMessageTime;

  /// Connection sequence number -- incremented on each new connect() call.
  /// Stale stream listeners check this value and bail out if it doesn't match.
  int _connSeq = 0;

  /// Send queue -- holds prioritized messages queued during disconnection.
  /// Higher priority values are sent first when the queue flushes.
  final List<_QueueEntry> _sendQueue = [];

  /// Tracks whether we are expecting a pong (heartbeat sent, awaiting reply).
  bool _waitingForPong = false;

  /// Set to true when the app enters [AppLifecycleState.paused].
  /// Used to skip the reconnect probe when only [inactive] was triggered.
  bool _wasPaused = false;

  // ============================================================
  // Public API
  // ============================================================

  /// Connect to the given WebSocket URL.
  ///
  /// [url] should be like `ws://192.168.1.100:3000/?token=xxx`.
  /// If already connected or connecting, this will force-close the old
  /// connection first (via disconnect), then open a fresh one.
  void connect(String url) {
    // If there is an existing connection, tear it down first.
    if (_state != WsConnectionState.disconnected) {
      disconnect();
    }

    _url = url;
    final seq = ++_connSeq;

    _setState(WsConnectionState.connecting);
    print('[ConnectionManager] connecting to: $url');

    try {
      // Extract token from URL for Sec-WebSocket-Protocol header.
      final uri = Uri.parse(url);
      final token = uri.queryParameters['token'] ?? '';
      final protocols = token.isNotEmpty ? ['wzxclaw-$token'] : <String>[];

      _channel = IOWebSocketChannel.connect(
        uri,
        protocols: protocols,
      );
    } catch (e) {
      // Invalid URL or connection failure -- schedule reconnect.
      print('[ConnectionManager] connect error: $e');
      _setError('连接失败: $e');
      _scheduleReconnect();
      return;
    }

    _channel!.stream.listen(
      (data) {
        if (seq != _connSeq) return; // stale connection, ignore
        _onMessage(data);
      },
      onDone: () {
        if (seq != _connSeq) return;
        _onChannelDone();
      },
      onError: (error) {
        if (seq != _connSeq) return;
        _onChannelError(error);
      },
    );

    // Mark connected when WebSocket handshake completes.
    // Do not wait for a message -- relay does not send anything on connect.
    _channel!.ready.then((_) {
      if (seq == _connSeq && _state == WsConnectionState.connecting) {
        _setError(null); // Clear error on successful connection
        _setState(WsConnectionState.connected);
        _startHeartbeat();
        _startIdleMonitor();
        _flushQueue();
        // Announce mobile identity to desktop with device details
        _rawSend(jsonEncode({
          'event': WsEvents.identityMobileAnnounce,
          'data': {
            'name': 'wzxClaw Android',
            'platform': 'android',
            'osVersion': Platform.operatingSystemVersion,
            'appVersion': '2.0',
          },
        }),);
      }
    }).catchError((error) {
      if (seq == _connSeq) {
        _setError('握手失败: $error');
        _onChannelError(error);
      }
    });
  }

  /// Clean disconnect.
  void disconnect() {
    _cancelAllTimers();
    _sendQueue.clear();
    _waitingForPong = false;
    _desktops.clear();
    _desktopsController.add([]);
    _selectedDesktopId = null;
    _selectedDesktopIdController.add(null);

    if (_channel != null) {
      try {
        _channel!.sink.close(1000, 'client disconnect');
      } catch (_) {
        // Channel may already be closed.
      }
      _channel = null;
    }

    _setState(WsConnectionState.disconnected);
  }

  /// Send a message over the WebSocket.
  ///
  /// If connected and heartbeat is healthy, sends immediately.
  /// Otherwise, queues the message for delivery on reconnect.
  /// [priority] controls send order when flushing (higher = sent first).
  void send(WsMessage message, {int priority = 0}) {
    final json = message.toJsonString();

    if (_state == WsConnectionState.connected && !_waitingForPong) {
      _rawSend(json);
    } else {
      if (_sendQueue.length >= AppConfig.maxQueueSize) {
        // Evict lowest priority entry (queue is sorted desc, last is lowest).
        _sendQueue.removeLast();
      }
      // Insert maintaining sort order (descending priority).
      final entry = _QueueEntry(json, priority);
      final idx = _sendQueue.indexWhere((e) => e.priority < priority);
      if (idx == -1) {
        _sendQueue.add(entry);
      } else {
        _sendQueue.insert(idx, entry);
      }
    }
  }

  /// Select a specific desktop for message routing.
  /// Pass null to broadcast to all desktops.
  /// If not connected, stores the selection to be sent on reconnect.
  void selectDesktop(String? desktopId) {
    // Always store the selection so it can be sent after reconnect.
    _selectedDesktopId = desktopId;
    _selectedDesktopIdController.add(desktopId);

    if (_state != WsConnectionState.connected) return;

    if (desktopId == null) {
      _rawSend(jsonEncode({'event': WsEvents.targetClear}));
    } else {
      _rawSend(jsonEncode({
        'event': WsEvents.targetSelect,
        'data': {'desktopId': desktopId},
      }));
    }
  }

  void _selectDesktop(String desktopId) {
    _selectedDesktopId = desktopId;
    _selectedDesktopIdController.add(desktopId);
    _rawSend(jsonEncode({
      'event': WsEvents.targetSelect,
      'data': {'desktopId': desktopId},
    }));
  }

  // ============================================================
  // Lifecycle handling (WidgetsBindingObserver)
  // ============================================================

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    switch (lifecycleState) {
      case AppLifecycleState.paused:
        // Full background — heartbeat timers are useless, stop them.
        _wasPaused = true;
        _stopHeartbeat();
        _stopIdleMonitor();
        break;

      case AppLifecycleState.inactive:
        // Transient state (notification shade, volume overlay, etc.).
        // Reset _wasPaused here too — some Android transitions skip resumed
        // and go paused → inactive directly when returning to foreground.
        // Only force-reconnect if the connection was actually lost.
        if (_wasPaused) {
          _wasPaused = false;
          if (_url != null && _state != WsConnectionState.connected) {
            _resumeCheck();
          }
        }
        break;

      case AppLifecycleState.resumed:
        // Only act if the app was truly backgrounded (paused), not just
        // briefly inactive.  This prevents constant reconnect flicker.
        if (_wasPaused) {
          _wasPaused = false;
          if (_url != null && _state != WsConnectionState.connected) {
            _resumeCheck();
          }
        }
        break;

      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        break;
    }
  }

  /// Quick-reconnect on app resume.  After backgrounding, the relay server
  /// likely already dropped us, so skip the probe and reconnect immediately.
  /// Reset backoff counter so reconnection starts with minimal delay.
  void _resumeCheck() {
    _reconnectAttempt = 0;
    _forceReconnect('app resumed from pause');
  }

  // ============================================================
  // Message handling
  // ============================================================

  void _onMessage(dynamic data) {
    if (data is! String) return; // ignore binary frames

    try {
      final json = jsonDecode(data) as Map<String, dynamic>;
      final event = json['event'] as String? ?? '';
      _lastMessageTime = DateTime.now();

      if (event == WsEvents.pong) {
        // Pong received -- connection is verified bidirectional.
        // Reset backoff only after real proof the connection works.
        _waitingForPong = false;
        _heartbeatTimeoutTimer?.cancel();
        _reconnectAttempt = 0;
        return;
      }

      // Handle desktop identity announcement (forwarded by relay)
      if (event == WsEvents.identityAnnounce) {
        // The relay already tracks identity; we rely on system:desktop_list
        // but also update from direct announcements for backward compat.
        final d = json['data'];
        if (d is Map<String, dynamic>) {
          final name = d['name'] as String? ?? 'wzxClaw';
          // Update matching desktop's name if we have one
          if (_desktops.length == 1) {
            _desktops[0] = DesktopInfo(
              desktopId: _desktops[0].desktopId,
              name: name,
              platform: _desktops[0].platform,
              connectedAt: _desktops[0].connectedAt,
            );
            _desktopsController.add(List.from(_desktops));
          }
        }
        return;
      }

      // System events from relay — don't broadcast to chat
      if (event.startsWith('system:')) {
        if (event == WsEvents.systemDesktopList) {
          // Full desktop list update from relay.
          final list = (json['data'] as Map<String, dynamic>?)?['desktops'] as List<dynamic>? ?? [];
          final newDesktops = <DesktopInfo>[];
          for (final item in list) {
            if (item is Map<String, dynamic>) {
              newDesktops.add(DesktopInfo.fromJson(item));
            }
          }
          // Only notify if the list actually changed to avoid flicker.
          if (_desktops.length != newDesktops.length ||
              !_desktops.every((d) => newDesktops.any((n) => n.desktopId == d.desktopId))) {
            _desktops
              ..clear()
              ..addAll(newDesktops);
            _desktopsController.add(List.from(_desktops));
          }
          // Auto-select if only one desktop and nothing selected.
          if (_selectedDesktopId == null && _desktops.length == 1) {
            _selectDesktop(_desktops.first.desktopId);
          }
          // Clear selection if selected desktop is gone.
          if (_selectedDesktopId != null && !_desktops.any((d) => d.desktopId == _selectedDesktopId)) {
            _selectedDesktopId = null;
            _selectedDesktopIdController.add(null);
          }
        } else if (event == WsEvents.systemDesktopConnected) {
          // Enriched event with desktopId.
          final d = json['data'] as Map<String, dynamic>?;
          final desktopId = d?['desktopId'] as String?;
          if (desktopId != null && !_desktops.any((e) => e.desktopId == desktopId)) {
            _desktops.add(DesktopInfo(
              desktopId: desktopId,
              name: d?['name'] as String?,
              platform: d?['platform'] as String?,
              connectedAt: DateTime.now().millisecondsSinceEpoch,
            ));
            _desktopsController.add(List.from(_desktops));
          }
          if (_selectedDesktopId == null && _desktops.length == 1) {
            _selectDesktop(_desktops.first.desktopId);
          }
        } else if (event == WsEvents.systemDesktopDisconnected) {
          final d = json['data'] as Map<String, dynamic>?;
          final desktopId = d?['desktopId'] as String?;
          if (desktopId != null) {
            _desktops.removeWhere((e) => e.desktopId == desktopId);
            _desktopsController.add(List.from(_desktops));
            if (_selectedDesktopId == desktopId) {
              _selectedDesktopId = null;
              _selectedDesktopIdController.add(null);
            }
          }
        } else if (event == WsEvents.systemTargetConfirmed) {
          final d = json['data'] as Map<String, dynamic>?;
          final confirmedId = d?['desktopId'] as String?;
          if (confirmedId != _selectedDesktopId) {
            _selectedDesktopId = confirmedId;
            _selectedDesktopIdController.add(confirmedId);
          }
        }
        return;
      }

      // Broadcast all other messages to subscribers.
      final message = WsMessage.fromJson(json);
      _messageController.add(message);
    } catch (_) {
      // Malformed JSON -- ignore silently (T-01-02 mitigation).
      // Do not crash on invalid data.
    }
  }

  // ============================================================
  // Heartbeat
  // ============================================================

  void _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = Timer.periodic(AppConfig.heartbeatInterval, (_) {
      if (_state != WsConnectionState.connected) return;

      // Send application-level ping.
      _waitingForPong = true;
      _rawSend(jsonEncode({'event': WsEvents.ping}));

      // Start timeout -- if no pong within 8 seconds, connection is dead.
      _heartbeatTimeoutTimer = Timer(AppConfig.heartbeatTimeout, () {
        if (_waitingForPong) {
          _forceReconnect('heartbeat timeout');
        }
      });
    });
  }

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _heartbeatTimeoutTimer?.cancel();
    _heartbeatTimeoutTimer = null;
    _waitingForPong = false;
  }

  // ============================================================
  // Idle monitor
  // ============================================================

  void _startIdleMonitor() {
    _stopIdleMonitor();
    _lastMessageTime = DateTime.now();

    // Check every 10 seconds whether the connection has gone idle.
    _idleTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_state != WsConnectionState.connected) return;
      if (_lastMessageTime == null) return;

      final elapsed = DateTime.now().difference(_lastMessageTime!);
      if (elapsed > AppConfig.maxIdleTime) {
        _forceReconnect('idle timeout (${elapsed.inSeconds}s)');
      }
    });
  }

  void _stopIdleMonitor() {
    _idleTimer?.cancel();
    _idleTimer = null;
  }

  // ============================================================
  // Reconnection
  // ============================================================

  void _forceReconnect(String reason) {
    // Cancel all timers first.
    _cancelAllTimers();

    // Clear desktop state -- stale after reconnect.
    _desktops.clear();
    _desktopsController.add([]);
    _selectedDesktopId = null;
    _selectedDesktopIdController.add(null);

    // Increment sequence to invalidate stale onDone/onError callbacks
    // from the channel we are about to close.
    _connSeq++;

    // Close the channel with an abnormal close code.
    if (_channel != null) {
      try {
        _channel!.sink.close(4000, reason);
      } catch (_) {
        // Channel may already be closed.
      }
      _channel = null;
    }

    _setState(WsConnectionState.reconnecting);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();

    // Exponential backoff: min(30s, base * 2^attempt) + jitter(0-500ms)
    final baseMs = AppConfig.reconnectBaseDelay.inMilliseconds;
    final maxMs = AppConfig.reconnectMaxDelay.inMilliseconds;
    final delayMs = (baseMs * (1 << _reconnectAttempt)).clamp(0, maxMs);
    final jitter = Random().nextInt(AppConfig.jitterMaxMs);
    final totalDelay = Duration(milliseconds: delayMs + jitter);

    _reconnectAttempt++;

    _reconnectTimer = Timer(totalDelay, () {
      if (_url != null) {
        connect(_url!);
      }
    });

    if (_state != WsConnectionState.disconnected) {
      _setState(WsConnectionState.reconnecting);
    }
  }

  // ============================================================
  // Channel events
  // ============================================================

  void _onChannelDone() {
    _stopHeartbeat();
    _stopIdleMonitor();

    if (_state != WsConnectionState.disconnected) {
      // Not an intentional disconnect -- schedule reconnect.
      _setState(WsConnectionState.reconnecting);
      _scheduleReconnect();
    }
  }

  void _onChannelError(Object error) {
    print('[ConnectionManager] channel error: $error');
    _stopHeartbeat();
    _stopIdleMonitor();
    _setError('$error');

    if (_state != WsConnectionState.disconnected) {
      _setState(WsConnectionState.reconnecting);
      _scheduleReconnect();
    }
  }

  // ============================================================
  // Send queue
  // ============================================================

  void _flushQueue() {
    // Send highest priority first (queue is already sorted descending).
    _sendQueue.sort((a, b) => b.priority.compareTo(a.priority));
    while (_sendQueue.isNotEmpty) {
      final entry = _sendQueue.removeAt(0);
      _rawSend(entry.json);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  void _setState(WsConnectionState newState) {
    if (_state == newState) return;
    _state = newState;
    _stateController.add(newState);
  }

  void _setError(String? error) {
    _lastError = error;
    _errorController.add(error);
  }

  void _rawSend(String json) {
    if (_channel != null) {
      try {
        _channel!.sink.add(json);
      } catch (_) {
        // Channel might be closed -- ignore.
      }
    }
  }

  void _cancelAllTimers() {
    _stopHeartbeat();
    _stopIdleMonitor();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  // ============================================================
  // Cleanup (call when app is shutting down)
  // ============================================================

  /// Dispose all resources. Call only when the app is being destroyed.
  void dispose() {
    disconnect();
    WidgetsBinding.instance.removeObserver(this);
    _stateController.close();
    _messageController.close();
    _errorController.close();
    _desktopsController.close();
    _selectedDesktopIdController.close();
  }
}

/// Internal send-queue entry with priority support.
class _QueueEntry {
  final String json;
  final int priority;
  const _QueueEntry(this.json, this.priority);
}
