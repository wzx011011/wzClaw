import 'session_task_state.dart';

/// Session metadata synced from the desktop wzxClaw IDE.
class SessionMeta {
  final String id;
  final String workspacePath;
  final String workspaceName;
  final String title;
  final int createdAt; // epoch ms
  final int updatedAt; // epoch ms
  final int messageCount;
  final bool isSynced; // true if messages have been pulled from desktop
  final bool isRunning; // true if desktop is currently processing this session
  final SessionTaskState? taskState;

  const SessionMeta({
    required this.id,
    required this.workspacePath,
    required this.workspaceName,
    required this.title,
    required this.createdAt,
    required this.updatedAt,
    required this.messageCount,
    this.isSynced = false,
    this.isRunning = false,
    this.taskState,
  });

  factory SessionMeta.fromDesktopJson(
    Map<String, dynamic> json,
    String workspacePath,
    String workspaceName,
  ) {
    return SessionMeta(
      id: json['id'] as String? ?? '',
      workspacePath: workspacePath,
      workspaceName: workspaceName,
      title: json['title'] as String? ?? 'Untitled',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      messageCount: (json['messageCount'] as num?)?.toInt() ?? 0,
      isRunning: json['isRunning'] as bool? ?? false,
      taskState: json['taskStatus'] is Map
          ? SessionTaskState.fromJson(Map<String, dynamic>.from(json['taskStatus'] as Map))
          : null,
    );
  }

  factory SessionMeta.fromDbMap(Map<String, dynamic> map) {
    return SessionMeta(
      id: map['id'] as String,
      workspacePath: map['workspace_path'] as String,
      workspaceName: map['workspace_name'] as String,
      title: map['title'] as String,
      createdAt: map['created_at'] as int,
      updatedAt: map['updated_at'] as int,
      messageCount: map['message_count'] as int,
      isSynced: (map['is_synced'] as int) == 1,
    );
  }

  Map<String, dynamic> toDbMap() {
    return {
      'id': id,
      'workspace_path': workspacePath,
      'workspace_name': workspaceName,
      'title': title,
      'created_at': createdAt,
      'updated_at': updatedAt,
      'message_count': messageCount,
      'is_synced': isSynced ? 1 : 0,
      // isRunning 是运行时状态，不持久化到 DB
    };
  }

  SessionMeta copyWith({
    String? title,
    int? updatedAt,
    int? messageCount,
    bool? isSynced,
    bool? isRunning,
    SessionTaskState? taskState,
  }) {
    return SessionMeta(
      id: id,
      workspacePath: workspacePath,
      workspaceName: workspaceName,
      title: title ?? this.title,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      messageCount: messageCount ?? this.messageCount,
      isSynced: isSynced ?? this.isSynced,
      isRunning: isRunning ?? this.isRunning,
      taskState: taskState ?? this.taskState,
    );
  }
}
