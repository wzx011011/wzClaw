/// Task model matching the wzxClaw desktop task store schema.
class TaskProject {
  final String id;
  final String name;
  final String path;

  const TaskProject({
    required this.id,
    required this.name,
    required this.path,
  });

  factory TaskProject.fromJson(Map<String, dynamic> json) => TaskProject(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        path: json['path'] as String? ?? '',
      );
}

class TaskModel {
  final String id;
  final String title;
  final String? description;
  final bool archived;
  final String? progressSummary;
  final List<TaskProject> projects;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const TaskModel({
    required this.id,
    required this.title,
    this.description,
    this.archived = false,
    this.progressSummary,
    this.projects = const [],
    this.createdAt,
    this.updatedAt,
  });

  factory TaskModel.fromJson(Map<String, dynamic> json) {
    final projectsRaw = json['projects'] as List<dynamic>? ?? [];
    return TaskModel(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      description: json['description'] as String?,
      archived: json['archived'] as bool? ?? false,
      progressSummary: json['progressSummary'] as String?,
      projects: projectsRaw
          .whereType<Map<String, dynamic>>()
          .map(TaskProject.fromJson)
          .toList(),
      createdAt: _parseDateTime(json['createdAt']),
      updatedAt: _parseDateTime(json['updatedAt']),
    );
  }

  /// Desktop sends timestamps as numbers (Date.now()); parse int, double, and string.
  static DateTime? _parseDateTime(dynamic value) {
    if (value == null) return null;
    if (value is num) return DateTime.fromMillisecondsSinceEpoch(value.toInt());
    return DateTime.tryParse(value.toString());
  }
}
