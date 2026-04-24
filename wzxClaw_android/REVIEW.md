---
phase: flutter-task-feature
reviewed: 2026-04-21T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - lib/models/task_model.dart
  - lib/services/task_service.dart
  - lib/widgets/task_drawer.dart
  - lib/widgets/project_drawer.dart
  - lib/services/chat_store.dart
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
status: issues_found
---

# Code Review: Flutter Task Feature

## Summary

The overall structure is clean and follows Flutter conventions well. One critical issue — an uncaught runtime type error that can silently kill the WebSocket message handler — must be fixed before shipping. Four warnings cover a context-safety bug, a resource leak, a requestId collision window, and a singleton `dispose()` footgun.

---

## Critical Issues

### CR-01: Uncaught `TypeError` from unsafe cast in `_onMessage` — CRITICAL

**File:** `lib/services/task_service.dart` — `_onMessage` method

**Issue:** `msg.data as Map<String, dynamic>?` is a Dart hard cast, not a safe-cast. If the server sends a `taskListResponse` whose `data` field is not a `Map` (e.g., a `List`, a `String`, or `null` serialized incorrectly), Dart throws a `TypeError` that is not caught inside `_onMessage`. Because this runs inside a `StreamSubscription.listen()` callback with no error handler, the exception propagates to the zone and kills the subscription — silently stopping all future WebSocket events from being processed for the lifetime of the app session.

```dart
// BEFORE — hard cast, throws TypeError on unexpected shape
final raw = msg.data as Map<String, dynamic>?;
```

**Fix:** Use `is`-guard or `tryCast` pattern:

```dart
void _onMessage(WsMessage msg) {
  switch (msg.event) {
    case WsEvents.taskListResponse:
      _loadingController.add(false);
      final data = msg.data;
      if (data is! Map<String, dynamic>) break; // safe: skip malformed frame
      final tasksList = data['tasks'] as List<dynamic>? ?? [];
      _tasks = tasksList
          .whereType<Map<String, dynamic>>()
          .map(TaskModel.fromJson)
          .toList();
      _tasksController.add(_tasks);
      break;
    // ... rest unchanged
  }
}
```

Also add an `onError` handler when setting up the subscription in `_init()` so errors from the upstream stream do not terminate the subscription:

```dart
_wsSub = ConnectionManager.instance.messageStream.listen(
  _onMessage,
  onError: (Object err, StackTrace st) {
    // log/report — do not rethrow so subscription stays alive
  },
);
```

---

## Warnings

### WR-01: `Navigator.pop` then `showTaskDrawer` with a stale `BuildContext` — WARNING

**File:** `lib/widgets/project_drawer.dart` — `_buildTaskEntry` `onTap` callback

**Issue:**

```dart
onTap: () {
  Navigator.pop(context);      // removes the project drawer route
  showTaskDrawer(context);     // uses the now-deactivated context
},
```

`context` here belongs to the `StreamBuilder` inside the project drawer widget. After `Navigator.pop(context)`, the route is removed and the element tree under it begins deactivation. Calling `showModalBottomSheet` synchronously with that context is undefined behaviour — it may silently use a stale navigator ancestor or throw `"Looking up a deactivated widget's ancestor is unsafe"` in debug builds, and crash in release builds on some Flutter versions.

**Fix:** Capture a higher-level context above the drawer before popping. The cleanest approach is to pass the outer scaffold context via a callback or use `WidgetsBinding.addPostFrameCallback`:

```dart
// Option A — post-frame callback (minimal patch)
onTap: () {
  final outer = Navigator.of(context);
  Navigator.pop(context);
  WidgetsBinding.instance.addPostFrameCallback((_) {
    showTaskDrawer(outer.context);
  });
},

// Option B — pass parent context into the drawer widget
class ProjectDrawer extends StatelessWidget {
  const ProjectDrawer({super.key, required this.rootContext});
  final BuildContext rootContext;
  // inside _buildTaskEntry:
  // onTap: () { Navigator.pop(context); showTaskDrawer(rootContext); }
}
```

---

### WR-02: `TextEditingController` leaked in `_showCreateDialog` — WARNING

**File:** `lib/widgets/task_drawer.dart` — `_showCreateDialog`

**Issue:** A `TextEditingController` is created on every call to `_showCreateDialog` but never disposed. `TextEditingController` extends `ChangeNotifier`; not disposing it leaks a listener registration and its underlying `TextEditingValue` object. If the dialog is opened repeatedly, each open creates another leaked controller.

```dart
void _showCreateDialog(BuildContext context) {
  final controller = TextEditingController(); // never disposed
  ...
}
```

**Fix:** Extract to a `StatefulWidget` dialog so `dispose()` is called automatically:

