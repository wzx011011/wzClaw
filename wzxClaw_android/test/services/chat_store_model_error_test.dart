// ============================================================
// 模型不可用终端错误的可见性回归
//
// 线上症状（2026-09-16 用户实测）：历史会话模型下线后发消息没有任何
// 可操作的反馈。契约：
// 1) errorKind=model-unavailable 的错误必须在会话内留下带种类的消息；
// 2) 被阻塞的原文要暂存到 lastModelBlockedContent 供「选择可用模型
//    重试」一键重发；
// 3) 普通错误不得被误标为 model-unavailable（卡片不该乱弹）。
// ============================================================

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/chat_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final store = ChatStore.instance;

  group('模型不可用错误卡片契约', () {
    test('model-unavailable 错误产生带 errorKind 的消息并暂存原文', () {
      store.debugHandleWsMessage(const WsMessage(
        event: WsEvents.agentError,
        data: {
          'sessionId': 'sess-a',
          'error': '发送失败：历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。',
          'errorKind': 'model-unavailable',
          'content': '继续上次的任务',
        },
      ),);

      final last = store.messages.last;
      expect(last.role, MessageRole.assistant);
      expect(last.errorKind, 'model-unavailable');
      expect(last.content, contains('模型已不可用'));
      expect(store.lastModelBlockedContent, '继续上次的任务');
    });

    test('普通错误不携带 errorKind，也不得写入阻塞原文', () {
      store.debugHandleWsMessage(const WsMessage(
        event: WsEvents.agentError,
        data: {'sessionId': 'sess-a', 'error': '发送失败: TimeoutException'},
      ),);

      final last = store.messages.last;
      expect(last.errorKind, isNull);
      // 上一条 model-unavailable 的暂存不被普通错误改写
      expect(store.lastModelBlockedContent, '继续上次的任务');
    });

    test('errorKind 随消息 copyWith 保留（流式收尾路径）', () {
      final base = ChatMessage(
        role: MessageRole.assistant,
        content: 'partial',
        createdAt: DateTime.now(),
      );
      final completed = base.copyWith(
        content: 'partial\n\n⚠ Error: boom',
        isStreaming: false,
        errorKind: 'model-unavailable',
      );
      expect(completed.errorKind, 'model-unavailable');
      expect(completed.content, contains('boom'));
    });
  });
}
