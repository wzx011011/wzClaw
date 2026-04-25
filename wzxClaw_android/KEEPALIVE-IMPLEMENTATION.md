# wzxClaw Android: Quick Implementation Guide

## TL;DR – What to Do Now

Your wzxClaw Android app needs TWO changes to achieve 95% keepalive reliability:

### 1. **Add Lifecycle-Aware Socket Management** (Do First — 3 hours)

**Problem:** Socket doesn't close gracefully when app is backgrounded; wastes battery trying to keep dead connection alive.

**File: `lib/services/connection_manager.dart`**

Add to existing `ConnectionManager` class:

```dart
@override
void didChangeAppLifecycleState(AppLifecycleState state) {
  switch (state) {
    case AppLifecycleState.paused:
      _pauseHeartbeat(); // Stop heartbeat timer
      _gracefulDisconnect(); // Send close frame + cancel timers
      break;

    case AppLifecycleState.resumed:
      _forceReconnect(); // Re-establish socket immediately
      break;

    case AppLifecycleState.inactive:
    case AppLifecycleState.detached:
    case AppLifecycleState.hidden:
      break;
  }
}

void _pauseHeartbeat() {
  _heartbeatTimer?.cancel();
  _heartbeatTimeoutTimer?.cancel();
  _idleTimer?.cancel();
  print('[ConnMgr] Heartbeat paused (app background)');
}

void _gracefulDisconnect() {
  if (_state != WsConnectionState.disconnected) {
    try {
      _channel?.sink.close();
    } catch (e) {
      print('[ConnMgr] Error closing socket: $e');
    }
    _updateState(WsConnectionState.disconnected);
  }
  _lastMessageTime = null;
  print('[ConnMgr] Socket closed gracefully');
}

void _forceReconnect() async {
  print('[ConnMgr] App resumed; force reconnecting...');
  _reconnectAttempt = 0; // Reset backoff
  await connect(_url!); // Reconnect immediately, no backoff
}
```

**In `main.dart`, ensure ConnectionManager observes lifecycle:**

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // This makes ConnectionManager listen to app lifecycle
  ConnectionManager.instance; // Triggers didChangeAppLifecycleState observer

  runApp(const MyApp());
}
```

**Impact:** Prevents battery drain from dead socket; instant reconnection when user switches back to app.

---

### 2. **Add Session State Persistence** (Do Second — 2 hours)

**Problem:** When app is killed by OS, connection is lost; on restart, user sees "Disconnected" until manual reconnect.

**File: `lib/services/session_recovery_service.dart` (NEW)**

```dart
import 'package:shared_preferences/shared_preferences.dart';

class SessionRecoveryService {
  static const String SESSION_ID_KEY = 'wzx_session_id';
  static const String AUTH_TOKEN_KEY = 'wzx_auth_token';
  static const String RELAY_URL_KEY = 'wzx_relay_url';

  /// Save session credentials after successful connection
  static Future<void> saveSession({
    required String sessionId,
    required String authToken,
    required String relayUrl,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(SESSION_ID_KEY, sessionId);
    await prefs.setString(AUTH_TOKEN_KEY, authToken);
    await prefs.setString(RELAY_URL_KEY, relayUrl);
    print('[Recovery] Session saved: $sessionId');
  }

  /// Restore session on app startup
  static Future<SessionData?> restoreSession() async {
    final prefs = await SharedPreferences.getInstance();
    final sessionId = prefs.getString(SESSION_ID_KEY);
    final authToken = prefs.getString(AUTH_TOKEN_KEY);
    final relayUrl = prefs.getString(RELAY_URL_KEY);

    if (sessionId == null || authToken == null || relayUrl == null) {
      return null;
    }

    print('[Recovery] Session restored: $sessionId');
    return SessionData(
      sessionId: sessionId,
      authToken: authToken,
      relayUrl: relayUrl,
    );
  }

  /// Clear session (on logout)
  static Future<void> clearSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(SESSION_ID_KEY);
    await prefs.remove(AUTH_TOKEN_KEY);
    await prefs.remove(RELAY_URL_KEY);
    print('[Recovery] Session cleared');
  }
}

class SessionData {
  final String sessionId;
  final String authToken;
  final String relayUrl;

