// ============================================================
// goal_store — 悬浮窗状态（目标/进程/计划/智能体四板块）
//
// 数据流：ConnectionManager 在回合边界/会话加载时拉 session/goal，
// 发 'zcode:goal:snapshot' 事件（并同步发旧 todo:updated 点亮既有
// Todo 面板）。本 store 持有快照 + 拉取子智能体线程（session/subagents
// {action:'show'}），供 GoalPanelPage 消费。
// ============================================================

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/connection_state.dart';
import '../models/goal_snapshot.dart';
import '../models/ws_message.dart';
import 'connection_manager.dart';
import 'session_sync_service.dart';
import 'ws_transport.dart';
import 'zcode_protocol_translate.dart';

class GoalStore extends ChangeNotifier {
  GoalStore({WsTransport? transport})
      : _transport = transport ?? ConnectionManager.instance {
    _transport.incoming.listen(_handleMessage);
    _transport.stateStream.listen(_handleState);
  }

  static final GoalStore instance = GoalStore();

  final WsTransport _transport;

  GoalSnapshot _snapshot = const GoalSnapshot(todos: [], groups: []);
  List<SubagentThread> _threads = const [];
  bool _loadingThreads = false;

  GoalSnapshot get snapshot => _snapshot;
  List<SubagentThread> get threads => List.unmodifiable(_threads);

  /// 快照/线程拉取钩子（测试注入用）；生产走 ConnectionManager
  @visibleForTesting
  Future<void> Function(String sessionId) refreshSnapshotHook =
      (sid) => ConnectionManager.instance.refreshGoalState(sid);
  @visibleForTesting
  Future<List<SubagentThread>> Function() fetchThreadsHook =
      () => ConnectionManager.instance.fetchSubagentThreads();
  /// 活跃会话提供者（测试注入用）；生产读 SessionSyncService
  @visibleForTesting
  String? Function()? activeSessionHook;

  /// 主动刷新（面板页进入时/下拉刷新）：拉快照 + 子线程。
  /// 快照会经 ConnectionManager 广播回本 store，无需在此赋值。
  Future<void> refresh() async {
    // 注意 hook 返回 null ≠ 回退全局：显式注入时以 hook 为准（可测）
    final sid = activeSessionHook != null
        ? activeSessionHook!()
        : SessionSyncService.instance.activeSessionId;
    if (sid != null && sid.isNotEmpty) {
      await refreshSnapshotHook(sid);
    }
    await _refreshThreads();
  }

  void _handleMessage(WsMessage msg) {
    if (msg.event != WsEvents.goalSnapshot) return;
    final d = msg.data is Map ? msg.data as Map : const {};
    // snapshot 可能是已解析对象（ConnectionManager 进程内广播）或原文 Map
    final s = d['snapshot'];
    _snapshot = s is GoalSnapshot ? s : parseGoalSnapshot(s);
    notifyListeners();
    // 快照更新通常伴随回合边界 → 子线程可能也变了
    unawaited(_refreshThreads());
  }

  void _handleState(WsConnectionState state) {
    if (state != WsConnectionState.disconnected) return;
    if (_snapshot.isEmpty && _threads.isEmpty) return;
    _snapshot = const GoalSnapshot(todos: [], groups: []);
    _threads = const [];
    notifyListeners();
  }

  Future<void> _refreshThreads() async {
    if (_loadingThreads) return;
    _loadingThreads = true;
    try {
      _threads = await fetchThreadsHook();
      notifyListeners();
    } catch (_) {
      // 尽力而为：线程拉取失败保留旧数据
    } finally {
      _loadingThreads = false;
    }
  }

  /// 清空（测试辅助/登出场景）
  @visibleForTesting
  void clear() {
    _snapshot = const GoalSnapshot(todos: [], groups: []);
    _threads = const [];
    notifyListeners();
  }
}
