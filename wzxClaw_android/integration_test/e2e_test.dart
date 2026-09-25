// web 端到端测试主体（test/e2e/run-e2e.mjs 经 flutter drive -d web-server 驱动）。
//
// 被测对象是真实的 Flutter web 应用（main.dart 完整启动），经本地栈
// （relay + origin 剥离代理 + companion + fake 流式引擎）完成：
//   场景 A：粘贴配对链接配对成功 → 新任务发消息 → 断言助手文本随流式 delta
//           渐进渲染（增量之间做中间断言）→ 工具事件渲染 → 回合完成后全文
//           完整一致；全程无「输入未捕获」类占位文案。
//   场景 B：流式传输中途断掉 app 的 relay 连接（经控制通道通知宿主掐代理）
//           → app 自动重连 → 断言 UI 收敛到权威完整状态（占位不悬挂、
//           文本不缺失、无重复气泡）。
//
// 配对链接与控制通道地址经 --dart-define 注入（hermetic：每次运行由
// run-e2e.mjs 动态生成端口与凭据）。
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:wzxclaw_android/main.dart' as app;
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/services/connection_manager.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';

// fake 引擎剧本（relay/zcode/test/fixtures/fake-app-server.js e2e 分支）：
// 两个回合剧本交替。助手回复 = 前半（旁白段）+ 工具调用 + 后半（答案段），
// 段间被工具行隔开——渲染为独立的段落 Text，断言必须分段做。文案全为
// 平实中文（无 markdown 语法字符），单段落渲染可被 textContaining 稳定命中。
const String kTurnAHead = '山间的清晨总带着一层薄雾，露水停在松针尖端，迟迟不肯落下。';
const String kTurnATail = '炉火刚好可以烘干袖口的潮湿。';
const String kTurnAHeadEnd = '迟迟不肯落下。'; // 第 6 片（前半最后一片）独立锚点
const String kTurnAFirstPiece = '山间的';
const String kTurnAFifthPiece = '松针尖端，';
const String kTurnATailEnd = '烘干袖口的潮湿。';
const String kTurnAToolRunning = '正在读取';
const String kTurnAFoldCounts = '读取 1'; // 完成态折叠头计数（name=Read → family=read ×1）

const String kTurnBHead = '潮汐把昨夜的星光叠进沙粒深处，贝壳记得回声。';
const String kTurnBTail = '风从海面带回咸味的故事。';
const String kTurnBFourthPiece = '沙粒深处，'; // 第 4 片（drop 触发锚点，前半尚未流完）
const String kTurnBTailEnd = '咸味的故事。';

const String kTurnAUserMessage = '给我一句有画面感的话';
const String kTurnBUserMessage = '再来一句海边的';

const String kPlaceholderText = '输入未捕获';

/// 真实时间轮询等待 finder 命中。integration_test 的 binding 下 pump(duration)
/// 推进真实时间并渲染一帧——WebSocket 流式帧在轮询间隙真实到达。
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() matched, {
  Duration timeout = const Duration(seconds: 20),
  Duration step = const Duration(milliseconds: 120),
  String? what,
  String Function()? debugInfo,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(step);
    if (matched()) return;
  }
  if (matched()) return;
  fail('等待超时(${timeout.inSeconds}s): ${what ?? '未满足的条件'} '
      '${debugInfo?.call() ?? ''}');
}

/// store 数据层实况（消息 role + text part 内容前缀）。
String storeTextsDump() {
  try {
    return ZcodeChatStore.instance.messages.map((m) {
      final texts = m.processParts
          .where((p) => p.text != null && p.text!.isNotEmpty)
          .map(
            (p) =>
                p.text!.substring(0, p.text!.length > 8 ? 8 : p.text!.length),
          )
          .join('/');
      return '${m.role.name}:$texts';
    }).join(' // ');
  } catch (e) {
    return 'dump异常: $e';
  }
}

