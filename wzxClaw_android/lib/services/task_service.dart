import 'dart:async';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/task_model.dart';
import '../models/ws_message.dart';
import 'connection_manager.dart';

/// Singleton service for task management via WebSocket.
///
/// Handles requesting, creating, updating, and deleting tasks on the desktop.
/// Exposes reactive streams for the task list and active task.
class TaskService {
  static const _activeTaskKeyPrefix = 'active_task_id';

  // -- Singleton --
  static final TaskService _instance = TaskService._();
  static TaskService get instance => _instance;
  TaskService._() {
    _init();
  }

  // -- Reactive state --
  final _tasksController = StreamController<List<TaskModel>>.broadcast();
  Stream<List<TaskModel>> get tasksStream => _tasksController.stream;

  final _loadingController = StreamController<bool>.broadcast();
  Stream<bool> get loadingStream => _loadingController.stream;

  String? _activeTaskId;
  String? get activeTaskId => _activeTaskId;
  final _activeTaskIdController = StreamController<String?>.broadcast();
  Stream<String?> get activeTaskIdStream => _activeTaskIdController.stream;

  List<TaskModel> _tasks = [];
  List<TaskModel> get tasks => List.unmodifiable(_tasks);

  StreamSubscription<WsMessage>? _wsSub;
  StreamSubscription<String?>? _desktopOnlineSub;
  final _random = Random.secure();
  DateTime? _lastTaskFetchTime;
  String? _currentDesktopId;

  /// Generate a unique request ID to correlate WS responses.
  String _newRequestId() =>
      '${DateTime.now().millisecondsSinceEpoch}-${_random.nextInt(1000000)}';

  void _init() {
    _wsSub = ConnectionManager.instance.messageStream.listen(
      _onMessage,
      // Keep subscription alive even if upstream emits an error.
      onError: (Object err, StackTrace st) {},
      cancelOnError: false,
    );

    // 用户选择桃面端后才请求任务列表，而不是所有桃面上线都触发。
    _desktopOnlineSub =
        ConnectionManager.instance.selectedDesktopIdStream.listen((selectedId) {
      _handleDesktopSelectionChanged(selectedId);
    });

    _handleDesktopSelectionChanged(ConnectionManager.instance.selectedDesktopId);
  }

  void _onMessage(WsMessage msg) {
    switch (msg.event) {
      case WsEvents.taskListResponse:
        if (!_loadingController.isClosed) _loadingController.add(false);
        final data = msg.data;
        if (data is! Map<String, dynamic>) break; // skip malformed frame
        final tasksList = data['tasks'] as List<dynamic>? ?? [];
        _tasks = tasksList
            .whereType<Map<String, dynamic>>()
            .map(TaskModel.fromJson)
            .toList();
        if (_activeTaskId != null && !_tasks.any((task) => task.id == _activeTaskId)) {
          setActiveTask(null);
        }
        _tasksController.add(_tasks);
        break;

      case WsEvents.taskCreateResponse:
      case WsEvents.taskUpdateResponse:
      case WsEvents.taskDeleteResponse:
        // Refresh after any mutation
        requestTaskList();
        break;

      case WsEvents.taskError:
        if (!_loadingController.isClosed) _loadingController.add(false);
        break;

      case WsEvents.taskChanged:
        // Desktop pushed a task change — refresh the list
        requestTaskList();
        break;
    }
  }

  /// Request the full task list from desktop.
  void requestTaskList() {
    // Debounce: skip if fetched within last 2 seconds.
    final now = DateTime.now();
    if (_lastTaskFetchTime != null &&
        now.difference(_lastTaskFetchTime!) < const Duration(seconds: 2)) {
      return;
    }
    _lastTaskFetchTime = now;

    if (!_loadingController.isClosed) _loadingController.add(true);
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.taskListRequest,
      data: {'requestId': _newRequestId()},
    ),);
  }

  /// Set the active task (persists to local storage and notifies desktop).
  void setActiveTask(String? taskId) {
    _activeTaskId = taskId;
    _activeTaskIdController.add(_activeTaskId);
    final desktopId = ConnectionManager.instance.selectedDesktopId;
    if (desktopId == null) return;

    SharedPreferences.getInstance().then((prefs) {
      if (taskId != null) {
        prefs.setString(_activeTaskKeyForDesktop(desktopId), taskId);
      } else {
        prefs.remove(_activeTaskKeyForDesktop(desktopId));
      }
    }).catchError((e) {
      // ignore: avoid_print
      print('[TaskService] failed to persist active task ID: $e');
    });
  }

  /// Create a new task with the given title.
  void createTask(String title) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.taskCreateRequest,
      data: {
        'requestId': _newRequestId(),
        'title': title,
      },
    ),);
  }

  /// Archive a task.
  void archiveTask(String taskId) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.taskUpdateRequest,
      data: {
        'requestId': _newRequestId(),
        'taskId': taskId,
        'updates': {'archived': true},
      },
    ),);
  }

  /// Rename a task.
  void renameTask(String taskId, String newTitle) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.taskUpdateRequest,
      data: {
        'requestId': _newRequestId(),
        'taskId': taskId,
        'updates': {'title': newTitle},
      },
    ),);
  }

  /// Delete a task.
  void deleteTask(String taskId) {
    ConnectionManager.instance.send(WsMessage(
      event: WsEvents.taskDeleteRequest,
      data: {
        'requestId': _newRequestId(),
        'taskId': taskId,
      },
    ),);
  }

  void dispose() {
    _wsSub?.cancel();
    _desktopOnlineSub?.cancel();
    _tasksController.close();
    _loadingController.close();
    _activeTaskIdController.close();
  }

  void _handleDesktopSelectionChanged(String? desktopId) {
    if (_currentDesktopId == desktopId) {
      if (desktopId != null) {
        Future.delayed(const Duration(milliseconds: 500), () {
          if (ConnectionManager.instance.selectedDesktopId == desktopId) {
            requestTaskList();
          }
        });
      }
      return;
    }

    _currentDesktopId = desktopId;
    _lastTaskFetchTime = null;
    _tasks = [];
    _tasksController.add([]);

    SharedPreferences.getInstance().then((prefs) {
      final restoredTaskId = desktopId == null
          ? null
          : prefs.getString(_activeTaskKeyForDesktop(desktopId));
      if (_activeTaskId != restoredTaskId) {
        _activeTaskId = restoredTaskId;
        _activeTaskIdController.add(_activeTaskId);
      }
    }).catchError((e) {
      print('[TaskService] failed to restore active task ID: $e');
    });

    if (desktopId != null) {
      Future.delayed(const Duration(milliseconds: 500), () {
        if (ConnectionManager.instance.selectedDesktopId == desktopId) {
          requestTaskList();
        }
      });
    }
  }

  static String _activeTaskKeyForDesktop(String desktopId) =>
      '$_activeTaskKeyPrefix::$desktopId';
}
