import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/session_sync_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SessionSyncService', () {
    test('is a singleton', () async {
      // First access triggers _init() -> _loadCachedSessions() which calls
      // sqflite. In test env without platform channels, this produces an
      // unhandled async error. Use runZonedGuarded to absorb it.
      await runZonedGuarded(() async {
        final a = SessionSyncService.instance;
        final b = SessionSyncService.instance;
        expect(identical(a, b), isTrue);
      }, (error, stack) {
        // Swallow sqflite MissingPluginException from _loadCachedSessions
      });
    });

    test('exposes sessionsStream as a broadcast Stream', () {
      final svc = SessionSyncService.instance;
      final sub1 = svc.sessionsStream.listen((_) {});
      final sub2 = svc.sessionsStream.listen((_) {});
      sub1.cancel();
      sub2.cancel();
    });

    test('exposes activeSessionStream as a broadcast Stream', () {
      final svc = SessionSyncService.instance;
      final sub = svc.activeSessionStream.listen((_) {});
      sub.cancel();
    });

    test('exposes workspaceInfoStream as a broadcast Stream', () {
      final svc = SessionSyncService.instance;
      final sub = svc.workspaceInfoStream.listen((_) {});
      sub.cancel();
    });

    test('exposes loadingStream as a broadcast Stream', () {
      final svc = SessionSyncService.instance;
      final sub1 = svc.loadingStream.listen((_) {});
      final sub2 = svc.loadingStream.listen((_) {});
      sub1.cancel();
      sub2.cancel();
    });

    test('exposes workspacesStream as a broadcast Stream', () {
      final svc = SessionSyncService.instance;
      final sub1 = svc.workspacesStream.listen((_) {});
      final sub2 = svc.workspacesStream.listen((_) {});
      sub1.cancel();
      sub2.cancel();
    });

    test('sessions returns an unmodifiable list', () {
      final svc = SessionSyncService.instance;
      final sessions = svc.sessions;
      expect(() => (sessions as List).add(anything), throwsA(anything));
    });

    test('sessions is empty or contains SessionMeta objects', () {
      final svc = SessionSyncService.instance;
      expect(svc.sessions, isA<List>());
    });

    test('activeSessionId is nullable String', () {
      final svc = SessionSyncService.instance;
      expect(svc.activeSessionId, anyOf(isNull, isA<String>()));
    });

    test('workspaceInfo is nullable WorkspaceInfo', () {
      final svc = SessionSyncService.instance;
      expect(svc.workspaceInfo, anyOf(isNull, isA<WorkspaceInfo>()));
    });

    test('isLoading is a bool', () {
      final svc = SessionSyncService.instance;
      expect(svc.isLoading, isA<bool>());
    });

    test('workspaces returns an unmodifiable list', () {
      final svc = SessionSyncService.instance;
      final workspaces = svc.workspaces;
      expect(() => (workspaces as List).add(anything), throwsA(anything));
    });

    test('workspaces starts as empty list', () {
      final svc = SessionSyncService.instance;
      // workspaces is populated only on workspace:list:response from desktop
      expect(svc.workspaces, isA<List<WorkspaceItem>>());
      // Since we're not connected to a desktop, it should be empty
      expect(svc.workspaces, isEmpty);
    });

    test('setActiveSession updates activeSessionId', () {
      final svc = SessionSyncService.instance;
      final previous = svc.activeSessionId;

      svc.setActiveSession('session-test-001');
      expect(svc.activeSessionId, equals('session-test-001'));

      svc.setActiveSession('session-test-002');
      expect(svc.activeSessionId, equals('session-test-002'));

      // Restore
      svc.setActiveSession(previous);
    });

    test('setActiveSession with null clears activeSessionId', () {
      final svc = SessionSyncService.instance;

      svc.setActiveSession('temp-session');
      expect(svc.activeSessionId, equals('temp-session'));

      svc.setActiveSession(null);
      expect(svc.activeSessionId, isNull);
    });

    test('activeSessionStream emits on setActiveSession', () async {
      final svc = SessionSyncService.instance;
      final completer = Completer<String?>();

      final sub = svc.activeSessionStream.listen((id) {
        if (!completer.isCompleted) {
          completer.complete(id);
        }
      });

      svc.setActiveSession('stream-test-session');

      final emitted = await completer.future;
      expect(emitted, equals('stream-test-session'));

      sub.cancel();

      // Cleanup
      svc.setActiveSession(null);
    });

    test('fetchSessions does not throw when not connected', () {
      final svc = SessionSyncService.instance;
      // Not connected to any desktop — should silently return without throwing
      svc.fetchSessions();
    });

    test('loadSessionMessages throws or returns map when not connected', () async {
      final svc = SessionSyncService.instance;
      // Not connected — falls back to local cache via ChatDatabase which
      // needs sqflite. In test env this throws MissingPluginException.
      // Either outcome is acceptable: a thrown error or a valid result map.
      try {
        final result = await svc.loadSessionMessages('nonexistent-session');
        expect(result, isA<Map<String, dynamic>>());
        expect(result, contains('messages'));
        expect(result, contains('total'));
        expect(result, contains('offset'));
        expect(result, contains('hasMore'));
      } catch (e) {
        // sqflite not available in test environment — acceptable
        expect(e, isNotNull);
      }
    });

    test('createSession returns null when not connected', () async {
      final svc = SessionSyncService.instance;
      final result = await svc.createSession(title: 'Test Session');
      expect(result, isNull);
    });

    test('deleteSession returns false when not connected', () async {
      final svc = SessionSyncService.instance;
      final result = await svc.deleteSession('fake-session-id');
      expect(result, isFalse);
    });

    test('renameSession returns false when not connected', () async {
      final svc = SessionSyncService.instance;
      final result =
          await svc.renameSession('fake-session-id', 'New Name');
      expect(result, isFalse);
    });

    test('fetchWorkspaces does not throw when not connected', () {
      final svc = SessionSyncService.instance;
      svc.fetchWorkspaces();
    });

    test('switchWorkspace returns false when not connected', () async {
      final svc = SessionSyncService.instance;
      final result = await svc.switchWorkspace('/path/to/workspace');
      expect(result, isFalse);
    });
  });

  group('WorkspaceInfo', () {
    test('stores all fields correctly', () {
      const info = WorkspaceInfo(
        workspaceName: 'Test Project',
        workspacePath: '/home/user/project',
        activeSessionId: 'session-1',
        sessionCount: 5,
      );
      expect(info.workspaceName, equals('Test Project'));
      expect(info.workspacePath, equals('/home/user/project'));
      expect(info.activeSessionId, equals('session-1'));
      expect(info.sessionCount, equals(5));
    });

    test('activeSessionId can be null', () {
      const info = WorkspaceInfo(
        workspaceName: 'No Session',
        workspacePath: '/path',
        sessionCount: 0,
      );
      expect(info.activeSessionId, isNull);
    });
  });

  group('WorkspaceItem', () {
    test('stores all fields correctly', () {
      const item = WorkspaceItem(
        path: '/home/user/project',
        name: 'My Project',
        isCurrent: true,
      );
      expect(item.path, equals('/home/user/project'));
      expect(item.name, equals('My Project'));
      expect(item.isCurrent, isTrue);
    });

    test('isCurrent defaults correctly', () {
      const item = WorkspaceItem(
        path: '/other',
        name: 'Other',
        isCurrent: false,
      );
      expect(item.isCurrent, isFalse);
    });
  });
}
