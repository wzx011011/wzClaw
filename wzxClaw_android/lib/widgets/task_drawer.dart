import 'package:flutter/material.dart';

import '../config/app_colors.dart';
import '../models/task_model.dart';
import '../services/task_service.dart';

/// Bottom sheet / panel that lists tasks and allows switching the active task.
class TaskDrawer extends StatefulWidget {
  const TaskDrawer({super.key});

  @override
  State<TaskDrawer> createState() => _TaskDrawerState();
}

class _TaskDrawerState extends State<TaskDrawer> {
  @override
  void initState() {
    super.initState();
    TaskService.instance.requestTaskList();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Container(
      color: colors.bgPrimary,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _buildHeader(context, colors),
          Flexible(
            child: StreamBuilder<List<TaskModel>>(
              stream: TaskService.instance.tasksStream,
              initialData: TaskService.instance.tasks,
              builder: (context, snapshot) {
                final tasks = snapshot.data ?? [];
                if (tasks.isEmpty) {
                  return StreamBuilder<bool>(
                    stream: TaskService.instance.loadingStream,
                    builder: (context, loadSnap) {
                      if (loadSnap.data == true) {
                        return const Padding(
                          padding: EdgeInsets.all(24),
                          child: Center(child: CircularProgressIndicator()),
                        );
                      }
                      return Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          '暂无任务',
                          style: TextStyle(color: colors.textMuted, fontSize: 14),
                          textAlign: TextAlign.center,
                        ),
                      );
                    },
                  );
                }
                return ListView.builder(
                  shrinkWrap: true,
                  itemCount: tasks.length,
                  itemBuilder: (context, index) =>
                      _buildTaskTile(context, colors, tasks[index]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context, AppColors colors) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: colors.bgSecondary,
        border: Border(bottom: BorderSide(color: colors.border)),
      ),
      child: Row(
        children: [
          Icon(Icons.task_alt, color: colors.accent, size: 18),
          const SizedBox(width: 8),
          Text(
            '任务',
            style: TextStyle(
              color: colors.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const Spacer(),
          IconButton(
            icon: Icon(Icons.add, color: colors.accent, size: 20),
            onPressed: () => _showCreateDialog(context),
            tooltip: '新建任务',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
          const SizedBox(width: 8),
          IconButton(
            icon: Icon(Icons.refresh, color: colors.textSecondary, size: 18),
            onPressed: TaskService.instance.requestTaskList,
            tooltip: '刷新',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
        ],
      ),
    );
  }

  Widget _buildTaskTile(BuildContext context, AppColors colors, TaskModel task) {
    return StreamBuilder<String?>(
      stream: TaskService.instance.activeTaskIdStream,
      initialData: TaskService.instance.activeTaskId,
      builder: (context, snapshot) {
        final isActive = snapshot.data == task.id;
        return Container(
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(
                color: isActive ? colors.accent : Colors.transparent,
                width: 3,
              ),
              bottom: BorderSide(color: colors.border.withValues(alpha: 0.4)),
            ),
            color: isActive
                ? colors.accent.withValues(alpha: 0.08)
                : Colors.transparent,
          ),
          child: ListTile(
            leading: Icon(
              isActive ? Icons.play_arrow : Icons.circle_outlined,
              color: isActive ? colors.accent : colors.textMuted,
              size: 18,
            ),
            title: Text(
              task.title,
              style: TextStyle(
                color: colors.textPrimary,
                fontSize: 14,
                fontWeight:
                    isActive ? FontWeight.w600 : FontWeight.normal,
              ),
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: task.projects.isNotEmpty
                ? Text(
                    task.projects.map((p) => p.name).join(', '),
                    style: TextStyle(
                      color: colors.textMuted,
                      fontSize: 11,
                    ),
                    overflow: TextOverflow.ellipsis,
                  )
                : null,
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (!isActive)
                  TextButton(
                    onPressed: () {
                      TaskService.instance.setActiveTask(task.id);
                      Navigator.pop(context);
                    },
                    style: TextButton.styleFrom(
                      foregroundColor: colors.accent,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 32),
                    ),
                    child: const Text('切换', style: TextStyle(fontSize: 12)),
                  ),
                if (isActive)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: colors.accent.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '当前',
                      style: TextStyle(
                        color: colors.accent,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                const SizedBox(width: 4),
                PopupMenuButton<String>(
                  icon: Icon(Icons.more_vert, color: colors.textMuted, size: 16),
                  color: colors.bgElevated,
                  itemBuilder: (_) => [
                    PopupMenuItem(
                      value: 'rename',
                      child: Text('重命名',
                          style: TextStyle(color: colors.textSecondary, fontSize: 13),),
                    ),
                    PopupMenuItem(
                      value: 'archive',
                      child: Text('归档',
                          style: TextStyle(color: colors.textSecondary, fontSize: 13),),
                    ),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text('删除',
                          style: TextStyle(color: colors.error, fontSize: 13),),
                    ),
                  ],
                  onSelected: (value) async {
                    if (value == 'rename') {
                      _showRenameDialog(context, task);
                    } else if (value == 'archive') {
                      TaskService.instance.archiveTask(task.id);
                    } else if (value == 'delete') {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (_) => AlertDialog(
                          backgroundColor: colors.bgElevated,
                          title: Text('删除任务',
                              style: TextStyle(color: colors.textPrimary),),
                          content: Text('确定删除「${task.title}」？',
                              style: TextStyle(color: colors.textSecondary),),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: Text('取消',
                                  style: TextStyle(color: colors.textSecondary),),
                            ),
                            TextButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: Text('删除',
                                  style: TextStyle(color: colors.error),),
                            ),
                          ],
                        ),
                      );
                      if (confirmed == true) {
                        TaskService.instance.deleteTask(task.id);
                      }
                    }
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showCreateDialog(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (_) => const _CreateTaskDialog(),
    );
  }

  void _showRenameDialog(BuildContext context, TaskModel task) {
    showDialog<void>(
      context: context,
      builder: (_) => _RenameTaskDialog(task: task),
    );
  }
}

/// Private dialog widget that owns the TextEditingController so it is
/// correctly disposed when the dialog is closed.
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
    final colors = AppColors.of(context);
    return AlertDialog(
      backgroundColor: colors.bgElevated,
      title: Text('新建任务', style: TextStyle(color: colors.textPrimary)),
      content: TextField(
        controller: _controller,
        autofocus: true,
        style: TextStyle(color: colors.textPrimary),
        decoration: InputDecoration(
          hintText: '任务名称',
          hintStyle: TextStyle(color: colors.textMuted),
          enabledBorder: UnderlineInputBorder(
            borderSide: BorderSide(color: colors.border),
          ),
          focusedBorder: UnderlineInputBorder(
            borderSide: BorderSide(color: colors.accent),
          ),
        ),
        onSubmitted: (value) {
          if (value.trim().isNotEmpty) {
            TaskService.instance.createTask(value.trim());
            Navigator.pop(context);
          }
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text('取消', style: TextStyle(color: colors.textSecondary)),
        ),
        TextButton(
          onPressed: () {
            if (_controller.text.trim().isNotEmpty) {
              TaskService.instance.createTask(_controller.text.trim());
              Navigator.pop(context);
            }
          },
          child: Text('创建', style: TextStyle(color: colors.accent)),
        ),
      ],
    );
  }
}

/// Rename dialog with pre-filled text field.
class _RenameTaskDialog extends StatefulWidget {
  final TaskModel task;
  const _RenameTaskDialog({required this.task});

  @override
  State<_RenameTaskDialog> createState() => _RenameTaskDialogState();
}

class _RenameTaskDialogState extends State<_RenameTaskDialog> {
  late final _controller = TextEditingController(text: widget.task.title);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return AlertDialog(
      backgroundColor: colors.bgElevated,
      title: Text('重命名任务', style: TextStyle(color: colors.textPrimary)),
      content: TextField(
        controller: _controller,
        autofocus: true,
        style: TextStyle(color: colors.textPrimary),
        decoration: InputDecoration(
          hintText: '任务名称',
          hintStyle: TextStyle(color: colors.textMuted),
          enabledBorder: UnderlineInputBorder(
            borderSide: BorderSide(color: colors.border),
          ),
          focusedBorder: UnderlineInputBorder(
            borderSide: BorderSide(color: colors.accent),
          ),
        ),
        onSubmitted: (value) {
          if (value.trim().isNotEmpty) {
            TaskService.instance.renameTask(widget.task.id, value.trim());
            Navigator.pop(context);
          }
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text('取消', style: TextStyle(color: colors.textSecondary)),
        ),
        TextButton(
          onPressed: () {
            if (_controller.text.trim().isNotEmpty) {
              TaskService.instance.renameTask(widget.task.id, _controller.text.trim());
              Navigator.pop(context);
            }
          },
          child: Text('确定', style: TextStyle(color: colors.accent)),
        ),
      ],
    );
  }
}

/// Show the task panel as a modal bottom sheet.
void showTaskDrawer(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => DraggableScrollableSheet(
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (_, __) => const ClipRRect(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        child: TaskDrawer(),
      ),
    ),
  );
}