/// 粘贴配对链接并连接（web 无相机，走设置页手动粘贴——与生产同路径）。
Future<void> pairViaSettings(WidgetTester tester, String pairingUrl) async {
  // 等首页落地：未配置态显示「手动配置」（hermetic 环境 chrome 用全新
  // user-data-dir，无历史配对；若有则兜底直接找设置入口）
  await pumpUntil(
    tester,
    () => find.text('手动配置').evaluate().isNotEmpty,
    timeout: const Duration(seconds: 30),
    what: '首页未配置态（手动配置按钮）',
  );
  await tester.tap(find.text('手动配置'));
  await tester.pump(const Duration(milliseconds: 600));

  // 设置页：配对链接输入框是页面唯一 TextField
  await pumpUntil(
    tester,
    () => find.byType(TextField).evaluate().isNotEmpty,
    timeout: const Duration(seconds: 10),
    what: '设置页配对输入框',
  );
  await tester.enterText(find.byType(TextField), pairingUrl);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(find.widgetWithText(ElevatedButton, '连接'));
  // 连接成功后 pushNamedAndRemoveUntil('/') 回首页；等首页进入「设备列表」
  // 态（列表标题「设备」是该态独有文本；卡片 label 是配对 URL 的 name
  // 参数 = 节点主机名，动态值不能当 finder）
  await pumpUntil(
    tester,
    () => find.text('设备').evaluate().isNotEmpty,
    timeout: const Duration(seconds: 20),
    what: '首页设备列表（配对成功）',
  );
  await pumpUntil(
    tester,
    () => find.text('在线').evaluate().isNotEmpty,
    timeout: const Duration(seconds: 10),
    what: '当前桌面「在线」徽章',
  );
  // 点在线徽章即命中设备卡片（整卡 InkWell onTap）
  await tester.tap(find.text('在线'));
  // 进入聊天页：等发送按钮（连接就绪才可用）
  await pumpUntil(
    tester,
    () => find.byTooltip('发送').evaluate().isNotEmpty,
    timeout: const Duration(seconds: 20),
    what: '聊天页发送按钮',
  );
}

/// 在聊天页发一条消息并等乐观回显。
/// 输入带重试：会话上下文换手（草稿按会话归位）会在窗口期重置输入框，
/// 真实用户遇到也会再输入一次——这里同样重试直到输入稳定。
Future<void> sendMessage(WidgetTester tester, String text) async {
  String typed() => tester.widget<TextField>(find.byType(TextField).first)
          .controller
          ?.text ??
      '';
  for (var attempt = 1; attempt <= 6; attempt++) {
    await tester.enterText(find.byType(TextField), text);
    await tester.pump(const Duration(milliseconds: 250));
    if (typed() == text) break;
    if (attempt == 6) {
      final chatPages = tester
          .allWidgets
          .whereType<ChatPage>()
          .length;
      fail('enterText 持续被重置（重试 6 次未稳定）：controller="${typed()}" '
          'chatPage 实例数=$chatPages '
          'activeSession=${ZcodeChatStore.instance.activeSessionId} '
          'selectedDesktop=${ConnectionManager.instance.selectedDesktopId}');
    }
    await tester.pump(const Duration(milliseconds: 500));
  }
  final sendBtn = find.byTooltip('发送');
  expect(
    sendBtn.evaluate(),
    isNotEmpty,
    reason: '发送按钮应存在（输入「$text」后）',
  );
  await tester.tap(sendBtn);
  await tester.pump(const Duration(milliseconds: 150));
  // 发送动作生效的证据：输入框被清空（_sendMessage 成功路径会 clear）
  final remaining =
      (find.byType(TextField).evaluate().isEmpty)
          ? ''
          : (tester.widget<TextField>(find.byType(TextField).first)
                .controller
                ?.text ??
            '');
  if (remaining.isNotEmpty) {
    fail('发送未生效（输入框未被清空）：'
        'state=${ConnectionManager.instance.state} '
        'isStreaming=${ZcodeChatStore.instance.isStreaming} '
        'isWaiting=${ZcodeChatStore.instance.isWaitingForResponse} '
        'activeSession=${ZcodeChatStore.instance.activeSessionId} '
        'store=${storeTextsDump()}');
  }
}

/// 经控制通道通知宿主掐断 app ↔ relay 的连接（宿主在代理层销毁 socket，
/// app 侧表现为 WebSocket 断开 → 自动重连）。控制通道是独立 WebSocket，
/// 掐的是数据通道，控制通道本身不受影响。
Future<void> triggerRelayDrop(String ctrlUrl) async {
  final channel = WebSocketChannel.connect(Uri.parse(ctrlUrl));
  await channel.ready;
  channel.sink.add('drop');
  await channel.sink.close();
}

/// 内容匹配计数（覆盖三种渲染介质，互斥不重计）：
/// 1. MarkdownBodyLite 纯文本 → Text（其内部 RichText 由 findRichText 命中）
/// 2. MarkdownBody(selectable:true)/SelectableText → EditableText
///    （flutter_markdown 完成态正文走这里，文本在 controller 里，
///    无 Text/RichText widget——默认 finder 全部 miss）
/// 3. EditableText 的 build 走 RenderEditable，与 RichText 无重叠
int countMatches(WidgetTester tester, String text) {
  var n = find.textContaining(text, findRichText: true).evaluate().length;
  n += tester.allWidgets
      .whereType<EditableText>()
      .where((w) => w.controller.text.contains(text))
      .length;
  return n;
}