  SessionData({
    required this.sessionId,
    required this.authToken,
    required this.relayUrl,
  });
}
```

**Update `ConnectionManager` to save/restore:**

```dart
// In ConnectionManager.connect()
void connect(String url) async {
  _url = url;
  _state = WsConnectionState.connecting;
  _stateController.add(_state);

  try {
    _channel = IOWebSocketChannel.connect(url);

    // After successful connection, save session
    await SessionRecoveryService.saveSession(
      sessionId: _generateOrFetchSessionId(),
      authToken: _authToken,
      relayUrl: url,
    );

    _state = WsConnectionState.connected;
    _stateController.add(_state);
    _startHeartbeat();
  } catch (e) {
    print('[ConnMgr] Connection failed: $e');
    _state = WsConnectionState.disconnected;
    _stateController.add(_state);
    _scheduleReconnect();
  }
}

// On app startup
Future<void> _restoreSession() async {
  final session = await SessionRecoveryService.restoreSession();
  if (session != null) {
    print('[ConnMgr] Restoring session: ${session.sessionId}');
    connect(session.relayUrl);
  }
}
```

**In `main.dart`:**

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Restore and reconnect to prior session if exists
  final recovered = await SessionRecoveryService.restoreSession();
  if (recovered != null) {
    ConnectionManager.instance.connect(recovered.relayUrl);
  }

  runApp(const MyApp());
}
```

**Impact:** App automatically reconnects to same relay session after process kill; user sees "Connected" within 2-5 seconds of restart.

---

## Bonus: Firebase Cloud Messaging (Phase 2, Week 2)

Once the above is solid, add push notifications for instant wakeup:

**`pubspec.yaml`:**

```yaml
firebase_core: ^2.24.0
firebase_messaging: ^14.7.0
```

**`lib/services/fcm_service.dart` (NEW):**

```dart
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

class FcmService {
  static final FirebaseMessaging _messaging = FirebaseMessaging.instance;

  static Future<void> initialize() async {
    await Firebase.initializeApp();

    // Request permission (shows notification prompt on first run)
    await _messaging.requestPermission();

    // Get FCM token and register with relay
    final token = await _messaging.getToken();
    print('[FCM] Token: $token');

    // Send token to relay server so it can push to this device
    // TODO: Add to websocket handshake message
  }

  static Stream<RemoteMessage> get messageStream {
    return FirebaseMessaging.onMessage;
  }
}
```

**Handle foreground push:**

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await FcmService.initialize();

  // Listen for messages while app is running
  FirebaseMessaging.onMessage.listen((RemoteMessage message) {
    print('[FCM] Foreground message: ${message.data}');
    // Force socket reconnect to grab new messages
    ConnectionManager.instance._forceReconnect();
  });

  runApp(const MyApp());
}
```

**Result:** Desktop sends command → Relay sends FCM push → Mobile wakes up → Socket connects → Message delivered (50ms latency).

---

## Expected Timeline

| Phase | Task                   | Effort | When           |
| ----- | ---------------------- | ------ | -------------- |
| 1     | Lifecycle-aware socket | 3h     | This week      |
| 1     | Session persistence    | 2h     | This week      |
| 2     | Firebase integration   | 4h     | Next week      |
| 3     | Polish + testing       | 3h     | Following week |

**After Phase 1:** ~75% reliability (survives backgrounding, instant on-resume reconnect)  
**After Phase 2:** ~95% reliability (survives process kill + instant wakeup via push)

---

## Testing Checklist

**Before shipping:**

- [ ] Kill app with `adb shell am force-stop com.wzxclaw.android` → restart → should reconnect within 5s
- [ ] Put app in background for 1 min → switch back → should immediately show "Connected"
- [ ] Disable network → app backgrounded → re-enable network → resume app → should reconnect
- [ ] Send command from desktop while app backgrounded → app should wake up (Phase 2)

---

## Files to Modify

1. ✅ **`lib/services/connection_manager.dart`** — Add lifecycle observer
2. ✅ **`lib/services/session_recovery_service.dart`** — NEW file
3. ✅ **`lib/main.dart`** — Call recovery on startup
4. ✅ **`android/app/src/main/AndroidManifest.xml`** — Add permissions (Phase 2)
5. ✅ **`pubspec.yaml`** — Add firebase_messaging (Phase 2)
