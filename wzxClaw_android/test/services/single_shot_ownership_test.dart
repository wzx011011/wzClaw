// ============================================================
// single_shot_ownership_test — 单发请求归属守卫（连接代次）
//
// 复现并钉死：ConnectionManager.zcodeRequest 裸通道只在调起瞬间校验
// 连接状态，await 返回后不校验——切节点后旧节点的迟到响应会串号写进
// 新节点的 UI。单发消费点（node_catalog / chat_runtime / node_fs 三个
// service 的 _call，以及子代理页 _load/轮询）必须按「发起前快照代次、
// await 后比对、漂移即丢弃」守卫（同 GitService.refreshBranch 范式）。
//
// 复现走真路径：清空 debugRequester，把 FakeZcodeRelayClient 挂到
// ConnectionManager 单例（debugAttachClient 每次都递增代次）；fake 的
// close() 不失败在途请求，配合 Completer handler 正好制造「切节点后
// 旧响应才迟到」。Flutter 每测试文件独立 isolate，单例无跨文件污染。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/pages/subagent_session_page.dart';
import 'package:wzxclaw_android/services/chat_runtime_service.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/services/node_catalog_service.dart';
import 'package:wzxclaw_android/services/node_fs_service.dart';

import '../zcode/zcode_test_fakes.dart';

/// 断言：调用以「节点已切换」守卫失败（而非解析错误/成功结果）
Matcher get throwsOwnershipGuard => throwsA(
      isA<StateError>().having(
        (e) => e.message,
        'message',
        contains('节点已切换'),
      ),
    );

