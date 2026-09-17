// ============================================================
// goal_store — 目标/计划面板状态（R3 直连栈版）
//
// 数据流：面板打开/下拉时经 ConnectionManager.zcodeRequest 拉
// session/goal（引擎实测接口），parseGoalSnapshot 解析后通知 UI。
// 子智能体线程依赖引擎消息映射器，R2 用直连栈重建（当前为空态）。
// ============================================================

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/goal_snapshot.dart';
import '../zcode/zcode_chat_store.dart';
import 'connection_manager.dart';

class GoalStore extends ChangeNotifier {
  GoalStore();

  static final GoalStore instance = GoalStore();

  GoalSnapshot _snapshot = const GoalSnapshot(todos: [], groups: []);
  bool _loading = false;

  GoalSnapshot get snapshot => _snapshot;
  bool get loading => _loading;

  List<SubagentThread> _threads = const [];

  /// 子智能体线程（session/subagents，经 ZcodeChatStore 映射聚合）
  List<SubagentThread> get threads => List.unmodifiable(_threads);

  /// 主动刷新（面板进入/下拉）：session/goal → 快照 → notifyListeners。
  /// 无活动会话或未连接时清空（面板显示空态，不阻断）。
  Future<void> refresh() async {
    final sid = ZcodeChatStore.instance.activeSessionId;
    if (sid == null || sid.isEmpty) {
      _snapshot = const GoalSnapshot(todos: [], groups: []);
      notifyListeners();
      return;
    }
    _loading = true;
    notifyListeners();
    try {
      final result = await ConnectionManager.instance
          .zcodeRequest('session/goal', {'sessionId': sid});
      _snapshot = parseGoalSnapshot(result);
      _threads = await ZcodeChatStore.instance.fetchSubagentThreads();
    } catch (e) {
      // 会话未在本进程 materialize 等场景返回错误：静默（面板显示空态）
      debugPrint('[goal-store] goal snapshot failed: $e');
    } finally {
      _loading = false;
      notifyListeners();
    }
  }
}
