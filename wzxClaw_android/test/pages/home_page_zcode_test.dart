// ============================================================
// home_page_zcode_test — ChatPage 换芯 ZcodeChatStore 页面级测试
//
// 构造注入 ChatPage(store: …)，夹具来自 test/zcode/zcode_test_fakes.dart
// （FakeZcodeRelayClient / FakeSessionServer / fakeMsg / pairingUrl）。
// 覆盖：预置消息渲染（含 toolCalls 合成卡片）、输入发送走 store、
// 权限请求应答、错误横幅显示与关闭、sessionOpening 骨架屏。
// ============================================================

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:wzxclaw_android/config/app_colors.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/widgets/tool_call_list.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';

// 测试夹具在 test/ 目录下，用相对路径引入
import '../zcode/zcode_test_fakes.dart';

/// 页面包壳：MaterialApp + AppColors.dark 主题（与其他 widget 测试一致）
Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: ThemeData.dark().copyWith(extensions: [AppColors.dark]),
    home: child,
  );
}

/// (store, fake 客户端, 假服务端) 三元组
typedef _Env = (ZcodeChatStore, FakeZcodeRelayClient, FakeSessionServer);

/// 构造已配对的测试环境：注入假客户端 + 假缓存 + 绑定假 app-server 会话
_Env _makeEnv() {
  final fake = FakeZcodeRelayClient();
  final server = FakeSessionServer()..bind(fake);
  // 注入内存缓存：避免懒加载真实 ZcodeSessionCache 在测试环境抛
  // MissingPluginException，导致翻页/缓存层走异常路径（行为失真）
  final store = ZcodeChatStore(client: fake, cache: FakeZcodeSessionCache());
  expect(store.pair(pairingUrl), isTrue);
  // 推送看门狗零延迟：测试内即时到期（turn.completed 收尾后即停轮询），
  // 不依赖真实 3.6s 窗口的快进 pump
  store.pushWatchdogDelay = Duration.zero;
  return (store, fake, server);
}

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('预置会话消息渲染：user/assistant 气泡 + toolCalls 合成卡片', (
    tester,
  ) async {
    final (store, _, server) = _makeEnv();
    final s = server.session('sess-1');
    s.messages.addAll([
      fakeMsg(
        'user',
        [
          {'type': 'text', 'text': '帮我看看这个报错'},
        ],
        id: 'srv-u-1',
        created: 100,
      ),
      fakeMsg(
        'assistant',
        [
          {'type': 'text', 'text': '这是分析结果'},
          {
            'type': 'tool',
            'callID': 'call_9',
            'tool': 'Bash',
            'state': {
              'status': 'completed',
              'input': {'command': 'ls'},
              'output': 'main.dart',
            },
          },
        ],
        id: 'srv-a-1',
        created: 200,
      ),
    ]);
    await store.openSession('sess-1');

    await tester.pumpWidget(wrapWithTheme(ChatPage(store: store)));
    await tester.pump();

    expect(find.text('帮我看看这个报错'), findsOneWidget);
    expect(find.text('这是分析结果'), findsOneWidget);
    // assistant.toolCalls 合成为 tool 消息 → ToolCallGroup 渲染
    expect(find.byType(ToolCallGroup), findsOneWidget);
  });

  testWidgets('输入并发送 → 走 store 的 session/send', (tester) async {
    final (store, fake, _) = _makeEnv();
    await store.openSession('sess-1');

    await tester.pumpWidget(wrapWithTheme(ChatPage(store: store)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), 'hello zcode');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));

    // send 已同步入列（fake 客户端请求日志在 request 调用即记录）
    expect(
      fake.requests.any(
        (r) => r.key == 'session/send' && r.value?['content'] == 'hello zcode',
      ),
      isTrue,
    );

    // 推送 turn.completed 收尾（纯文本回合），再小步推进时钟：
    // 零延迟推送看门狗到期时 isStreaming 已为 false → 直接早退，
    // 不会拉起降级轮询（注意 pump() 不带时长不推进 fake 时钟，
    // 零时长定时器不会到期，必须给一个正的极短时长）
    pushEvent(
      store,
      sessionId: 'sess-1',
      type: 'turn.completed',
      seq: 1,
      payload: {'resultType': 'success', 'toolCallCount': 0},
    );
    await tester.pump(const Duration(milliseconds: 50));

    // 本地乐观追加的 user 气泡
    expect(find.text('hello zcode'), findsOneWidget);
  });

  testWidgets('权限请求出现 → 点同意 → respondToPermission 回传批准', (tester) async {
    final (store, _, _) = _makeEnv();
    await store.openSession('sess-1');

    await tester.pumpWidget(wrapWithTheme(ChatPage(store: store)));
    await tester.pump();

    // 注入反向请求（等价客户端 onRequest 钩子）
    final responseFuture = store.debugHandleReverseRequest(
      const ZcodeFrame(
        method: 'interaction/requestPermission',
        params: {
          'toolCallId': 'call_1',
          'toolName': 'Bash',
          'input': {'command': 'ls -la'},
          'reason': 'High risk tools require explicit approval',
          'options': [
            {
              'kind': 'allow_once',
              'optionId': 'allow_once',
              'name': 'Allow once',
              'response': {'decision': 'allow', 'reason': 'Approved once'},
            },
            {
              'kind': 'deny',
              'optionId': 'deny',
              'name': 'Deny',
              'response': {'decision': 'deny', 'reason': 'Denied'},
            },
          ],
        },
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Permission Request'), findsOneWidget);

    await tester.tap(find.text('Approve'));
    await tester.pump();

    // 页面应把批准经 store.respondToPermission 回传给挂起的反向请求
    final result = await responseFuture as Map;
    expect(result['decision'], 'allow');
    // 应答后权限条收起
    expect(find.text('Permission Request'), findsNothing);

    // 主动卸载：取消权限卡的秒级计时器
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('错误横幅显示 store.error，点关闭后清空', (tester) async {
    final (store, _, _) = _makeEnv();
    // 触发一次失败：未知模式 → store.error
    expect(await store.setMode('bogus'), isFalse);

    await tester.pumpWidget(wrapWithTheme(ChatPage(store: store)));
    await tester.pump();

    expect(find.textContaining('未知权限模式'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();

    expect(store.error, isNull);
    expect(find.textContaining('未知权限模式'), findsNothing);
  });

  testWidgets('sessionOpening 时显示骨架屏', (tester) async {
    final (store, fake, _) = _makeEnv();
    // resume 永不完成：会话停留在"未 materialize + 无内容"的打开中状态
    fake.handlers['session/resume'] =
        (_) => Completer<Map<dynamic, dynamic>>().future;
    unawaited(store.openSession('sess-hang'));
    await tester.pump();

    await tester.pumpWidget(wrapWithTheme(ChatPage(store: store)));
    await tester.pump();

    expect(find.byKey(const ValueKey('chat_session_skeleton')), findsOneWidget);
    expect(find.text('暂无消息'), findsNothing);
  });
}
