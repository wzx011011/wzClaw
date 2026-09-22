// ============================================================
// goal_store — 目标/计划面板状态（R3 直连栈版）
//
// 数据流：面板打开/下拉时经 ConnectionManager.zcodeRequest 拉
// session/goal（引擎实测接口），parseGoalSnapshot 解析后通知 UI。
// 子智能体线程依赖引擎消息映射器，R2 用直连栈重建（当前为空态）。
// 另订阅聊天容器：回合边界（isStreaming 翻转）自动刷新——面板
// 「会话运行中会自动更新」的承诺由此兑现，悬浮胶囊同享新鲜数据。
// ============================================================

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/goal_snapshot.dart';
import '../zcode/zcode_chat_store.dart';

class GoalStore extends ChangeNotifier {
  /// 测试注入替身；默认挂全局聊天容器单例
  GoalStore({ZcodeChatStore? chatStore})
      : _chat = chatStore ?? ZcodeChatStore.instance {
    _chat.addListener(_onChatStoreChanged);
  }

  final ZcodeChatStore _chat;

  static final GoalStore instance = GoalStore();

  GoalSnapshot _snapshot = const GoalSnapshot(todos: [], groups: []);
  bool _loading = false;

  GoalSnapshot get snapshot => _snapshot;
  bool get loading => _loading;

  List<SubagentThread> _threads = const [];

  /// 子智能体线程（session/subagents，经 ZcodeChatStore 映射聚合）
  List<SubagentThread> get threads => List.unmodifiable(_threads);

  /// 上一采样的回合在途态（翻转 = 回合边界）
  bool _lastTurnBusy = false;

  /// 聊天容器通知 → 回合边界检测。流式中的逐增量通知在这里被
  /// 挡掉，只有 false→true（回合开始）与 true→false（回合结束）
  /// 两个边界各触发一次刷新。
  void _onChatStoreChanged() {
    final busy =
        _chat.isStreaming || _chat.isWaitingForResponse;
    if (busy == _lastTurnBusy) return;
    _lastTurnBusy = busy;
    unawaited(refresh());
  }

  /// 主动刷新（面板进入/下拉/回合边界）：session/goal → 快照 → notify。
  /// 无活动会话或未连接时清空（面板显示空态，不阻断）。
  Future<void> refresh() async {
    final sid = _chat.activeSessionId;
    if (sid == null || sid.isEmpty) {
      _snapshot = const GoalSnapshot(todos: [], groups: []);
      notifyListeners();
      return;
    }
    _loading = true;
    notifyListeners();
    try {
      final result = await _chat.goalShow();
      _snapshot = parseGoalSnapshot(result);
      _threads = await _chat.fetchSubagentThreads();
    } catch (e) {
      // 会话未在本进程 materialize 等场景返回错误：静默（面板显示空态）
      debugPrint('[goal-store] goal snapshot failed: $e');
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _chat.removeListener(_onChatStoreChanged);
    super.dispose();
  }
}
