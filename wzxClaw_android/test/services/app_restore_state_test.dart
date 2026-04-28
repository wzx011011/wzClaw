import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/services/app_restore_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('persists last route across reads', () async {
    await AppRestoreState.setLastRoute('/chat');

    expect(await AppRestoreState.getLastRoute(), '/chat');
  });

  test('scopes viewed session by desktop', () async {
    await AppRestoreState.setLastViewedSession(
      desktopId: 'desktop-a',
      sessionId: 'session-1',
    );
    await AppRestoreState.setLastViewedSession(
      desktopId: 'desktop-a',
      sessionId: null,
    );

    final desktopA = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-a',
    );
    final otherDesktop = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-b',
    );

    expect(desktopA.hasSavedSelection, isTrue);
    expect(desktopA.sessionId, isNull);
    expect(otherDesktop.hasSavedSelection, isFalse);
    expect(otherDesktop.sessionId, isNull);
  });
}
