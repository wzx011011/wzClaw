import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/models/ui_prefs.dart';
import 'package:wzxclaw_android/models/goal_snapshot.dart';
import 'package:wzxclaw_android/services/git_service.dart';
import 'package:wzxclaw_android/widgets/git_action_sheets.dart'
    show formatThousands;
import 'package:wzxclaw_android/widgets/status_panel_card.dart';

GoalTodo _todo(String content, String status) => GoalTodo(
      content: content,
      status: status,
      activeForm: status == 'in_progress' ? '正在$content' : '',
    );

GoalGroup _group(List<GoalTodo> todos) => GoalGroup(
      id: 'g1',
      source: 'session',
      startedAt: 1000,
      updatedAt: 2000,
      todos: todos,
    );

StatusPanelData _data({
  GitRepoStatus? git,
  GoalSnapshot? goal,
  List<SubagentThread> threads = const [],
}) =>
    StatusPanelData(
      git: git,
      goal: goal ?? const GoalSnapshot(todos: [], groups: [], stats: null),
      threads: threads,
    );

Widget _wrap(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
      home: Scaffold(body: child),
    );

/// FloatingStatusPanel 返回 Positioned，必须放进 Stack
Widget _wrapStack(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
      home: Scaffold(body: Stack(children: [child])),
    );

