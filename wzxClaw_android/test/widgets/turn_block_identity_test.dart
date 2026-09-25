// ============================================================
// turn_block_identity_test — 回合块身份键稳定性回归
// （f-render-stream-consumption-1）
//
// 钉死的契约：流式占位的块身份键在「无 id 占位 → 采纳 protoId」与
// 「权威合并原位替换」前后恒定——键变化会让 TurnBlockView Element
// 连同子树销毁重建，用户已折叠的运行中回合自行弹开、思考行展开态
// 等局部状态重置。块身份 = 视图身份 viewId（创建即定、替换时继承）
// ?? protoId（历史消息无 viewId 回落）?? 创建毫秒。
// ============================================================

import 'package:flutter_test/flutter_test.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/pages/home_page.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';

void main() {
  test('占位创建即定 viewId：采纳 protoId 前后块键恒定', () {
    final state = ZcodeSessionState('sess-viewid');
    // 重连/快照路径：reconcileActiveTools → upsertStreamingTool（无 id）
    // 建出 protoId=null 的流式占位
    state.upsertStreamingTool(
      const ToolCallInfo(toolCallId: 'call-v1', toolName: 'Bash'),
      turnId: 't-viewid',
    );
    final item = state.items.single;
    expect(
      item.message.viewId,
      isNotNull,
      reason: '占位创建时必须生成客户端身份（viewId）',
    );

    final keyBefore = chatBlockBaseKey('turn', item.message);
    expect(keyBefore, contains(item.message.viewId!),
        reason: '无 protoId 的占位回落 viewId 键（不再用创建毫秒）');

    // 首个带 assistantMessageId 的增量到达：占位原位采纳 protoId
    state.appendTextDelta('采纳后的正文', assistantMessageId: 'msg-view');
    final keyAfter = chatBlockBaseKey('turn', state.items.single.message);

    // 修复点：采纳前后键恒定——键切换 = Element 重建 = 折叠状态丢失
    expect(
      keyAfter,
      keyBefore,
      reason: '块键从毫秒键切到 protoId 键会让已折叠的运行中回合自行弹开',
    );
    expect(keyAfter, contains(item.message.viewId!));
  });

  test('权威合并原位替换继承 viewId：同占位的权威行键不变', () {
    final state = ZcodeSessionState('sess-viewid2');
    state.appendTextDelta('流式中', turnId: 't-viewid');
    final keyBefore = chatBlockBaseKey('turn', state.items.single.message);

    // 权威批次按尾部消解替换占位（protoId 有值、无 viewId）
    state.mergeAuthoritative([
      ZcodeSessionItem(
        protoId: 'msg-authority',
        turnId: 't-viewid',
        synced: true,
        message: ChatMessage(
          role: MessageRole.assistant,
          createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
          processParts: const [ChatProcessPart.text('权威版')],
        ),
      ),
    ]);

    final keyAfter = chatBlockBaseKey('turn', state.items.single.message);
    expect(
      keyAfter,
      keyBefore,
      reason: '权威替换必须继承占位的视图身份，否则块重挂载',
    );
  });

  test('无 viewId 的权威消息回落 protoId 键（历史加载语义不变）', () {
    final authoritative = ChatMessage(
      role: MessageRole.assistant,
      createdAt: DateTime.fromMillisecondsSinceEpoch(1000),
      protoId: 'msg-history',
    );
    expect(
      chatBlockBaseKey('turn', authoritative),
      'turn:assistant:msg-history',
      reason: '历史消息键保持 protoId 稳定身份（契约不回退）',
    );
  });
}