void main() {
  // 真路径 = ConnectionManager 单例。tearDown 的 disconnect 会触发
  // _refreshDesktopList → PairingStore.loadAll → SharedPreferences，
  // 提前给 mock 值避免 unhandled async error。
  TestWidgetsFlutterBinding.ensureInitialized();

  final cm = ConnectionManager.instance;

  setUpAll(() {
    SharedPreferences.setMockInitialValues({});
  });

  setUp(() {
    // 清空全部注入 = 走真路径（现有 service 单测走注入、注入跳过守卫，
    // 复现不了本缺陷）
    NodeCatalogService.debugRequester = null;
    ChatRuntimeService.debugRequester = null;
    NodeFsService.debugRequester = null;
    SubagentSessionPage.debugRequester = null;
  });

  tearDown(() {
    cm.disconnect(); // 复位：断开 = 代次前进，下个用例重新挂替身
    NodeCatalogService.debugRequester = null;
    ChatRuntimeService.debugRequester = null;
    NodeFsService.debugRequester = null;
    SubagentSessionPage.debugRequester = null;
  });

  group('service 单发请求归属', () {
    test('NodeCatalogService：切节点后旧目录响应丢弃', () async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient); // 旧节点代次

      // 挂起旧节点的目录请求，制造「响应迟到」
      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['x/model/catalog'] = (_) => pending.future;

      final future = NodeCatalogService.instance.modelCatalog(); // 不 await
      expect(
        oldClient.requests.map((r) => r.key),
        contains('x/model/catalog'),
        reason: '请求必须已发往旧节点，场景才算成立',
      );

      // 切节点 = 新连接新代次（真实路径里旧 client 被 close，但 fake 的
      // close 不失败在途请求，旧响应仍会迟到）
      cm.debugAttachClient(FakeZcodeRelayClient());

      // 旧响应此时才到：必须整体丢弃，不得解析成功串进新节点
      pending.complete({'models': [], 'default': null, 'degraded': false});
      await expectLater(future, throwsOwnershipGuard);
    });

    test('ChatRuntimeService：切节点后旧用量响应丢弃', () async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient);

      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['session/usage'] = (_) => pending.future;

      final future = ChatRuntimeService.instance.usage('sess-1'); // 不 await
      expect(
        oldClient.requests.map((r) => r.key),
        contains('session/usage'),
      );

      cm.debugAttachClient(FakeZcodeRelayClient());

      // 合法用量响应：守卫生效时不得被解析成新节点的用量
      pending.complete(const {
        'totalTokens': 11,
        'inputTokens': 1,
        'outputTokens': 9,
        'reasoningTokens': 1,
        'cacheReadTokens': 0,
        'modelRequestCount': 2,
      });
      await expectLater(future, throwsOwnershipGuard);
    });

    test('NodeFsService：切节点后旧目录列举响应丢弃', () async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient);

      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['x/fs/dirs'] = (_) => pending.future;

      final future = NodeFsService.instance.listDirs(); // 不 await
      expect(oldClient.requests.map((r) => r.key), contains('x/fs/dirs'));

      cm.debugAttachClient(FakeZcodeRelayClient());

      // 合法目录响应：守卫生效时不得把旧机器的文件系统串进新节点的
      // 目录树
      pending.complete(const {
        'path': '/home/old-node',
        'parent': '/home',
        'home': '/home/old-node',
        'dirs': [
          {'name': 'projects', 'path': '/home/old-node/projects'},
        ],
      });
      await expectLater(future, throwsOwnershipGuard);
    });
  });

  group('子代理页归属', () {
    SubagentSessionPage page() => const SubagentSessionPage(
          parentSessionId: 'sess-parent',
          toolCallId: 'tc-1',
          agentType: 'Explore',
          fallbackTitle: '子任务',
        );

    Future<void> pumpPage(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(extensions: const [AppColors.dark]),
          home: page(),
        ),
      );
    }

    testWidgets('首拍在途：切节点后旧节点详情迟到，不写入页面', (tester) async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient);
      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['session/subagents'] = (_) => pending.future;

      await pumpPage(tester);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      // 切节点后旧详情才迟到（running 相）：不得渲染进页面
      cm.debugAttachClient(FakeZcodeRelayClient());
      pending.complete({
        'running': [
          {
            'toolCallId': 'tc-1',
            'title': '旧节点标题',
            'summary': '旧节点回报',
            'status': 'success',
            'startedAt': 1700000000000,
          },
        ],
      });
      await tester.pump();
      await tester.pump();

      expect(find.text('旧节点标题'), findsNothing);
      expect(find.text('旧节点回报'), findsNothing);
      // 结果整体作废 = 页面停在守卫前的状态（加载中），不部分消费
      expect(
        find.byType(CircularProgressIndicator),
        findsOneWidget,
        reason: '漂移结果被丢弃后，页面不得拿着旧节点数据结束加载态',
      );
    });

    testWidgets('首拍在途：切节点后旧节点的错误迟到，不写入 _error', (tester) async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient);
      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['session/subagents'] = (_) => pending.future;

      await pumpPage(tester);

      // 切节点后旧请求才失败：错误文案不得写进新节点下的页面
      cm.debugAttachClient(FakeZcodeRelayClient());
      pending.completeError(StateError('旧节点通道故障'));
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('加载失败'), findsNothing);
      expect(find.textContaining('未在 session/subagents'), findsNothing);
    });

    testWidgets('轮询在途：切节点后旧节点响应迟到，不写入且停表', (tester) async {
      final oldClient = FakeZcodeRelayClient();
      cm.debugAttachClient(oldClient);
      // 首拍直返 running 相 → 页面上屏 v1 并启动 3 秒轮询
      oldClient.handlers['session/subagents'] = (_) => {
            'running': [
              {
                'toolCallId': 'tc-1',
                'title': 'v1',
                'summary': '切节点前的合法快照',
                'status': 'running',
              },
            ],
          };

      await pumpPage(tester);
      await tester.pump();
      expect(find.text('v1'), findsOneWidget);

      // 下一拍轮询挂起在旧节点上
      final pending = Completer<Map<String, dynamic>>();
      oldClient.handlers['session/subagents'] = (_) => pending.future;
      await tester.pump(const Duration(seconds: 3));

      // 轮询在途期间切节点；旧节点的 v2 此时才迟到
      cm.debugAttachClient(FakeZcodeRelayClient());
      pending.complete({
        'ended': {
          'items': [
            {
              'toolCallId': 'tc-1',
              'title': 'v2',
              'summary': '旧节点迟到内容',
              'status': 'success',
            },
          ],
        },
      });
      await tester.pump();
      await tester.pump();

      expect(find.text('v2'), findsNothing, reason: '旧节点迟到详情不得覆盖页面');
      // 守卫同时停表：再过若干个轮询周期，页面仍停在切节点前的 v1，
      // 也不出现旧节点的错误文案
      await tester.pump(const Duration(seconds: 7));
      await tester.pump();
      expect(find.text('v1'), findsOneWidget);
      expect(find.textContaining('加载失败'), findsNothing);
      expect(find.textContaining('未在 session/subagents'), findsNothing);
    });
  });
}
