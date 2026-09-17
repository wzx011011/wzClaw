/// 悬浮窗数据模型：session/goal 快照 + session/subagents 线程。
///
/// 数据源实测（2026-09-15 probe-panel*.js，见 relay/zcode/APP-SERVER.md）：
/// - goal 顶层：{messages, projection, ..., goalStats, todos, todoGroups}
/// - todos: [{content, priority, status}]（TodoWrite 形状 + priority）
/// - todoGroups: [{id, source, startedAt, updatedAt, todos:[...]}]
/// - goalStats: {contextUsed, contextWindow, iterationCount, timeUsedSeconds,
///   tokensUsed, toolCallCount, tokenBudget}
class GoalTodo {
  final String content;
  final String priority;
  final String status; // pending | in_progress | completed
  final String activeForm;

  const GoalTodo({
    required this.content,
    this.priority = '',
    this.status = 'pending',
    this.activeForm = '',
  });

  bool get isCompleted => status == 'completed';
  bool get isInProgress => status == 'in_progress';

  static GoalTodo fromJson(Map<dynamic, dynamic> m) => GoalTodo(
        content: m['content']?.toString() ?? '',
        priority: m['priority']?.toString() ?? '',
        status: m['status']?.toString() ?? 'pending',
        activeForm: m['activeForm']?.toString() ?? '',
      );

  /// 旧协议 todo:updated 行形状（ChatStore._handleTodoUpdated 消费）
  Map<String, String> toLegacyTodo() => {
        'content': content,
        'status': status,
        'activeForm': activeForm,
      };
}

class GoalGroup {
  final String id;
  final String source;
  final int startedAt;
  final int updatedAt;
  final List<GoalTodo> todos;

  const GoalGroup({
    required this.id,
    required this.source,
    required this.startedAt,
    required this.updatedAt,
    required this.todos,
  });

  int get completedCount => todos.where((t) => t.isCompleted).length;
  int get totalCount => todos.length;

  bool get isPlan => source.isNotEmpty && source != 'session';

  static GoalGroup fromJson(Map<dynamic, dynamic> m) => GoalGroup(
        id: m['id']?.toString() ?? '',
        source: m['source']?.toString() ?? '',
        startedAt: (m['startedAt'] as num?)?.toInt() ?? 0,
        updatedAt: (m['updatedAt'] as num?)?.toInt() ?? 0,
        todos: (m['todos'] as List? ?? [])
            .whereType<Map>()
            .map(GoalTodo.fromJson)
            .toList(),
      );
}

class GoalStats {
  final int contextUsed;
  final int contextWindow;
  final int iterationCount;
  final int timeUsedSeconds;
  final int tokensUsed;
  final int toolCallCount;

  const GoalStats({
    required this.contextUsed,
    required this.contextWindow,
    required this.iterationCount,
    required this.timeUsedSeconds,
    required this.tokensUsed,
    required this.toolCallCount,
  });

  double get contextRatio =>
      contextWindow <= 0 ? 0 : contextUsed / contextWindow;

  static GoalStats fromJson(Map<dynamic, dynamic> m) => GoalStats(
        contextUsed: (m['contextUsed'] as num?)?.toInt() ?? 0,
        contextWindow: (m['contextWindow'] as num?)?.toInt() ?? 0,
        iterationCount: (m['iterationCount'] as num?)?.toInt() ?? 0,
        timeUsedSeconds: (m['timeUsedSeconds'] as num?)?.toInt() ?? 0,
        tokensUsed: (m['tokensUsed'] as num?)?.toInt() ?? 0,
        toolCallCount: (m['toolCallCount'] as num?)?.toInt() ?? 0,
      );
}

class GoalSnapshot {
  final List<GoalTodo> todos;
  final List<GoalGroup> groups;
  final GoalStats? stats;

  const GoalSnapshot({
    required this.todos,
    required this.groups,
    this.stats,
  });

  bool get isEmpty => todos.isEmpty && groups.isEmpty;

  /// 当前活跃目标组（有未完成项的最新组）；无则 null
  GoalGroup? get activeGroup {
    for (final g in groups) {
      if (g.completedCount < g.totalCount) return g;
    }
    return groups.isEmpty ? null : groups.last;
  }

  /// 计划板块（source 非 session 的组）
  List<GoalGroup> get plans => groups.where((g) => g.isPlan).toList();

  static GoalSnapshot fromEngineJson(Map<dynamic, dynamic> r) => GoalSnapshot(
        todos: (r['todos'] as List? ?? [])
            .whereType<Map>()
            .map(GoalTodo.fromJson)
            .toList(),
        groups: (r['todoGroups'] as List? ?? [])
            .whereType<Map>()
            .map(GoalGroup.fromJson)
            .toList(),
        stats: r['goalStats'] is Map
            ? GoalStats.fromJson(Map<dynamic, dynamic>.from(r['goalStats'] as Map))
            : null,
      );
}

/// 子智能体线程：session/subagents {action:'show'} 的 messages 行按
/// info.agent 聚合。行结构与会话消息一致（info+parts）。
class SubagentThread {
  final String agent;
  final List<Map<String, dynamic>> messages; // 旧协议消息行（_mapEngineMessage）

  const SubagentThread({required this.agent, required this.messages});

  /// 展示名：优先 agent 名，取末段（如 "general-purpose"）
  String get label => agent.isEmpty ? '子智能体' : agent;

  static const mainAgent = 'zcode-agent';
}

/// 引擎 session/goal 响应 → 快照（薄封装：校验与默认值在 fromEngineJson）
GoalSnapshot parseGoalSnapshot(dynamic result) {
  if (result is! Map) return const GoalSnapshot(todos: [], groups: []);
  return GoalSnapshot.fromEngineJson(result);
}
