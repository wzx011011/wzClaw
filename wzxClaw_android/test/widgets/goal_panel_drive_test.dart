// ============================================================
// goal_panel_drive_test — 任务面板真链路驱动验证
//
// 与 status_panel_card_test（纯渲染入参）互补：本文件把 fake relay
// 服务端挂到真实 ZcodeChatStore 单例上，经 GoalStore.instance 驱动
// 真实 GoalPanelPage / FloatingStatusPanel，验证「柱5」承诺：
// 真空态 / 有数据态 / 失败态（保留旧数据且显式标注）/ 重连自动对账，
// 以及 /goal 斜杠命令的真正接线（session/goal set）。
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/ui_prefs.dart';
import 'package:wzxclaw_android/pages/goal_panel_page.dart';
import 'package:wzxclaw_android/services/goal_store.dart';
import 'package:wzxclaw_android/widgets/status_panel_card.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import '../zcode/zcode_test_fakes.dart';

Widget _wrapPage(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
      home: Scaffold(body: child),
    );

/// FloatingStatusPanel 返回 Positioned，必须放进 Stack
Widget _wrapStack(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
      home: Scaffold(body: Stack(children: [child])),
    );

/// 富快照（目标组 + 计划组 + 清单 + 统计 + target）
Map<String, dynamic> richGoal(String objective) => {
      'snapshot': {
        'todos': [
          {
            'content': '当前清单项',
            'status': 'in_progress',
            'priority': 'high',
            'activeForm': '正在驱动面板',
          },
        ],
        'todoGroups': [
          {
            'id': 'g1',
            'source': 'session',
            'startedAt': 1000,
            'updatedAt': 2000,
            'todos': [
              {'content': '调研', 'status': 'completed', 'priority': 'high'},
              {
                'content': '实现',
                'status': 'in_progress',
                'priority': 'high',
                'activeForm': '正在实现',
              },
              {'content': '验证', 'status': 'pending', 'priority': 'medium'},
            ],
          },
          {
            'id': 'p1',
            'source': 'plan',
            'startedAt': 3000,
            'updatedAt': 4000,
            'todos': [
              {'content': '计划步骤A', 'status': 'pending', 'priority': 'medium'},
            ],
          },
        ],
        'goalStats': {
          'contextUsed': 30000,
          'contextWindow': 200000,
          'iterationCount': 4,
          'timeUsedSeconds': 95,
          'tokensUsed': 12345,
          'toolCallCount': 7,
        },
        'projection': {
          'target': {
            'targetId': 't1',
            'objective': objective,
            'timeUsedSeconds': 95,
            'status': 'active',
          },
        },
      },
    };

Map<String, dynamic> twoThreads() => {
      'running': [],
      'ended': {
        'total': 2,
        'items': [
          {
            'childSessionId': 'c1',
            'subagentType': 'Explore',
            'status': 'success',
            'summary': '探索结论第一行\n第二行',
            'startedAt': 100,
          },
          {
            'childSessionId': 'c2',
            'subagentType': 'general-purpose',
            'status': 'success',
            'summary': '通用代理结论',
            'startedAt': 200,
          },
        ],
      },
    };