```dart
void _showCreateDialog(BuildContext context) {
  showDialog<void>(
    context: context,
    builder: (_) => const _CreateTaskDialog(),
  );
}

class _CreateTaskDialog extends StatefulWidget {
  const _CreateTaskDialog();
  @override
  State<_CreateTaskDialog> createState() => _CreateTaskDialogState();
}

class _CreateTaskDialogState extends State<_CreateTaskDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // ... same AlertDialog content using _controller
  }
}
```

---

### WR-03: `requestId` collision under rapid successive sends — WARNING

**File:** `lib/services/task_service.dart` — `requestTaskList`, `createTask`, `archiveTask`, `deleteTask`

**Issue:** All four methods generate `requestId` via `DateTime.now().millisecondsSinceEpoch.toString()`. If two requests are sent within the same millisecond (easily triggered by a user tapping quickly, or by `taskCreateResponse` / `taskUpdateResponse` both calling `requestTaskList()` in `_onMessage`), they share an identical `requestId`. If the desktop side uses this ID to correlate responses, one response will be dropped or misrouted.

**Fix:** Use the `uuid` package for guaranteed uniqueness:

```dart
import 'package:uuid/uuid.dart';

final _uuid = const Uuid();

void requestTaskList() {
  _loadingController.add(true);
  ConnectionManager.instance.send(WsMessage(
    event: WsEvents.taskListRequest,
    data: {'requestId': _uuid.v4()},
  ));
}
// apply same pattern to createTask, archiveTask, deleteTask
```

---

### WR-04: Singleton `dispose()` leaves streams permanently closed — WARNING

**File:** `lib/services/task_service.dart` — `dispose()` method

**Issue:** `TaskService` is a process-lifetime singleton (`static final _instance = TaskService._();`). Its `dispose()` method closes all three `StreamController`s and cancels the WebSocket subscription. If any widget or test code calls `TaskService.instance.dispose()`, subsequent calls to `requestTaskList()` or any public method will throw `Bad state: Cannot add event after closing`. The singleton cannot be re-initialized.

**Fix:** Either remove the `dispose()` method entirely (singletons should live as long as the process), or guard every `add()` call and document that `dispose()` is only for app shutdown / testing teardown, not widget lifecycle:

```dart
void _safeAdd<T>(StreamController<T> ctrl, T value) {
  if (!ctrl.isClosed) ctrl.add(value);
}
```

---

## Info

### IN-01: Empty-string fallback for `id` hides data integrity errors — INFO

**File:** `lib/models/task_model.dart`

**Issue:** Both `TaskModel.fromJson` and `TaskProject.fromJson` fall back to `''` when `id` is absent. An empty-string ID is indistinguishable from a valid ID, so a malformed server response silently produces a task that can be archived or deleted with an empty `taskId` sent to the server.

**Fix:** Consider `assert(id.isNotEmpty, 'TaskModel must have a non-empty id')` in the constructor, or skip empty-id tasks at parse time.

---

### IN-02: Per-tile `StreamBuilder<String?>` causes O(n) rebuilds on every active-task change — INFO

**File:** `lib/widgets/task_drawer.dart` — `_buildTaskTile`

**Issue:** Every task tile embeds its own `StreamBuilder<String?>` subscribed to `activeTaskIdStream`. When `setActiveTask` is called, all N tiles receive the stream event and rebuild, even though at most 2 tiles (old active, new active) actually change appearance.

**Fix:** Lift the `StreamBuilder` to the list level and pass `activeTaskId` as a parameter:

```dart
// In the outer StreamBuilder:
builder: (context, taskSnap) {
  return StreamBuilder<String?>(
    stream: TaskService.instance.activeTaskIdStream,
    initialData: TaskService.instance.activeTaskId,
    builder: (context, activeSnap) {
      final tasks = taskSnap.data ?? [];
      final activeId = activeSnap.data;
      return ListView.builder(
        itemCount: tasks.length,
        itemBuilder: (context, i) =>
            _buildTaskTile(context, colors, tasks[i], activeId),
      );
    },
  );
},
```

---

### IN-03: `shrinkWrap: true` disables `ListView.builder` lazy rendering — INFO

**File:** `lib/widgets/task_drawer.dart` — `build()`

**Issue:** `ListView.builder` with `shrinkWrap: true` inside a `Flexible` forces the list to measure all items upfront, defeating the purpose of `builder` (lazy construction). For large task lists this causes jank on open.

**Fix:** Remove `shrinkWrap: true` — the `Flexible` parent already constrains height so it is not needed.

---

### IN-04: `TaskModel` / `TaskProject` have no `toJson` — INFO

**File:** `lib/models/task_model.dart`

**Issue:** Models only support deserialization. If any future feature needs to serialize tasks (local caching, optimistic updates, logging), the absence of `toJson` means ad-hoc maps will be written inline, diverging from the model schema.

**Fix:** Add `toJson()` to both classes while the schema is fresh.

---

_Reviewed: 2026-04-21_
_Reviewer: GitHub Copilot (Claude Sonnet 4.6)_
_Depth: standard_
