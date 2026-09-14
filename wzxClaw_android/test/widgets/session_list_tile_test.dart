// ============================================================
// session_list_tile_test — 会话瓦片 + 抽屉（zcode 换芯版）
//
// 数据源从旧 SessionMeta 改为 ZcodeSessionMeta；删除 messageCount /
// 缓存徽标 / 重命名删除用例（zcode 协议无对应能力），新增运行点
// （status == 'running'）与 updatedAt 缺失用例——工作区名移至抽屉
// 分组头显示，瓦片不再渲染。
// 附带 ProjectDrawer 冒烟用例：注入 paired store 替身 + 预置会话，
// 验证标题 / 工作区分组（组名 + 折叠）/ 文件入口 / 加载占位 / 错误面 /
// tap 打开会话并收起抽屉；以及 store openSession 列表补齐
// （_upsertOpenedListing）配套用例。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/widgets/project_drawer.dart';
import 'package:wzxclaw_android/widgets/session_list_tile.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import '../zcode/zcode_test_fakes.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(body: ListView(children: [child])),
  );
}

/// 抽屉冒烟用例壳：Scaffold + drawer，通过按钮打开
Widget wrapWithDrawer(Widget drawer) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: Scaffold(
      drawer: drawer,
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () => Scaffold.of(context).openDrawer(),
            child: const Text('open-drawer'),
          ),
        ),
      ),
    ),
  );
}

ZcodeSessionMeta makeMeta({
  String id = 'sess-1',
  String title = 'Test Session',
  int? updatedAt,
  String? workspacePath = '/home/user/project',
  String? status,
}) {
  return ZcodeSessionMeta(
    sessionId: id,
    title: title,
    updatedAt: updatedAt ?? DateTime.now().millisecondsSinceEpoch,
    workspaceKey: workspacePath == null ? null : 'ws-key-1',
    workspacePath: workspacePath,
    status: status,
  );
}

/// 运行脉冲圆点（_RunningDot 私有，按 7x7 圆形容器谓词匹配）
Finder runningDot() => find.byWidgetPredicate(
      (w) =>
          w is Container &&
          w.constraints == const BoxConstraints.tightFor(width: 7, height: 7) &&
          w.decoration is BoxDecoration &&
          (w.decoration! as BoxDecoration).shape == BoxShape.circle,
    );