void main() {
  test('capsuleLabel 优先级：git 变更 > 目标进度 > 智能体 > 默认', () {
    expect(
      _data().capsuleLabel(),
      '状态',
    );
    expect(
      _data(
        goal: GoalSnapshot(
          todos: const [],
          groups: [
            _group([_todo('a', 'completed'), _todo('b', 'pending')]),
          ],
        ),
      ).capsuleLabel(),
      '1/2',
    );
    expect(
      _data(
        git: const GitRepoStatus(
          branch: 'main',
          dirty: 3,
          added: 10,
          removed: 2,
        ),
      ).capsuleLabel(),
      '+10 -2',
    );
    expect(
      _data(
        threads: [
          const SubagentThread(agent: 'Explore', messages: []),
        ],
      ).capsuleLabel(),
      '1 智能体',
    );
  });

  testWidgets('Git 板块：+N -M 真实统计 + 分支行可点开分支抽屉', (tester) async {
    String? openedPath;
    await tester.pumpWidget(
      _wrap(
        StatusPanelCard(
          data: _data(
            git: const GitRepoStatus(
              branch: 'feat/panel',
              dirty: 3,
              added: 7768,
              removed: 3594,
            ),
          ),
          onClose: () {},
          onCollapse: () {},
          onRefresh: () {},
          onOpenGoalPanel: () {},
          onGitActionDone: () {},
          onOpenBranchSheet: (p) => openedPath = p,
          workspacePath: 'E:/proj',
        ),
      ),
    );

    expect(find.text('Git 工具'), findsOneWidget); // 卡片头即板块标题
    expect(find.text('+7,768'), findsOneWidget); // 千分位（官方同款）
    expect(find.text('-3,594'), findsOneWidget);
    expect(find.text('更改'), findsOneWidget);
    expect(find.text('feat/panel'), findsOneWidget);

    await tester.tap(find.text('feat/panel'));
    expect(openedPath, 'E:/proj');
  });

  testWidgets('非 git 仓库：隐藏数据行，如实显示「当前目录不是 git 仓库」', (tester) async {
    await tester.pumpWidget(
      _wrap(
        StatusPanelCard(
          data: _data(),
          onClose: () {},
          onCollapse: () {},
          onRefresh: () {},
          onOpenGoalPanel: () {},
          onGitActionDone: () {},
          onOpenBranchSheet: (_) {},
          workspacePath: 'E:/plain',
        ),
      ),
    );

    expect(find.text('当前目录不是 git 仓库'), findsOneWidget);
    expect(find.text('+0'), findsNothing);
  });

  testWidgets('目标板块：goalStats 计时/迭代 + 活跃组进度', (tester) async {
    await tester.pumpWidget(
      _wrap(
        StatusPanelCard(
          data: _data(
            goal: GoalSnapshot(
              todos: const [],
              groups: [
                _group([
                  _todo('调研', 'completed'),
                  _todo('实现', 'in_progress'),
                  _todo('验证', 'pending'),
                ]),
              ],
              stats: const GoalStats(
                contextUsed: 0,
                contextWindow: 1,
                iterationCount: 3,
                timeUsedSeconds: 2 * 3600 + 22 * 60 + 38,
                tokensUsed: 0,
                toolCallCount: 0,
              ),
            ),
          ),
          onClose: () {},
          onCollapse: () {},
          onRefresh: () {},
          onOpenGoalPanel: () {},
          onGitActionDone: () {},
          onOpenBranchSheet: (_) {},
        ),
      ),
    );

    expect(find.text('目标'), findsOneWidget);
    expect(find.text('2小时22分38秒'), findsOneWidget);
    // 官方卡片行不展示迭代数（对齐截图）
    expect(find.text('第 3 次迭代'), findsNothing);
    expect(find.text('1/3'), findsNWidgets(2)); // 目标进度 + 进程计数各一处
    expect(find.text('正在实现'), findsOneWidget); // 进程行 activeForm
  });

  testWidgets('进程板块：已完成项默认折叠，点按展开显示删除线', (tester) async {
    await tester.pumpWidget(
      _wrap(
        StatusPanelCard(
          data: _data(
            goal: GoalSnapshot(
              todos: const [],
              groups: [
                _group([
                  _todo('已完成任务', 'completed'),
                  _todo('待办任务', 'pending'),
                ]),
              ],
            ),
          ),
          onClose: () {},
          onCollapse: () {},
          onRefresh: () {},
          onOpenGoalPanel: () {},
          onGitActionDone: () {},
          onOpenBranchSheet: (_) {},
        ),
      ),
    );

    expect(find.text('已完成 1 项'), findsOneWidget);
    expect(find.text('已完成任务'), findsNothing); // 折叠时不显示
    expect(find.text('待办任务'), findsNWidgets(2)); // 目标行回退 + 进程行

    await tester.tap(find.text('已完成 1 项'));
    await tester.pump();
    expect(find.text('收起 1 项已完成'), findsOneWidget);
    expect(find.text('已完成任务'), findsOneWidget); // 展开后可见
  });

  testWidgets('智能体板块：线程计数与摘要；tap 目标板块跳任务面板', (tester) async {
    var opened = false;
    await tester.pumpWidget(
      _wrap(
        StatusPanelCard(
          data: _data(
            threads: [
              const SubagentThread(
                agent: 'Explore',
                messages: [
                  {'role': 'assistant'},
                  {'role': 'assistant'},
                ],
              ),
            ],
          ),
          onClose: () {},
          onCollapse: () {},
          onRefresh: () {},
          onOpenGoalPanel: () => opened = true,
          onGitActionDone: () {},
          onOpenBranchSheet: (_) {},
        ),
      ),
    );

    expect(find.text('智能体'), findsOneWidget);
    expect(find.text('Explore · 2 条消息'), findsOneWidget);

    await tester.tap(find.text('目标'));
    expect(opened, isTrue);
  });

  group('目标 ▶/暂停按钮（engine pause/resume 实测通道）', () {
    GoalSnapshot goalWithTarget(String status) => GoalSnapshot(
          todos: const [],
          groups: [
            _group([_todo('a', 'pending')]),
          ],
          target: GoalTarget(
            targetId: 't1',
            objective: '探明信息后完整实现',
            timeUsedSeconds: 8538,
            status: status,
          ),
        );

    testWidgets('paused → ▶ 恢复按钮，tap 回调 resume', (tester) async {
      String? action;
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(goal: goalWithTarget('paused')),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
            onGoalAction: (a) => action = a,
          ),
        ),
      );

      expect(find.byIcon(Icons.play_arrow), findsOneWidget);
      await tester.tap(find.byIcon(Icons.play_arrow));
      expect(action, 'resume');
    });

    testWidgets('active → 暂停按钮，tap 回调 pause', (tester) async {
      String? action;
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(goal: goalWithTarget('active')),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
            onGoalAction: (a) => action = a,
          ),
        ),
      );

      expect(find.byIcon(Icons.pause), findsOneWidget);
      await tester.tap(find.byIcon(Icons.pause));
      expect(action, 'pause');
    });

    testWidgets('无 target：不渲染控制按钮', (tester) async {
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );

      expect(find.byIcon(Icons.play_arrow), findsNothing);
      expect(find.byIcon(Icons.pause), findsNothing);
    });

    testWidgets('verifying 等过渡态不渲染控制按钮', (tester) async {
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(goal: goalWithTarget('verifying')),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );

      expect(find.byIcon(Icons.play_arrow), findsNothing);
      expect(find.byIcon(Icons.pause), findsNothing);
    });
  });

  group('展开策略（auto/expanded/collapsed）', () {
    test('label 与 fromName 往返', () {
      expect(StatusPanelStrategy.auto.label, '自动展开');
      expect(StatusPanelStrategy.expanded.label, '始终展开');
      expect(StatusPanelStrategy.collapsed.label, '始终收起');
      expect(
        StatusPanelStrategy.fromName('collapsed'),
        StatusPanelStrategy.collapsed,
      );
      expect(StatusPanelStrategy.fromName(null), StatusPanelStrategy.auto);
      expect(StatusPanelStrategy.fromName('bad'), StatusPanelStrategy.auto);
    });

    testWidgets('expanded → 卡片；collapsed → 胶囊', (tester) async {
      UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.expanded;
      await tester.pumpWidget(
        _wrapStack(
          FloatingStatusPanel(
            onClose: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Git 工具'), findsOneWidget);

      UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.collapsed;
      await tester.pumpWidget(
        _wrapStack(
          FloatingStatusPanel(
            onClose: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Git 工具'), findsNothing); // 胶囊无完整卡片
      expect(find.text('状态'), findsOneWidget); // 空数据胶囊摘要
      UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.auto;
    });

    testWidgets('auto：空闲胶囊、运行中展开', (tester) async {
      UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.auto;
      await tester.pumpWidget(
        _wrapStack(
          FloatingStatusPanel(
            onClose: () {},
            onOpenBranchSheet: (_) {},
            sessionBusy: false,
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Git 工具'), findsNothing); // 空闲 → 胶囊

      await tester.pumpWidget(
        _wrapStack(
          FloatingStatusPanel(
            onClose: () {},
            onOpenBranchSheet: (_) {},
            sessionBusy: true,
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Git 工具'), findsOneWidget); // 运行中 → 卡片
      UiPrefs.statusPanelStrategy.value = StatusPanelStrategy.auto;
    });
  });

  group('官方实况对齐（2026-09-19 浏览器实测）', () {
    test('formatThousands：千分位与负数', () {
      expect(formatThousands(10760), '10,760');
      expect(formatThousands(-3809), '-3,809');
      expect(formatThousands(0), '0');
      expect(formatThousands(999), '999');
    });

    testWidgets('目标完成态：计时旁绿色 ✓', (tester) async {
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(
              goal: GoalSnapshot(
                todos: const [],
                groups: [
                  _group([_todo('a', 'completed')]),
                ],
                target: const GoalTarget(
                  targetId: 't1',
                  objective: '现在实现功能需求',
                  timeUsedSeconds: 21 * 60 + 28,
                  status: 'complete',
                ),
              ),
            ),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );

      expect(find.text('21分28秒'), findsOneWidget);
      // 完成态 ✓（进程行也是 check_circle → 至少一个）
      expect(find.byIcon(Icons.check_circle), findsWidgets);
      expect(find.text('现在实现功能需求'), findsOneWidget);
      expect(find.text('1/1'), findsNWidgets(2)); // 目标行 + 进程行
    });

    testWidgets('进程全完成：全部展开直出，无折叠头', (tester) async {
      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(
              goal: GoalSnapshot(
                todos: const [],
                groups: [
                  _group([
                    _todo('任务一', 'completed'),
                    _todo('任务二', 'completed'),
                    _todo('任务三', 'completed'),
                  ]),
                ],
              ),
            ),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
          ),
        ),
      );

      // 官方实测（全删除线直出）：无折叠头，全部行可见
      expect(find.textContaining('已完成'), findsNothing);
      expect(find.byIcon(Icons.expand_more), findsNothing);
      // 任务一 = 目标行回退 + 进程行；任务二/三 = 进程行
      expect(find.text('任务一'), findsNWidgets(2));
      expect(find.text('任务二'), findsOneWidget);
      expect(find.text('任务三'), findsOneWidget);
    });

    testWidgets('提交或推送：一步式 sheet 直开（分支行/千分位/文件计数/三动作）', (tester) async {
      GitService.debugRequester = (method, [params]) async {
        switch (method) {
          case 'x/git/status':
            return {'branch': 'feat/x', 'dirty': 62};
          case 'x/git/diffstat':
            return {'added': 10760, 'removed': 3809, 'files': 62};
          case 'x/git/pushinfo':
            return {
              'branch': 'feat/x',
              'hasRemote': true,
              'upstream': 'origin/feat/x',
              'ahead': 0,
              'behind': 0,
            };
        }
        throw StateError('unexpected $method');
      };
      addTearDown(() => GitService.debugRequester = null);

      await tester.pumpWidget(
        _wrap(
          StatusPanelCard(
            data: _data(
              git: const GitRepoStatus(
                branch: 'feat/x',
                dirty: 62,
                added: 10760,
                removed: 3809,
              ),
            ),
            onClose: () {},
            onCollapse: () {},
            onRefresh: () {},
            onOpenGoalPanel: () {},
            onGitActionDone: () {},
            onOpenBranchSheet: (_) {},
            workspacePath: 'E:/proj',
          ),
        ),
      );

      await tester.tap(find.text('提交或推送'));
      await tester.pumpAndSettle();

      // 一步式 sheet：全要素内联（官方布局）
      expect(find.text('feat/x'), findsWidgets);
      expect(find.text('+10,760'), findsNWidgets(2)); // 卡片 + sheet 顶行
      expect(find.text('-3,809'), findsNWidgets(2)); // 卡片 + sheet 顶行
      expect(find.text('提交信息'), findsOneWidget); // placeholder
      expect(find.text('包含未暂存的更改'), findsOneWidget);
      expect(find.text('62 个文件'), findsOneWidget);
      expect(find.text('提交'), findsOneWidget);
      expect(find.text('提交并推送'), findsOneWidget);
      // 有 upstream 且 ahead=0 → 推送禁用（官方「没有需要推送的提交」）
      final pushRow = find.widgetWithText(InkWell, '推送');
      expect(pushRow, findsOneWidget);
      final inkwell = tester.widget<InkWell>(pushRow);
      expect(inkwell.onTap, isNull); // 禁用态
    });
  });
}
