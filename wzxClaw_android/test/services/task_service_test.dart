import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/services/task_service.dart';

Future<void> _settleAsync() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(const Duration(milliseconds: 20));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('TaskService desktop-scoped persistence', () {
    test('restores and persists active task per desktop', () async {
      SharedPreferences.setMockInitialValues({
        'active_task_id::desktop-a': 'task-a',
        'active_task_id::desktop-b': 'task-b',
      });

      final connectionManager = ConnectionManager.instance;
      final taskService = TaskService.instance;

      connectionManager.selectDesktop(null);
      await _settleAsync();

      connectionManager.selectDesktop('desktop-a');
      await _settleAsync();
      expect(taskService.activeTaskId, 'task-a');

      connectionManager.selectDesktop('desktop-b');
      await _settleAsync();
      expect(taskService.activeTaskId, 'task-b');

      taskService.setActiveTask('task-b-updated');
      await _settleAsync();

      connectionManager.selectDesktop('desktop-a');
      await _settleAsync();
      expect(taskService.activeTaskId, 'task-a');

      connectionManager.selectDesktop('desktop-b');
      await _settleAsync();
      expect(taskService.activeTaskId, 'task-b-updated');

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('active_task_id::desktop-a'), 'task-a');
      expect(prefs.getString('active_task_id::desktop-b'), 'task-b-updated');
    });
  });
}