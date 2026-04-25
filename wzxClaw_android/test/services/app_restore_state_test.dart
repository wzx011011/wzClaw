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

  test('scopes viewed session by desktop and task', () async {
    await AppRestoreState.setLastViewedSession(
      desktopId: 'desktop-a',
      taskId: 'task-1',
      sessionId: 'session-1',
    );
    await AppRestoreState.setLastViewedSession(
      desktopId: 'desktop-a',
      taskId: 'task-2',
      sessionId: null,
    );
    await AppRestoreState.setLastViewedSession(
      desktopId: 'desktop-a',
      taskId: null,
      sessionId: 'session-root',
    );

    final taskOne = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-a',
      taskId: 'task-1',
    );
    final taskTwo = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-a',
      taskId: 'task-2',
    );
    final noTask = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-a',
      taskId: null,
    );
    final otherDesktop = await AppRestoreState.getLastViewedSession(
      desktopId: 'desktop-b',
      taskId: 'task-1',
    );

    expect(taskOne.hasSavedSelection, isTrue);
    expect(taskOne.sessionId, 'session-1');
    expect(taskTwo.hasSavedSelection, isTrue);
    expect(taskTwo.sessionId, isNull);
    expect(noTask.hasSavedSelection, isTrue);
    expect(noTask.sessionId, 'session-root');
    expect(otherDesktop.hasSavedSelection, isFalse);
    expect(otherDesktop.sessionId, isNull);
  });
}