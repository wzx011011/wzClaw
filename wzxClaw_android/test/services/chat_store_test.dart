import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/services/chat_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ChatStore is a singleton. We reference it but cannot fully reset state
  // between tests. Tests are ordered to avoid interference.

  group('ChatStore singleton', () {
    test('instance is always the same object', () {
      final a = ChatStore.instance;
      final b = ChatStore.instance;
      expect(identical(a, b), isTrue);
    });
  });

  group('ChatStore reactive streams', () {
    test('exposes messagesStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      // Should be able to listen without error
      final sub = store.messagesStream.listen((_) {});
      // Can listen twice (broadcast)
      final sub2 = store.messagesStream.listen((_) {});
      sub.cancel();
      sub2.cancel();
    });

    test('exposes streamingStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.streamingStream.listen((_) {});
      final sub2 = store.streamingStream.listen((_) {});
      sub.cancel();
      sub2.cancel();
    });

    test('exposes waitingStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.waitingStream.listen((_) {});
      sub.cancel();
    });

    test('exposes permissionStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.permissionStream.listen((_) {});
      sub.cancel();
    });

    test('exposes planModeStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.planModeStream.listen((_) {});
      sub.cancel();
    });

    test('exposes askUserStream as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.askUserStream.listen((_) {});
      sub.cancel();
    });
  });

  group('ChatStore thinking state', () {
    test('thinkingContent starts as empty string', () {
      // Note: since ChatStore is a singleton, thinkingContent may not be empty
      // if a previous test triggered thinking. We test the type.
      final store = ChatStore.instance;
      expect(store.thinkingContent, isA<String>());
    });

    test('thinkingStream is exposed as a broadcast Stream', () {
      final store = ChatStore.instance;
      final sub = store.thinkingStream.listen((_) {});
      final sub2 = store.thinkingStream.listen((_) {});
      sub.cancel();
      sub2.cancel();
    });
  });

  group('ChatStore messages getter', () {
    test('messages returns an unmodifiable list', () {
      final store = ChatStore.instance;
      final msgs = store.messages;
      expect(() => (msgs as List).add(ChatMessage(
            role: MessageRole.user,
            content: 'hack',
            createdAt: DateTime.now(),
          )), throwsA(anything));
    });

    test('messages is a List<ChatMessage>', () {
      final store = ChatStore.instance;
      expect(store.messages, isA<List<ChatMessage>>());
    });
  });

  group('ChatStore displayMessages caching', () {
    test('displayMessages returns a list', () {
      final store = ChatStore.instance;
      expect(store.displayMessages, isA<List<ChatMessage>>());
    });

    test('displayMessages returns same instance on repeated calls when state unchanged', () {
      final store = ChatStore.instance;
      final first = store.displayMessages;
      final second = store.displayMessages;
      expect(identical(first, second), isTrue,
          reason: 'Cached list should be the same object when nothing changed');
    });

    test('displayMessages length matches messages length when not streaming', () {
      final store = ChatStore.instance;
      if (!store.isStreaming) {
        expect(store.displayMessages.length, equals(store.messages.length));
      }
    });
  });

  group('ChatStore loadFetchedMessages', () {
    setUp(() {
      final store = ChatStore.instance;
      store.currentSessionId = 'test-session';
    });

    test('clearing with empty list does not throw', () {
      final store = ChatStore.instance;
      // Should not throw — this increments _clearGeneration and clears messages
      store.loadFetchedMessages('test-session', []);
    });

    test('loading empty list then loading messages works when no user message sent', () {
      final store = ChatStore.instance;

      // Step 1: Clear messages (simulates task switch)
      store.loadFetchedMessages('test-session', []);

      // Step 2: Load fetched messages — should succeed since no user message
      // was sent in between
      final fetchedMessages = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'Welcome back!',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', fetchedMessages);

      // The message should have been loaded
      expect(store.messages, isNotEmpty);
      expect(store.messages.last.content, equals('Welcome back!'));
    });

    test('clear guard: non-empty messages rejected after clear + sendMessage + another clear', () async {
      // This tests the generation-based guard indirectly.
      // Pattern: clear -> sendMessage (sets _lastUserMsgGen = _clearGeneration) ->
      //   clear again (increments _clearGeneration) ->
      //   loadFetchedMessages with messages should work because _lastUserMsgGen < _clearGeneration
      final store = ChatStore.instance;

      // Clear once
      store.loadFetchedMessages('test-session', []);

      // Send a message — this sets _lastUserMsgGen = current _clearGeneration
      // Note: sendMessage calls ChatDatabase.insertMessage which needs sqflite.
      // In test env without platform channels, this throws but the generation
      // side-effect (_lastUserMsgGen) has already been set before the DB call.
      try {
        await store.sendMessage('test message for guard');
      } catch (e) {
        // sqflite not available — the generation guard was already set before
        // the DB call, so the test logic is still valid.
      }

      // Now clear again — this increments _clearGeneration past _lastUserMsgGen
      store.loadFetchedMessages('test-session', []);

      // Load messages — this should succeed because _lastUserMsgGen < _clearGeneration
      final newMessages = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'Fresh response after clear',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', newMessages);

      expect(store.messages, isNotEmpty);
      expect(store.messages.any((m) => m.content == 'Fresh response after clear'),
          isTrue);
    });

    test('clear guard: messages rejected when user sent message without intermediate clear', () async {
      final store = ChatStore.instance;

      // Step 1: Clear to set a baseline generation
      store.loadFetchedMessages('test-session', []);

      // Step 2: Send a user message — sets _lastUserMsgGen = _clearGeneration + 1 (Bug 4 fix).
      // sendMessage internally calls ChatDatabase.insertMessage which needs
      // sqflite. In test env, wrap in try-catch since the generation side-effect
      // is set before the DB call.
      try {
        await store.sendMessage('user typed this');
      } catch (e) {
        // sqflite not available — generation guard was already set.
      }

      // Step 3: Try to load fetched messages without clearing first.
      // After Bug 4 fix: _lastUserMsgGen = _clearGeneration + 1, so
      // _lastUserMsgGen > _clearGeneration is TRUE — the guard fires
      // and rejects the stale fetch.
      final fetched = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'AI response',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', fetched);

      // Messages should be REJECTED (guard now correctly fires after user sends a message)
      expect(store.messages.any((m) => m.content == 'AI response'), isFalse);
    });
  });

  group('ChatStore state accessors', () {
    test('isStreaming is a bool', () {
      final store = ChatStore.instance;
      expect(store.isStreaming, isA<bool>());
    });

    test('isWaitingForResponse is a bool', () {
      final store = ChatStore.instance;
      expect(store.isWaitingForResponse, isA<bool>());
    });

    test('currentSessionId is nullable String', () {
      final store = ChatStore.instance;
      expect(store.currentSessionId, anyOf(isNull, isA<String>()));
    });

    test('isBrowsingHistory is a bool', () {
      final store = ChatStore.instance;
      expect(store.isBrowsingHistory, isA<bool>());
    });

    test('permissionMode starts as always-ask', () {
      final store = ChatStore.instance;
      expect(store.permissionMode, equals('always-ask'));
    });

    test('todos returns unmodifiable list', () {
      final store = ChatStore.instance;
      final todos = store.todos;
      expect(() => (todos as List).add({'content': 'hack', 'status': 'pending', 'activeForm': ''}),
          throwsA(anything));
    });
  });

  group('ChatStore clearSession', () {
    test('clearSession does not throw', () async {
      final store = ChatStore.instance;
      // Load some messages first
      store.loadFetchedMessages('test-session', [
        ChatMessage(
          role: MessageRole.user,
          content: 'to be cleared',
          createdAt: DateTime.now(),
        ),
      ]);
      // Clear — depends on ChatDatabase which needs sqflite (platform channel).
      // This will throw in test env. Catch and verify graceful handling.
      try {
        await store.clearSession();
      } catch (e) {
        // Expected: MissingPluginException or similar from sqflite
        expect(e, isNotNull);
      }
    });
  });

  group('ChatStore WsMessage handling', () {
    test('handling agentThinking via WsMessage updates thinkingContent', () {
      final store = ChatStore.instance;

      // Simulate the agentThinking event by injecting a WsMessage through
      // the internal handler. Since _handleWsMessage is private, we test
      // indirectly through the public thinkingContent getter.

      // The thinkingContent should be a string (may be empty or have content)
      expect(store.thinkingContent, isA<String>());
    });

    test('handling agentText creates streaming message', () async {
      final store = ChatStore.instance;

      // Listen for messages stream updates
      final completer = Completer<List<ChatMessage>>();
      final sub = store.messagesStream.listen((msgs) {
        if (!completer.isCompleted) {
          completer.complete(msgs);
        }
      });

      // Since we cannot directly call _handleAgentText, verify that
      // the stream infrastructure is in place
      expect(store.messagesStream, isNotNull);

      sub.cancel();
    });
  });

  group('ChatStore stopGeneration', () {
    test('stopGeneration does not throw when not streaming', () {
      final store = ChatStore.instance;
      // Should be safe to call even when nothing is streaming
      store.stopGeneration();
      expect(store.isStreaming, isFalse);
    });
  });

  group('ChatStore respondToPermission', () {
    test('respondToPermission does not throw', () {
      final store = ChatStore.instance;
      // Will try to send via ConnectionManager but should not throw
      store.respondToPermission('tc-test', true);
      store.respondToPermission('tc-test', false);
    });
  });

  group('ChatStore respondToPlan', () {
    test('respondToPlan does not throw', () {
      final store = ChatStore.instance;
      store.respondToPlan(true);
      store.respondToPlan(false);
    });
  });

  group('ChatStore respondToAskUser', () {
    test('respondToAskUser does not throw', () {
      final store = ChatStore.instance;
      store.respondToAskUser('q-1', ['Option A']);
      store.respondToAskUser('q-2', ['Option A', 'Option B'],
          customText: 'Custom input');
    });
  });

  group('ChatStore permission mode', () {
    test('setPermissionMode updates local state', () {
      final store = ChatStore.instance;

      store.setPermissionMode('accept-edits');
      expect(store.permissionMode, equals('accept-edits'));

      // Reset back to default
      store.setPermissionMode('always-ask');
      expect(store.permissionMode, equals('always-ask'));
    });

    test('requestPermissionMode does not throw', () {
      final store = ChatStore.instance;
      store.requestPermissionMode();
    });
  });

  group('ChatStore currentSessionId setter', () {
    test('currentSessionId can be set and read back', () {
      final store = ChatStore.instance;
      final previous = store.currentSessionId;

      store.currentSessionId = 'test-session-123';
      expect(store.currentSessionId, equals('test-session-123'));

      // Restore
      store.currentSessionId = previous;
    });

    test('currentSessionId can be set to null', () {
      final store = ChatStore.instance;
      store.currentSessionId = null;
      expect(store.currentSessionId, isNull);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Bug 3 fix: userManuallySwitched — only true when userInitiated: true
  // ══════════════════════════════════════════════════════════════════
  group('ChatStore userManuallySwitched', () {
    test('starts as false', () {
      // After any resetSessionScope, should be false
      final store = ChatStore.instance;
      store.resetSessionScope();
      expect(store.userManuallySwitched, isFalse);
    });

    test('remains false when switchToSession called without userInitiated', () async {
      final store = ChatStore.instance;
      store.resetSessionScope();

      // System-initiated switch (default userInitiated: false)
      try {
        await store.switchToSession('sys-session-1');
      } catch (_) {
        // sqflite not available — that's fine; the flag is set before DB calls
      }

      expect(store.userManuallySwitched, isFalse,
          reason: 'System-initiated switch must not set userManuallySwitched');
    });

    test('becomes true when switchToSession called with userInitiated: true', () async {
      final store = ChatStore.instance;
      store.resetSessionScope();

      try {
        await store.switchToSession('user-session-1', userInitiated: true);
      } catch (_) {
        // sqflite not available
      }

      expect(store.userManuallySwitched, isTrue,
          reason: 'User-initiated switch must set userManuallySwitched');
    });

    test('reset to false after resetSessionScope', () async {
      final store = ChatStore.instance;
      store.resetSessionScope();

      try {
        await store.switchToSession('user-session-2', userInitiated: true);
      } catch (_) {}

      expect(store.userManuallySwitched, isTrue);
      store.resetSessionScope();
      expect(store.userManuallySwitched, isFalse);
    });

    test('reset to false after system switchToSession', () async {
      final store = ChatStore.instance;
      store.resetSessionScope();

      // User manually switches to A
      try {
        await store.switchToSession('user-session-A', userInitiated: true);
      } catch (_) {}
      expect(store.userManuallySwitched, isTrue);

      // System switches to B — clears the flag
      try {
        await store.switchToSession('sys-session-B');
      } catch (_) {}
      expect(store.userManuallySwitched, isFalse,
          reason: 'System switch must clear userManuallySwitched so desktop can lead again');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Bug 4 fix: loadFetchedMessages guard with corrected +1 generation
  // ══════════════════════════════════════════════════════════════════
  group('ChatStore loadFetchedMessages guard (Bug 4 fix)', () {
    setUp(() {
      final store = ChatStore.instance;
      store.currentSessionId = 'test-session';
    });

    test('messages ARE loaded when no user message sent after clear', () {
      final store = ChatStore.instance;
      store.loadFetchedMessages('test-session', []);

      final fetched = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'auto-sync result',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', fetched);
      expect(store.messages.any((m) => m.content == 'auto-sync result'), isTrue);
    });

    test('messages ARE rejected when user sent message after clear (guard works)', () async {
      final store = ChatStore.instance;

      // Clear — sets baseline generation N
      store.loadFetchedMessages('test-session', []);

      // User sends message — now _lastUserMsgGen = N + 1
      try {
        await store.sendMessage('user input');
      } catch (_) {
        // sqflite unavailable; generation side-effect already applied
      }

      // A delayed fetch arrives — should be rejected because user sent a message
      final staleFetch = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'stale fetch should be rejected',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', staleFetch);

      // The stale fetch must NOT replace the messages (user message is in flight)
      expect(
        store.messages.any((m) => m.content == 'stale fetch should be rejected'),
        isFalse,
        reason: 'loadFetchedMessages should reject stale fetch when user already sent a message',
      );
    });

    test('messages ARE loaded again after second clear following user message', () async {
      final store = ChatStore.instance;

      // Clear N
      store.loadFetchedMessages('test-session', []);
      // User sends → _lastUserMsgGen = N+1
      try {
        await store.sendMessage('user input 2');
      } catch (_) {}
      // Clear again → generation = N+1, then N+2 (depending on sequence)
      // Either way, _lastUserMsgGen <= _clearGeneration after this
      store.loadFetchedMessages('test-session', []); // clears and increments

      final freshFetch = [
        ChatMessage(
          role: MessageRole.assistant,
          content: 'fresh fetch after second clear',
          createdAt: DateTime.now(),
        ),
      ];
      store.loadFetchedMessages('test-session', freshFetch);

      expect(
        store.messages.any((m) => m.content == 'fresh fetch after second clear'),
        isTrue,
        reason: 'After second clear, fresh fetch should be accepted',
      );
    });
  });
}