/// 把 fake relay 挂到真实单例链（GoalPanelPage/FloatingStatusPanel
/// 都读 GoalStore.instance → ZcodeChatStore.instance）
FakeZcodeRelayClient _bindRealChain() {
  final fake = FakeZcodeRelayClient();
  FakeSessionServer().bind(fake);
  ZcodeChatStore.instance.attach(
    fake,
    desktopId: 'device-sid-1',
    desktopName: '测试桌面',
  );
  return fake;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    ZcodeNotifier.resetInstanceForTest();
  });

  tearDown(() {
    UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.auto;
  });

  // 大视口：GoalPanelPage 是懒加载 ListView，小视口下折叠区外不构建
  void useTallViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }

  testWidgets('真空态：无活动会话显示「暂无任务数据」引导文案', (tester) async {
    useTallViewport(tester);
    _bindRealChain();
    await tester.pumpWidget(_wrapPage(const GoalPanelPage()));
    await tester.pump();

    expect(find.text('任务面板'), findsOneWidget); // AppBar 标题
    expect(find.text('暂无任务数据'), findsOneWidget);
    expect(find.text('会话运行中会自动更新，或下拉重新拉取'), findsOneWidget);
    expect(GoalStore.instance.phase, GoalLoadPhase.idle);
  });

  testWidgets('有数据态：目标组/进程/计划/智能体四板块真实渲染，线程可展开', (tester) async {
    useTallViewport(tester);
    final fake = _bindRealChain();
    fake.handlers['session/goal'] = (_) => richGoal('完整验证任务面板');
    fake.handlers['session/subagents'] = (_) => twoThreads();
    await ZcodeChatStore.instance.openSession('sess-panel');

    await tester.pumpWidget(_wrapPage(const GoalPanelPage()));
    await tester.pump();

    // 目标板块：组卡片 + 进度比 + activeForm
    expect(find.text('目标组 #g1'), findsOneWidget);
    expect(find.text('1/3'), findsOneWidget);
    expect(find.text('正在实现'), findsOneWidget);
    expect(find.text('调研'), findsOneWidget);
    // 计划板块：source=plan 的组（目标板块列出全部组、计划板块再列
    // plan 组——计划组在页面上出现两次，钉住现行为）
    expect(find.textContaining('（计划）'), findsNWidgets(2));
    expect(find.text('计划步骤A'), findsNWidgets(2));
    // 进程板块：当前清单 + 上下文占用
    expect(find.text('正在驱动面板'), findsOneWidget);
    expect(find.text('30.0k/200.0k'), findsOneWidget);
    // 智能体板块：按 subagentType 聚合、最新在前
    expect(find.text('general-purpose · 1 条消息'), findsOneWidget);
    expect(find.text('Explore · 1 条消息'), findsOneWidget);
    expect(find.text('探索结论第一行'), findsOneWidget); // 折叠态摘要（首行）

    // 展开线程卡：完整消息体可见
    await tester.tap(find.text('Explore · 1 条消息'));
    await tester.pump();
    expect(find.text('探索结论第一行\n第二行'), findsOneWidget);
    expect(GoalStore.instance.phase, GoalLoadPhase.ready);
  });

  testWidgets('失败态：拉取失败保留旧数据，悬浮卡显式标注「旧数据 · 下拉重试」', (tester) async {
    useTallViewport(tester);
    final fake = _bindRealChain();
    fake.handlers['session/goal'] = (_) => richGoal('完整验证任务面板');
    fake.handlers['session/subagents'] = (_) => twoThreads();
    await ZcodeChatStore.instance.openSession('sess-panel');
    await GoalStore.instance.refresh();
    expect(GoalStore.instance.phase, GoalLoadPhase.ready);

    fake.handlers['session/goal'] = (_) => throw Exception('rpc dead');
    fake.handlers['session/subagents'] = (_) => throw Exception('rpc dead');
    await GoalStore.instance.refresh();
    expect(GoalStore.instance.phase, GoalLoadPhase.failed);

    // 悬浮状态卡：失败标注 + 旧数据并存（stale-but-labeled）
    UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.expanded;
    await tester.pumpWidget(
      _wrapStack(
        FloatingStatusPanel(onClose: () {}, onOpenBranchSheet: (_) {}),
      ),
    );
    await tester.pump();
    expect(find.textContaining('数据更新失败，显示'), findsOneWidget);
    expect(find.textContaining('旧数据 · 下拉重试'), findsOneWidget);
    expect(find.text('完整验证任务面板'), findsOneWidget); // 旧数据未被清掉
    expect(find.text('1/3'), findsNWidgets(2)); // 目标行 + 进程计数

    // 全屏任务面板：旧数据同样保留，且带同一份失败标注（GoalStore.staleLabel）
    await tester.pumpWidget(_wrapPage(const GoalPanelPage()));
    await tester.pump();
    expect(find.text('完整验证任务面板'), findsNothing); // 全屏页不渲染 target 文本
    expect(find.text('目标组 #g1'), findsOneWidget); // 旧组数据仍在
    expect(find.textContaining('数据更新失败，显示'), findsOneWidget); // 失败标注
  });

  testWidgets('重连自动对账：connState matched 边沿后面板自动显示新数据', (tester) async {
    useTallViewport(tester);
    final fake = _bindRealChain();
    fake.handlers['session/goal'] = (_) => richGoal('重连前的旧目标');
    fake.handlers['session/subagents'] = (_) => twoThreads();
    final chat = ZcodeChatStore.instance;
    await chat.openSession('sess-panel');

    await tester.pumpWidget(_wrapPage(const GoalPanelPage()));
    await tester.pump();
    expect(find.text('目标组 #g1'), findsOneWidget);

    // 隧道僵死 → 恢复：期间服务端数据已变化（模拟对账后新快照）
    fake.handlers['session/goal'] = (_) => richGoal('重连后的新目标');
    chat.ingestRelayState(ZcodeRelayState.closed, false);
    await tester.pump();
    chat.ingestRelayState(ZcodeRelayState.matched, true);
    await tester.pump();

    // 无手动下拉：面板经恢复边沿自动刷新。goal 快照里 objective 不直接
    // 上全屏页，用清单内容变化验证新数据确实落地
    expect(GoalStore.instance.snapshot.target?.objective, '重连后的新目标');
    expect(GoalStore.instance.phase, GoalLoadPhase.ready);
    expect(GoalStore.instance.lastError, isNull);
  });

  testWidgets('/goal 斜杠命令接线：goalSet 发 session/goal set，面板随即显示新目标', (tester) async {
    useTallViewport(tester);
    final fake = _bindRealChain();
    final captured = <Map<String, dynamic>?>[];
    fake.handlers['session/goal'] = (params) {
      if (params?['action'] == 'set') {
        captured.add(params);
        return {'ok': true};
      }
      return richGoal('验证任务面板目标');
    };
    fake.handlers['session/subagents'] = (_) => twoThreads();
    final chat = ZcodeChatStore.instance;
    await chat.openSession('sess-panel');

    final ok = await chat.goalSet('验证任务面板目标');
    expect(ok, isTrue, reason: '/goal 设定必须成功');
    expect(captured, hasLength(1));
    expect(captured.single?['action'], 'set');
    expect(captured.single?['objective'], '验证任务面板目标');
    expect(captured.single?['sessionId'], 'sess-panel');

    // 面板刷新后悬浮卡显示新目标（objectiveText → StatusPanelCard 目标行）
    await GoalStore.instance.refresh();
    UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.expanded;
    await tester.pumpWidget(
      _wrapStack(
        FloatingStatusPanel(onClose: () {}, onOpenBranchSheet: (_) {}),
      ),
    );
    await tester.pump();
    expect(find.text('验证任务面板目标'), findsOneWidget);
    expect(find.text('1分35秒'), findsOneWidget); // target.timeUsedSeconds 计时
  });
}
