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

/// 面板数据三态（柱5，2026-09-22）：legacy 协议拿不到官方的同订阅
/// state 补丁，面板靠拉取刷新——「真空」「有数据」「刷新失败（保留
/// 旧数据）」必须可区分，否则链路断时面板显示的旧数据会被当成实时
/// （官方 SubagentDirectorySidePane 同款：失败显示错误并保留旧数据）。
enum GoalLoadPhase { idle, ready, failed }

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

  GoalLoadPhase _phase = GoalLoadPhase.idle;
  DateTime? _lastSuccessAt;
  String? _lastError;

  /// 刷新序号守卫：并发刷新（回合边界 + 下拉同时触发）时晚到的旧请求
  /// 不得覆盖新快照（评审 P3）
  int _refreshSeq = 0;

  GoalSnapshot get snapshot => _snapshot;
  bool get loading => _loading;
  GoalLoadPhase get phase => _phase;

  /// 最近一次成功刷新时间（failed 态下面板标注数据的新鲜度）
  DateTime? get lastSuccessAt => _lastSuccessAt;
  String? get lastError => _lastError;

  /// 失败态提示文案（柱5 单一真相：悬浮卡与全屏面板共用同一份措辞——
  /// 有旧数据时标注其时间，无数据直说失败）
  String get staleLabel {
    final t = _lastSuccessAt;
    if (t == null) return '数据拉取失败，下拉重试';
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '数据更新失败，显示 $hh:$mm 的旧数据 · 下拉重试';
  }

  List<SubagentThread> _threads = const [];

  /// 子智能体线程（session/subagents，经 ZcodeChatStore 映射聚合）
  List<SubagentThread> get threads => List.unmodifiable(_threads);

  /// 上一采样的回合在途态（翻转 = 回合边界）
  bool _lastTurnBusy = false;

  /// 上一采样的连接态（matched 边沿 = 链路恢复，恢复即对账）
  ZcodeConnState _lastConn = ZcodeConnState.idle;

  /// 聊天容器通知 → 刷新触发：
  /// - 回合边界（busy 翻转）：面板「运行中自动更新」承诺（原有）；
  /// - 连接恢复（connState → matched 边沿）：frpc 隧道僵死恢复后面板
  ///   自动对账，不再依赖手动下拉（2026-09-22 实测缺口）。
  /// 流式中的逐增量通知在这里被挡掉。
  void _onChatStoreChanged() {
    final busy = _chat.isStreaming || _chat.isWaitingForResponse;
    final conn = _chat.connState;
    final connRestored =
        conn == ZcodeConnState.matched && _lastConn != ZcodeConnState.matched;
    final busyFlipped = busy != _lastTurnBusy;
    _lastConn = conn;
    if (!busyFlipped && !connRestored) return;
    _lastTurnBusy = busy;
    unawaited(refresh());
  }

  /// 主动刷新（面板进入/下拉/回合边界/链路恢复）：session/goal +
  /// session/subagents → 快照 → notify。无活动会话时清空（真空态）；
  /// 拉取失败保留旧快照并置 failed（stale-but-labeled，绝不静默清空）。
  Future<void> refresh() async {
    final sid = _chat.activeSessionId;
    if (sid == null || sid.isEmpty) {
      _snapshot = const GoalSnapshot(todos: [], groups: []);
      _threads = const [];
      _phase = GoalLoadPhase.idle;
      notifyListeners();
      return;
    }
    final seq = ++_refreshSeq;
    _loading = true;
    notifyListeners();
    try {
      final result = await _chat.goalShow();
      final threads = await _chat.fetchSubagentThreads();
      // 在途期间又发起了新刷新：本次结果作废（晚到者覆盖新快照 = 面板回跳）
      if (seq != _refreshSeq) return;
      // 会话已切走：旧会话的结果不得贴到新会话视图（seq 只防并发不防换靶，
      // 两个空闲会话间切换无 busy 翻转，S1 的在途结果会冒充 S2 的面板）。
      // 视口已不属于发起时的会话 → 直接作废，等新会话自己的刷新。
      if (_chat.activeSessionId != sid) return;
      _snapshot = parseGoalSnapshot(result);
      _threads = threads;
      _phase = GoalLoadPhase.ready;
      _lastSuccessAt = DateTime.now();
      _lastError = null;
    } catch (e) {
      debugPrint('[goal-store] goal snapshot failed: $e');
      // 有更新的刷新在途：失败态由它裁决，这里不覆盖
      if (seq != _refreshSeq) return;
      // 同上：会话已切走时失败态也不得标到新会话头上
      if (_chat.activeSessionId != sid) return;
      _phase = GoalLoadPhase.failed;
      _lastError = e.toString();
    } finally {
      if (seq == _refreshSeq) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _chat.removeListener(_onChatStoreChanged);
    super.dispose();
  }
}