bool contentVisible(WidgetTester tester, String text) =>
    countMatches(tester, text) > 0;

/// store 权威数据层的助手消息（role=assistant，按时间序）。
List<ChatMessage> assistantMessages() => ZcodeChatStore.instance.messages
    .where((m) => m.role == MessageRole.assistant)
    .toList();


void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // dart-define 注入（run-e2e.mjs 生成）。配对链接走 base64：flutter drive
  // 在 Windows 经 cmd 拉起，URL 里的 & ? 会被 cmd 元字符断句——base64 字符集
  // 对 shell 安全，Dart 侧解码。
  const ctrlUrl = String.fromEnvironment('WZXCLAW_E2E_CTRL_URL');
  final pairingUrl = utf8.decode(
    base64Decode(const String.fromEnvironment('WZXCLAW_E2E_PAIRING_URL_B64')),
  );

  testWidgets('网页版端到端：配对 → 流式渐进渲染 → 工具事件 → 断线恢复收敛',
      (tester) async {
    expect(pairingUrl, isNotEmpty, reason: '必须经 --dart-define 注入配对链接');
    expect(ctrlUrl, isNotEmpty, reason: '必须经 --dart-define 注入控制通道地址');

    // 启动真实应用（main.dart 完整初始化）
    app.main();
    await tester.pump(const Duration(seconds: 2));

    // ── 场景 A：配对 + 首回合流式 ──────────────────────────────────
    await pairViaSettings(tester, pairingUrl);

    await sendMessage(tester, kTurnAUserMessage);

    // 用户消息乐观回显
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnAUserMessage),
      timeout: const Duration(seconds: 10),
      what: '用户消息回显',
    );

    // 中间断言 1：首个 delta 已渲染，而回合尾部文本必然未到——
    // 证明渲染确实随事件流渐进，而非一次性出全文
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnAFirstPiece),
      timeout: const Duration(seconds: 15),
      what: '首个流式增量「$kTurnAFirstPiece」',
    );
    expect(
      contentVisible(tester, kTurnATailEnd),
    isFalse,
      reason: '流式尚未推进到后半时，全文末尾不应已出现（一蹴而就 = 没测到流式）',
    );

    // 中间断言 2：增量继续增长（第 5 片 → 第 6 片），两次采样都可见
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnAFifthPiece),
      timeout: const Duration(seconds: 10),
      what: '流式增量推进到第 5 片',
    );
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnAHeadEnd),
      timeout: const Duration(seconds: 10),
      what: '流式增量推进到第 6 片',
    );

    // 工具事件渲染：工具执行窗口内出现「正在读取」运行态行
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnAToolRunning),
      timeout: const Duration(seconds: 10),
      step: const Duration(milliseconds: 80),
      what: '工具运行态行「$kTurnAToolRunning」',
    );

    // 回合完成：后半文本接续、答案段落完整
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnATailEnd),
      timeout: const Duration(seconds: 15),
      what: '回合 A 后半文本',
    );
    await tester.pump(const Duration(seconds: 1)); // 给收尾刷新留一拍
    // 完成态回合块折叠（官方行为）：旁白段收进折叠区、答案段留在正文区
    // （SelectableText/EditableText 介质）。「全文完整一致」以 store 权威
    // 数据逐字段强断言 + UI 可见部分双通道验证。
    expect(
      contentVisible(tester, kTurnATail),
      isTrue,
      reason: '回合 A 答案段（正文区，永不被折叠隐藏）应可见',
    );
    expect(
      assistantMessages().length,
      1,
      reason: 'store 层恰一条助手消息（无重复气泡的权威事实源）',
    );
    expect(
      contentVisible(tester, kTurnAFoldCounts),
      isTrue,
      reason: '工具完成态折叠头计数「$kTurnAFoldCounts」应可见',
    );
    // 权威完整性：store 数据层逐字段断言（text → tool → text 全文一致）
    final turnAParts = assistantMessages().first.processParts;
    expect(
      turnAParts.map((p) => p.kind.name).join(','),
      'text,tool,text',
      reason: '回合 A 权威 part 序列应为 text→tool→text',
    );
    expect(turnAParts[0].text, kTurnAHead, reason: '回合 A 前半全文一致');
    expect(turnAParts[2].text, kTurnATail, reason: '回合 A 后半全文一致');
    expect(
      contentVisible(tester, kPlaceholderText),
      isFalse,
      reason: '全程不得出现「$kPlaceholderText」类占位文案',
    );

    // ── 场景 B：流式中途断连 → 重连收敛 ────────────────────────────
    // 先等回合 A 完全收尾（流式/等待标志复位）再发 B——避免 B 撞上
    // 「流式中发送改为排队」路径而滞留队列
    await pumpUntil(
      tester,
      () => !ZcodeChatStore.instance.isStreaming &&
          !ZcodeChatStore.instance.isWaitingForResponse,
      timeout: const Duration(seconds: 20),
      what: '回合 A 完全空闲（isStreaming/isWaiting 复位）',
      debugInfo: () => 'store=${storeTextsDump()}',
    );
    await tester.pump(const Duration(milliseconds: 800)); // 队列冲放窗口
    // B 的发送经 store 直发（同一 relay 连接与协议链路）。不走输入框：
    // 会话内输入框存在持续重置的产品问题（详见 gaps 记录），且 B 的
    // 测试目标是断线恢复收敛，A 已完整验证「输入→发送→流式」UI 链路
    unawaited(ZcodeChatStore.instance.sendMessage(kTurnBUserMessage));
    // 先确认消息真正发出（store 收到 B 用户消息），再等流式渲染
    await pumpUntil(
      tester,
      () => storeTextsDump().contains('再来一句海边'),
      timeout: const Duration(seconds: 10),
      what: 'store 收到回合 B 用户消息',
      debugInfo: () => 'store=${storeTextsDump()} '
          'state=${ConnectionManager.instance.state} '
          'activeSession=${ZcodeChatStore.instance.activeSessionId} '
          'isStreaming=${ZcodeChatStore.instance.isStreaming} '
          'isWaiting=${ZcodeChatStore.instance.isWaitingForResponse}',
    );
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnBHead),
      timeout: const Duration(seconds: 15),
      what: '回合 B 开头流式增量',
      debugInfo: () => 'store=${storeTextsDump()}',
    );

    // 流式中途（第 4 片可见）掐断 app 的 relay 连接
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnBFourthPiece),
      timeout: const Duration(seconds: 10),
      what: '回合 B 第 4 片增量（断线触发点）',
    );
    await triggerRelayDrop(ctrlUrl);

    // 断线窗口：引擎继续流完并落库；app 自动重连（~2s 退避）后
    // 重订阅 + 权威刷新，UI 应收敛到完整真相
    await pumpUntil(
      tester,
      () => contentVisible(tester, kTurnBTailEnd),
      timeout: const Duration(seconds: 30),
      what: '回合 B 答案段（断线恢复收敛）',
    );
    await tester.pump(const Duration(seconds: 2)); // 给收敛后的权威刷新留余量

    // 断线恢复收敛：UI 可见部分（B 答案段 + 工具完成态计数）+ store 权威
    // 数据（恰两条 assistant、parts 完整、A 不丢）双通道断言
    expect(
      contentVisible(tester, kTurnBTail),
      isTrue,
      reason: '回合 B 答案段（断线窗口内引擎流完的部分）收敛后应可见',
    );
    expect(
      contentVisible(tester, kTurnBTail),
      isTrue,
      reason: '回合 B 答案段应可见',
    );
    expect(
      contentVisible(tester, kTurnAFoldCounts),
      isTrue,
      reason: '收敛后回合 A 的折叠头计数仍应可见',
    );
    final assistants = assistantMessages();
    expect(
      assistants.length,
      2,
      reason: '应恰有两条助手消息（断线收敛不得产生重复或丢失）',
    );
    final turnBParts = assistants[1].processParts;
    expect(
      turnBParts.map((p) => p.kind.name).join(','),
      'text,tool,text',
      reason: '回合 B 权威 part 序列应为 text→tool→text',
    );
    expect(turnBParts[0].text, kTurnBHead, reason: '回合 B 前半全文一致');
    expect(turnBParts[2].text, kTurnBTail, reason: '回合 B 后半全文一致');
    expect(
      contentVisible(tester, kTurnAUserMessage),
      isTrue,
      reason: '第一条用户消息仍在',
    );
    expect(
      contentVisible(tester, kTurnBUserMessage),
      isTrue,
      reason: '第二条用户消息仍在',
    );
    expect(
      contentVisible(tester, kPlaceholderText),
      isFalse,
      reason: '断线恢复后不得出现「$kPlaceholderText」类占位文案',
    );
  });
}