/// 注册 openSession 全链路处理器（resume/read/messages/subscribe）
void stubOpenSession(FakeZcodeRelayClient fake) {
  stubResumeEmpty(fake);
  fake.handlers['session/read'] = (_) => {
        'projection': {'status': 'idle'},
      };
  fake.handlers['session/messages'] = (_) => {'messages': []};
  fake.handlers['session/subscribe'] = (_) => {'events': []};
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SessionListTile', () {
    testWidgets('renders session title', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(title: 'My Session'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.text('My Session'), findsOneWidget);
    });

    testWidgets('renders relative time text', (tester) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(updatedAt: now - 300000), // 5 minutes ago
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.textContaining('分钟前'), findsOneWidget);
    });

    testWidgets('omits time row when updatedAt is 0', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(updatedAt: 0),
          isActive: false,
          onTap: () {},
        ),
      ),);

      // 不渲染空时间占位（'刚刚'）——工作区名已移至抽屉分组头，
      // 瓦片第二行整体省略
      expect(find.text('刚刚'), findsNothing);
      expect(find.text('project'), findsNothing);
    });

    testWidgets('shows running dot when status is running', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(status: 'running'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(runningDot(), findsOneWidget);
    });

    testWidgets('no running dot when status is not running', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(status: 'idle'),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(runningDot(), findsNothing);
    });

    testWidgets('no message count or cache badge (zcode 协议无对应能力)',
        (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.textContaining('条消息'), findsNothing);
      expect(find.textContaining('缓存'), findsNothing);
    });

    testWidgets('shows active indicator when isActive is true', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(),
          isActive: true,
          onTap: () {},
        ),
      ),);

      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('does not show active indicator when isActive is false',
        (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(),
          isActive: false,
          onTap: () {},
        ),
      ),);

      expect(find.byIcon(Icons.check_circle), findsNothing);
    });

    testWidgets('calls onTap when tapped', (tester) async {
      var tapped = false;
      await tester.pumpWidget(wrapWithTheme(
        SessionListTile(
          session: makeMeta(),
          isActive: false,
          onTap: () => tapped = true,
        ),
      ),);

      await tester.tap(find.byType(SessionListTile));
      expect(tapped, isTrue);
    });
  });

  group('ProjectDrawer（zcode 换芯冒烟）', () {
    FakeZcodeRelayClient makeFakeWithSessions() {
      final now = DateTime.now().millisecondsSinceEpoch;
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {
            'sessions': [
              {
                'sessionId': 'sess-1',
                'title': '抽屉冒烟会话',
                'updatedAt': now,
                'workspace': {
                  'workspaceKey': 'ws-key-1',
                  'workspacePath': '/home/user/proj-x',
                },
                'status': 'idle',
              },
              {
                'sessionId': 'sess-2',
                'title': '另一工作区会话',
                'updatedAt': now - 1000,
                'workspace': {
                  'workspaceKey': 'ws-key-2',
                  'workspacePath': 'C:\\repo\\other',
                },
                'status': 'idle',
              },
            ],
          };
      stubOpenSession(fake);
      return fake;
    }

    testWidgets('预置会话标题可见 + 分组头显示工作区末级 + 文件入口置灰', (tester) async {
      final store = pairedStore(makeFakeWithSessions());
      await store.refreshSessions();

      await tester.pumpWidget(wrapWithDrawer(ProjectDrawer(store: store)));
      await tester.tap(find.text('open-drawer'));
      await tester.pumpAndSettle();

      expect(find.text('桌面 ZCode'), findsOneWidget);
      expect(find.text('未选择会话'), findsOneWidget);
      expect(find.text('抽屉冒烟会话'), findsOneWidget);
      // 分组头 = workspacePath 末级目录名（含结尾分隔符剥离）
      expect(find.text('proj-x'), findsOneWidget);
      expect(find.text('other'), findsOneWidget);
      expect(find.text('等待 v3 workspace 支持'), findsOneWidget);
    });

    testWidgets('分组头可折叠：点组头隐藏该组瓦片，其他组不受影响', (tester) async {
      final store = pairedStore(makeFakeWithSessions());
      await store.refreshSessions();

      await tester.pumpWidget(wrapWithDrawer(ProjectDrawer(store: store)));
      await tester.tap(find.text('open-drawer'));
      await tester.pumpAndSettle();

      expect(find.text('抽屉冒烟会话'), findsOneWidget);
      expect(find.text('另一工作区会话'), findsOneWidget);

      await tester.tap(find.text('proj-x'));
      await tester.pumpAndSettle();

      expect(find.text('抽屉冒烟会话'), findsNothing);
      expect(find.text('另一工作区会话'), findsOneWidget);
    });

    testWidgets('tap 会话 → openSession 并收起抽屉', (tester) async {
      final store = pairedStore(makeFakeWithSessions());
      await store.refreshSessions();

      await tester.pumpWidget(wrapWithDrawer(ProjectDrawer(store: store)));
      await tester.tap(find.text('open-drawer'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('抽屉冒烟会话'));
      await tester.pumpAndSettle();

      expect(store.activeSessionId, 'sess-1');
      // 抽屉已收起
      expect(find.text('桌面 ZCode'), findsNothing);
    });

    testWidgets('首次加载中显示加载占位，不闪「暂无会话记录」', (tester) async {
      final fake = FakeZcodeRelayClient();
      final gate = Completer<dynamic>();
      fake.handlers['session/list'] = (_) => gate.future;
      final store = pairedStore(fake);

      // refreshSessions 挂起在 pending 请求上（sessionsLoading = true）
      final refreshing = store.refreshSessions();
      await tester.pumpWidget(wrapWithDrawer(ProjectDrawer(store: store)));
      await tester.tap(find.text('open-drawer'));
      // 刷新按钮有循环动画，用固定时长 pump 替代 pumpAndSettle
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.text('会话加载中…'), findsOneWidget);
      expect(find.text('暂无会话记录'), findsNothing);

      gate.complete({'sessions': []});
      await refreshing;
      await tester.pumpAndSettle();

      expect(find.text('暂无会话记录'), findsOneWidget);
    });

    testWidgets('store.error 非空时会话区块渲染错误提示', (tester) async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {'sessions': []};
      final store = pairedStore(fake);

      // 未注册 session/resume 处理器 → openSession 失败并设置 error
      await store.openSession('sess-x');

      await tester.pumpWidget(wrapWithDrawer(ProjectDrawer(store: store)));
      await tester.tap(find.text('open-drawer'));
      await tester.pumpAndSettle();

      expect(find.textContaining('打开会话失败'), findsOneWidget);
    });
  });

  group('ZcodeChatStore.openSession 会话列表补齐（换芯配套）', () {
    void stubResumeWithMeta(
      FakeZcodeRelayClient fake, {
      required String sessionId,
      String? title,
      String? wsKey,
      String? wsPath,
    }) {
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'idle'},
            'messages': [],
            'session': {
              'sessionId': sessionId,
              if (title != null) 'title': title,
              if (wsKey != null || wsPath != null)
                'workspace': {
                  if (wsKey != null) 'workspaceKey': wsKey,
                  if (wsPath != null) 'workspacePath': wsPath,
                },
            },
          };
      fake.handlers['session/read'] = (_) => {
            'projection': {'status': 'idle'},
          };
      fake.handlers['session/messages'] = (_) => {'messages': []};
      fake.handlers['session/subscribe'] = (_) => {'events': []};
    }

    test('列表缺失该会话时用 resume 快照补条目（新会话置顶）', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {'sessions': []};
      stubResumeWithMeta(
        fake,
        sessionId: 'sess-9',
        title: '补齐会话',
        wsKey: 'k9',
        wsPath: '/w/solo',
      );
      final store = pairedStore(fake);

      await store.openSession('sess-9');

      expect(store.activeSessionId, 'sess-9');
      final meta = store.sessions.firstWhere((s) => s.sessionId == 'sess-9');
      expect(meta.title, '补齐会话');
      expect(meta.workspacePath, '/w/solo');
    });

    test('列表已有该会话时不覆盖权威快照、不重复插入', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {
            'sessions': [
              {
                'sessionId': 'sess-1',
                'title': '权威标题',
                'updatedAt': 12345,
                'workspace': {
                  'workspaceKey': 'k1',
                  'workspacePath': '/w/one',
                },
                'status': 'idle',
              },
            ],
          };
      stubResumeWithMeta(
        fake,
        sessionId: 'sess-1',
        title: 'resume 标题',
        wsKey: 'k1',
        wsPath: '/w/one',
      );
      final store = pairedStore(fake);
      await store.refreshSessions();

      await store.openSession('sess-1');

      expect(store.sessions.length, 1);
      final meta = store.sessions.firstWhere((s) => s.sessionId == 'sess-1');
      expect(meta.title, '权威标题');
      expect(meta.updatedAt, 12345);
    });
  });
}
